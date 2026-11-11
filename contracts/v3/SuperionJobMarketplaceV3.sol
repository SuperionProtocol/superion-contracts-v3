// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "../v2/ISuperToken.sol";
import {FrozenVrfDraw} from "../vrf/FrozenVrfDraw.sol";
import {MissionTerms} from "../terms/MissionTerms.sol";

interface IStakingV3 {
    function availableStake(address user) external view returns (uint256);
    function lockedStake(address user) external view returns (uint256);
    function balanceOf(address user) external view returns (uint256);
    function lock(address user, uint256 amount) external;
    function unlock(address user, uint256 amount) external;
    function slash(address user, uint256 amount) external;
    function depositRewards(uint256 amount) external;
}

/**
 * @title SuperionJobMarketplaceV3
 * @notice Verified-work escrow marketplace (V3). Changes vs V2.1 (see CHANGELOG_V3.md):
 *   1. committee = independent stake-weighted draws without replacement, parties excluded;
 *   2. randomness = single VRF2.5 request, snapshot fixed before request; no blockhash/retarget path;
 *      local prototype uses an explicitly labelled oracle mock, NOT a verified real VRF delivery;
 *   3. timely challenge/appeal filing does not require a full jury; Draw has a pause-aware deadline;
 *      missing jurors never cancel a funded dispute or pay a party automatically;
 *   4. dedicated ARBITER_ROLE: indefinite binary arbitration after failed Draw or Voting, no auto split;
 *      approved policy: arbitral appeal reversal never penalizes the former round-0 majority;
 *   5. equal per-vote fee to every revealing verifier, whatever the verdict; treasury share of fees (hard cap);
 *   6. bond / penalty / vote fee = bps of job value with min/max floors;
 *   7. revealed minority votes are not slashed; one appeal round (bigger committee, bigger bond)
 *      slashes the original majority if overturned by the appeal jury (not by Safe);
 *   8. job value capped relative to total registered verifier stake.
 */
contract SuperionJobMarketplaceV3 is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for ISuperToken;
    FrozenVrfDraw public immutable drawEngine;
    /// Rule history; each mission is bound to the version current at its creation.
    MissionTerms public immutable terms;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 1_000;            // fee <= 10 % of budget
    uint256 public constant MAX_TREASURY_SHARE_BPS = 5_000; // treasury <= 50 % of the fee (hard cap)
    uint256 public constant MAX_VERIFIERS = 200;
    uint256 public constant MAX_COMMITTEE = 15;
    uint256 public constant MAX_JOB_DURATION = 365 days;
    uint256 public constant MIN_BOND_FLOOR = 1 ether / 1000;
    uint256 public constant BLOCKHASH_WINDOW = 256; // Deprecated ABI constant; no active blockhash RNG.

    ISuperToken public immutable superToken;
    IStakingV3 public immutable staking;

    address public treasury;

    // Split appended at the end so V2 numeric values are unchanged.
    enum Status { None, Open, Assigned, Completed, Disputed, Finalized, Refunded, Cancelled, Split }
    enum Phase { None, Draw, Voting, Decided, Done, Arbitration }

    struct Job {
        address creator;
        address provider;
        uint16 feeBps;
        uint16 burnShareBps;
        Status status;
        uint64 deadline;
        uint64 challengeDeadline;
        uint64 disputeDeadline; // reveal deadline of the current round
        uint256 budget;
        uint256 lockedStake;
        string jobURI;
        string resultURI;
        uint16 treasuryShareBps;
        address treasury;   // frozen at createJob (address(0) => treasury share goes to stakers)
    }

    struct Dispute {
        address challenger;
        address appellant;
        uint8 round;         // 0 = first committee, 1 = appeal
        Phase phase;
        bool outcomeValid;   // round-0 majority result (when Decided)
        uint64 entropyBlock; // Deprecated compatibility metadata; NEVER used for randomness.
        uint64 appealDeadline;
        bytes32 salt;
        uint256 bond;
        uint256 appealBond;
        uint256 penalty;
        uint256 voteFee;
        uint16 slashVerifierBps;
        uint16 slashChallengerBps;
    }

    struct Round {
        uint8 votesValid;
        uint8 votesInvalid;
        uint64 commitDeadline;
        uint64 revealDeadline;
    }

    struct VerifierInfo {
        uint256 bond;
        uint32 duties;
        uint32 indexPlus1;
        // Sum of the maximum penalties of all open duties (jury seats). Invariant: reserved <= bond.
        uint256 reserved;
        // Selected (result public, not yet seated) jurors hold one more penalty, in drawEngine.frozenHold (see _held).
        // Mere candidates on an open list are only exit-locked (drawEngine.candidacy), with no capacity used.
    }

    uint256 public nextJobId = 1;
    mapping(uint256 => Job) public jobs;
    mapping(uint256 => Dispute) public disputes;
    mapping(uint256 => mapping(uint256 => Round)) public rounds;
    mapping(uint256 => mapping(uint256 => address[])) internal _committees;
    /// 0 = not a member, 1 = member no commit, 2 = committed, 3 = voted valid, 4 = voted invalid
    mapping(uint256 => mapping(address => uint8)) public memberVote;
    /// round + 1 the address sits in (0 = none). Round committees are disjoint.
    mapping(uint256 => mapping(address => uint8)) public memberRound;
    mapping(uint256 => mapping(address => bytes32)) public voteCommits;

    mapping(address => VerifierInfo) public verifiers;
    address[] public verifierList;
    uint256 public totalVerifierBond;

    // Challenge/appeal rights AND the current Draw attempt use this clock. Stored struct timestamps
    // remain Unix baselines; effectiveProtectedDeadline is the current UI value.
    // Unpaused: cumulative paused seconds. Paused: frozen active timestamp.
    // pause/unpause flip the representation using timestamp - anchor.
    uint256 private _clockAnchor;
    mapping(uint256 => uint256) private _protectedDeadline;

    event TreasuryUpdated(address indexed treasury);
    event JobCreated(uint256 indexed jobId, address indexed creator, uint256 budget, uint16 feeBps, string jobURI);
    event JobAssigned(uint256 indexed jobId, address indexed provider, uint256 lockedStake);
    event JobCompleted(uint256 indexed jobId, string resultURI, uint256 challengeDeadline);
    event JobChallenged(uint256 indexed jobId, address indexed challenger, uint256 bond, bytes32 seedCommit, uint256 entropyBlock);
    // Deprecated ABI event: never emitted by the VRF path.
    event EntropyRetargeted(uint256 indexed jobId, uint256 round, uint256 entropyBlock);
    event CommitteeSelected(uint256 indexed jobId, address[] committee, uint256 voteCommitDeadline, uint256 voteRevealDeadline);
    event ChallengeCancelled(uint256 indexed jobId, uint256 round, uint256 bondReturned);
    event DisputeDecided(uint256 indexed jobId, bool providerValid, uint256 appealDeadline);
    event Appealed(uint256 indexed jobId, address indexed appellant, uint256 appealBond, uint256 entropyBlock);
    event VoteCommitted(uint256 indexed jobId, address indexed verifier, bytes32 commitHash);
    event VoteCast(uint256 indexed jobId, address indexed verifier, bool providerValid);
    event VerifierFeePaid(uint256 indexed jobId, address indexed verifier, uint256 amount);
    event DisputeResolved(uint256 indexed jobId, bool providerValid, bool byArbiter);
    event ArbitrationRequested(uint256 indexed jobId, uint256 round);
    event JobSplit(uint256 indexed jobId, uint256 toProvider, uint256 toCreator);
    event JobFinalized(uint256 indexed jobId, address indexed provider, uint256 payout, uint256 fee, uint256 burned, uint256 toStakers);
    event TreasuryPaid(uint256 indexed jobId, address indexed treasury, uint256 amount);
    event JobRefunded(uint256 indexed jobId, address indexed creator, uint256 amount);
    event JobCancelled(uint256 indexed jobId);
    event ProviderSlashed(uint256 indexed jobId, address indexed provider, uint256 amount, uint256 burned);
    event VerifierPenalized(uint256 indexed jobId, address indexed verifier, uint256 amount);
    event VerifierRegistered(address indexed verifier, uint256 bond);
    event VerifierExited(address indexed verifier, uint256 bondReleased);
    event Burned(uint256 amount);

    error InvalidParams();
    error InvalidState();
    error NotAllowed();
    error NoMajority();
    error HasMajority();
    error TooEarly();
    error TooLate();
    error VerifierCapReached();
    error BadCommit();
    error NotEnoughVerifiers();
    error JobTooLarge();
    error StakeReserved();

    constructor(address _superToken, address _staking, address admin, address pauser, address arbiter, address _treasury, MissionTerms.Params memory p, FrozenVrfDraw.Config memory vrf) {
        drawEngine = new FrozenVrfDraw(vrf);
        terms = new MissionTerms(p);
        if (_superToken == address(0) || _staking == address(0) || admin == address(0)) revert InvalidParams();
        superToken = ISuperToken(_superToken);
        staking = IStakingV3(_staking);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (pauser != address(0)) _grantRole(PAUSER_ROLE, pauser);
        if (arbiter != address(0)) _grantRole(ARBITER_ROLE, arbiter);
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    // ------------------------------------------------------------------ governance
    // Rule changes: terms.setParams / terms.setFees, gated by THIS contract's DEFAULT_ADMIN_ROLE.
    function setTreasury(address t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        treasury = t;
        emit TreasuryUpdated(t);
    }


    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
        // The anchor never exceeds the monotonic block timestamp.
        unchecked { _clockAnchor = block.timestamp - _clockAnchor; }
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
        unchecked { _clockAnchor = block.timestamp - _clockAnchor; }
    }

    function _activeTimestamp() internal view returns (uint256) {
        // In either mode anchor <= block.timestamp, by construction.
        unchecked { return paused() ? _clockAnchor : block.timestamp - _clockAnchor; }
    }

    /// @notice Effective Unix deadline of the latest challenge/appeal/Draw window.
    ///         During a pause it moves with wall time; remaining active time freezes.
    ///         After a new appeal window starts, this getter describes that window.
    function effectiveProtectedDeadline(uint256 jobId) external view returns (uint256) {
        uint256 deadline = _protectedDeadline[jobId];
        return deadline == 0 ? 0 : deadline + (block.timestamp - _activeTimestamp());
    }

    // ------------------------------------------------------------------ views
    function verifierCount() external view returns (uint256) { return verifierList.length; }
    function committeeOf(uint256 jobId) external view returns (address[] memory) { return _committees[jobId][disputes[jobId].round]; }
    function committeeOfRound(uint256 jobId, uint256 round) external view returns (address[] memory) { return _committees[jobId][round]; }

    /// @notice Quote under CURRENT rules (new missions). Filed disputes use the mission's bound version.
    function disputeAmounts(uint256 budget) external view returns (uint256 bond, uint256 penalty, uint256 voteFee) {
        return terms.quote(budget);
    }

    function maxJobBudget() public view returns (uint256) {
        (, uint256 cap) = terms.registryRule();
        return (totalVerifierBond * cap) / BPS;
    }

    // ------------------------------------------------------------------ verifiers
    function registerVerifier() external { (uint256 minStake,) = terms.registryRule(); _register(minStake); }

    /// @notice Register with a bond above the minimum: committee draws are weighted by bond.
    function registerVerifierWithStake(uint256 amount) external { _register(amount); }

    function _register(uint256 bond) internal nonReentrant {
        VerifierInfo storage v = verifiers[msg.sender];
        if (v.indexPlus1 != 0 || v.bond != 0) revert InvalidState();
        (uint256 minStake,) = terms.registryRule();
        if (bond < minStake) revert InvalidParams();
        if (verifierList.length >= MAX_VERIFIERS) revert VerifierCapReached();
        v.bond = bond;
        verifierList.push(msg.sender);
        v.indexPlus1 = uint32(verifierList.length);
        totalVerifierBond += bond;
        staking.lock(msg.sender, bond); // effects before interaction (CEI)
        emit VerifierRegistered(msg.sender, bond);
    }

    /// Seat reservations + selected-juror holds (Ready VRF draws). Invariant target: _held(v) <= bond.
    function _held(address v) internal view returns (uint256) { return verifiers[v].reserved + drawEngine.frozenHold(v); }

    function exitVerifier() external nonReentrant {
        VerifierInfo storage v = verifiers[msg.sender];
        // A frozen candidate, a selected or a seated juror can neither leave the list nor recover its bond.
        if (_held(msg.sender) != 0 || drawEngine.candidacy(msg.sender) != 0) revert StakeReserved();
        if (v.indexPlus1 != 0) _removeFromList(msg.sender);
        uint256 released;
        if (v.duties == 0 && v.bond > 0) {
            released = v.bond;
            v.bond = 0;
            staking.unlock(msg.sender, released);
        }
        emit VerifierExited(msg.sender, released);
    }

    function _removeFromList(address who) internal {
        VerifierInfo storage v = verifiers[who];
        uint256 idx = v.indexPlus1 - 1;
        uint256 last = verifierList.length - 1;
        if (idx != last) {
            address moved = verifierList[last];
            verifierList[idx] = moved;
            verifiers[moved].indexPlus1 = uint32(idx + 1);
        }
        verifierList.pop();
        v.indexPlus1 = 0;
        totalVerifierBond -= v.bond;
    }

    // ------------------------------------------------------------------ jobs
    function createJob(uint256 budget, uint256 duration, string calldata jobURI)
        external nonReentrant whenNotPaused returns (uint256 jobId)
    {
        if (budget == 0 || duration == 0 || duration > MAX_JOB_DURATION || bytes(jobURI).length == 0) revert InvalidParams();
        if (budget > maxJobBudget()) revert JobTooLarge();
        superToken.safeTransferFrom(msg.sender, address(this), budget);
        jobId = nextJobId++;
        Job storage j = jobs[jobId];
        j.creator = msg.sender;
        j.budget = budget;
        (j.feeBps, j.burnShareBps, j.treasuryShareBps) = terms.bind(jobId);
        j.treasury = treasury; // frozen recipient: later setTreasury never redirects this mission
        j.deadline = uint64(block.timestamp + duration);
        j.status = Status.Open;
        j.jobURI = jobURI;
        emit JobCreated(jobId, msg.sender, budget, j.feeBps, jobURI);
    }

    function assignJob(uint256 jobId) external nonReentrant whenNotPaused {
        Job storage j = jobs[jobId];
        if (j.status != Status.Open || block.timestamp >= j.deadline) revert InvalidState();
        if (msg.sender == j.creator) revert NotAllowed();
        uint256 lockAmt = terms.providerLock(jobId, j.budget);
        j.provider = msg.sender;
        j.lockedStake = lockAmt;
        j.status = Status.Assigned;
        if (lockAmt > 0) staking.lock(msg.sender, lockAmt);
        emit JobAssigned(jobId, msg.sender, lockAmt);
    }

    function submitResult(uint256 jobId, string calldata resultURI) external {
        Job storage j = jobs[jobId];
        if (msg.sender != j.provider) revert NotAllowed();
        if (j.status != Status.Assigned || block.timestamp > j.deadline) revert InvalidState();
        if (bytes(resultURI).length == 0) revert InvalidParams();
        j.resultURI = resultURI;
        j.status = Status.Completed;
        (uint256 period,) = terms.windows(jobId);
        j.challengeDeadline = uint64(block.timestamp + period);
        _protectedDeadline[jobId] = _activeTimestamp() + period;
        emit JobCompleted(jobId, resultURI, j.challengeDeadline);
    }

    /// @notice Pays the worker only when the unchallenged, protected challenge period has ended.
    /// Allowed during a pause like finalizeDispute: the protected clock is frozen, so only a window that had
    /// already expired BEFORE the pause can be settled (N2 symmetry fix).
    function finalizeJob(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        if (j.status != Status.Completed) revert InvalidState();
        if (_activeTimestamp() <= _protectedDeadline[jobId]) revert TooEarly();
        _payProvider(jobId, j);
    }

    function cancelJob(uint256 jobId) external nonReentrant whenNotPaused {
        Job storage j = jobs[jobId];
        if (msg.sender != j.creator) revert NotAllowed();
        if (j.status != Status.Open) revert InvalidState();
        j.status = Status.Cancelled;
        uint256 amount = j.budget;
        j.budget = 0;
        superToken.safeTransfer(j.creator, amount);
        emit JobCancelled(jobId);
    }

    function reclaimExpired(uint256 jobId) external nonReentrant whenNotPaused {
        Job storage j = jobs[jobId];
        if (msg.sender != j.creator) revert NotAllowed();
        if (j.status != Status.Assigned || block.timestamp <= j.deadline) revert InvalidState();
        _unlockProvider(j);
        _refundCreator(jobId, j);
    }

    // ------------------------------------------------------------------ challenge & committee draw
    /// @param seedCommit any non-zero salt chosen by the challenger (kept for interface compatibility;
    ///        no reveal is needed any more). One challenge per job.
    function challengeJob(uint256 jobId, bytes32 seedCommit) external nonReentrant whenNotPaused {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Completed || d.challenger != address(0)) revert InvalidState();
        if (_activeTimestamp() > _protectedDeadline[jobId]) revert TooLate();
        if (msg.sender == j.provider) revert NotAllowed();
        if (seedCommit == bytes32(0)) revert BadCommit();
        // Filing rights must not depend on the current verifier population.
        // The existing protected Draw window / arbitration route handles shortages.

        (uint256 bond, uint256 penalty, uint256 voteFee, uint16 sv, uint16 sc) = terms.filing(jobId, j.budget);
        superToken.safeTransferFrom(msg.sender, address(this), bond);

        d.challenger = msg.sender;
        d.bond = bond;
        d.penalty = penalty;
        d.voteFee = voteFee;
        d.salt = seedCommit;
        d.slashVerifierBps = sv;
        d.slashChallengerBps = sc;
        d.entropyBlock = uint64(block.number);
        d.phase = Phase.Draw;
        j.status = Status.Disputed;
        emit JobChallenged(jobId, msg.sender, bond, seedCommit, block.number);
        _openDraw(jobId, d);
    }

    // The module freezes the population and all selection/voting inputs BEFORE requesting VRF.
    // Draw duration, jury size, vote windows and eligibility minimum come from the mission's bound rules.
    function _openDraw(uint256 jobId, Dispute storage d) internal {
        (uint256 w, uint8 k, uint32 cw, uint32 rw, uint256 minStake) = terms.drawRule(jobId, d.round);
        _protectedDeadline[jobId] = _activeTimestamp() + w;
        (address[] memory list, uint256[] memory weights, uint256 count,) = _eligible(jobId, d.challenger, d.round == 1, minStake, d.penalty);
        drawEngine.open(jobId,d.round,list,weights,count,k,cw,rw,d.penalty); // holds d.penalty on each candidate if the request is sent
    }

    /// @notice Callback liveness check; no permission, side effects or population loop.
    function drawRequestOpen(uint256 jobId, uint256 round) external view returns(bool) {
        Dispute storage d = disputes[jobId];
        return jobs[jobId].status == Status.Disputed && d.phase == Phase.Draw && d.round == round && _activeTimestamp() <= _protectedDeadline[jobId];
    }

    /// @notice Permissionless selection from the immutable snapshot and single VRF result.
    /// An unavailable chosen address NEVER causes substitution or a new randomness request.
    function drawCommittee(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId]; Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed || d.phase != Phase.Draw) revert InvalidState();
        if (_activeTimestamp() > _protectedDeadline[jobId]) revert TooLate();
        (FrozenVrfDraw.State state, uint256 count, uint256 size,,,) = drawEngine.status(jobId,d.round);
        if (count < size || state == FrozenVrfDraw.State.Failed) revert NotEnoughVerifiers();
        if (state != FrozenVrfDraw.State.Ready) revert TooEarly();
        (address[] memory selected,uint256[] memory coverage,uint32 cw,uint32 rw) = drawEngine.pick(jobId,d.round);
        address[] storage committee = _committees[jobId][d.round];
        for(uint256 i;i<selected.length;++i){
            address v=selected[i]; VerifierInfo storage info=verifiers[v];
            uint256 locked=staking.lockedStake(v);
            // THREE-LIMITS FIX (2): the seat's penalty was held atomically with the public result and every deserved slash
            // elsewhere is paid from THAT seat's own released reservation, so the drawn juror stays seatable even if slashed
            // (or dropped from the registry) meanwhile. Only a broken invariant / inconsistent staking can still refuse.
            // `coverage[i] == 0` is an unreachable defensive assertion (a zero-weight entry can never be drawn); keeping the
            // frozen weight read here measurably keeps the market ~1.1 KB smaller with runs=1 (see NOTES-TROIS-LIMITES-FR.md).
            if(info.bond < _held(v) + d.penalty || locked < info.bond || staking.balanceOf(v) < locked || coverage[i] == 0) revert NotEnoughVerifiers();
            committee.push(v); memberVote[jobId][v]=1; memberRound[jobId][v]=uint8(d.round+1); info.duties+=1; info.reserved+=d.penalty; // pick() released the frozen hold in this same tx
        }
        // Vote clocks run on the pause-aware ACTIVE clock (= Unix time if no pause ever happened): they freeze while
        // paused, so no juror is slashed for time spent in a pause (N4).
        Round storage rd=rounds[jobId][d.round];uint256 t0=_activeTimestamp();
        rd.commitDeadline=uint64(t0+cw);rd.revealDeadline=uint64(t0+cw+rw);
        j.disputeDeadline=rd.revealDeadline;d.phase=Phase.Voting;
        emit CommitteeSelected(jobId,selected,rd.commitDeadline,rd.revealDeadline);
    }

    function _eligible(uint256 jobId, address challenger, bool excludeRound0, uint256 minStake, uint256 need)
        internal view returns (address[] memory list, uint256[] memory w, uint256 count, uint256 total)
    {
        Job storage j = jobs[jobId];
        uint256 n = verifierList.length;
        list = new address[](n);
        w = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            address v = verifierList[i];
            if (v == j.creator || v == j.provider || v == challenger) continue;
            if (excludeRound0 && memberRound[jobId][v] != 0) continue;
            uint256 b = verifiers[v].bond;
            // Candidate must hold, UNRESERVED, this duty's max penalty; checked before the VRF request.
            if (b < minStake || b < _held(v) + need) continue; // also counts frozen holds; no underflow if a slash left bond < held
            list[count] = v;
            w[count] = b;
            total += b;
            ++count;
        }
    }

    // ------------------------------------------------------------------ votes (commit-reveal)
    /// @param commitHash keccak256(abi.encode(providerValid, salt, msg.sender, jobId))
    function commitVote(uint256 jobId, bytes32 commitHash) external {
        Dispute storage d = disputes[jobId];
        if (jobs[jobId].status != Status.Disputed || d.phase != Phase.Voting) revert InvalidState();
        if (_activeTimestamp() > rounds[jobId][d.round].commitDeadline) revert TooLate();
        if (memberRound[jobId][msg.sender] != d.round + 1 || memberVote[jobId][msg.sender] != 1) revert NotAllowed();
        if (commitHash == bytes32(0)) revert BadCommit();
        voteCommits[jobId][msg.sender] = commitHash;
        memberVote[jobId][msg.sender] = 2;
        emit VoteCommitted(jobId, msg.sender, commitHash);
    }

    function revealVote(uint256 jobId, bool providerValid, bytes32 salt) external {
        Dispute storage d = disputes[jobId];
        if (jobs[jobId].status != Status.Disputed || d.phase != Phase.Voting) revert InvalidState();
        Round storage rd = rounds[jobId][d.round];
        uint256 t = _activeTimestamp();
        if (t <= rd.commitDeadline) revert TooEarly();
        if (t > rd.revealDeadline) revert TooLate();
        if (memberRound[jobId][msg.sender] != d.round + 1 || memberVote[jobId][msg.sender] != 2) revert NotAllowed();
        if (keccak256(abi.encode(providerValid, salt, msg.sender, jobId)) != voteCommits[jobId][msg.sender]) revert BadCommit();
        if (providerValid) {
            memberVote[jobId][msg.sender] = 3;
            rd.votesValid += 1;
        } else {
            memberVote[jobId][msg.sender] = 4;
            rd.votesInvalid += 1;
        }
        emit VoteCast(jobId, msg.sender, providerValid);
    }

    /// @notice Majority of the current round's committee.
    function majorityOf(uint256 jobId) public view returns (bool decided, bool providerValid) {
        uint256 round = disputes[jobId].round;
        uint256 k = _committees[jobId][round].length;
        if (k == 0) return (false, false);
        uint256 majority = k / 2 + 1;
        Round storage rd = rounds[jobId][round];
        if (rd.votesValid >= majority) return (true, true);
        if (rd.votesInvalid >= majority) return (true, false);
        return (false, false);
    }

    // ------------------------------------------------------------------ resolution & appeal
    /// @notice Round 0 majority -> Decided (appeal window opens). Appeal majority -> final settlement.
    function resolveDispute(uint256 jobId) external nonReentrant whenNotPaused {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed || d.phase != Phase.Voting) revert InvalidState();
        Round storage rd = rounds[jobId][d.round];
        bool allRevealed = uint256(rd.votesValid) + rd.votesInvalid == _committees[jobId][d.round].length;
        if (!allRevealed && _activeTimestamp() <= rd.revealDeadline) revert TooEarly();
        (bool decided, bool providerValid) = majorityOf(jobId);
        if (!decided) revert NoMajority();
        if (d.round == 0) {
            d.outcomeValid = providerValid;
            d.phase = Phase.Decided;
            (, uint256 window) = terms.windows(jobId);
            d.appealDeadline = uint64(block.timestamp + window);
            _protectedDeadline[jobId] = _activeTimestamp() + window;
            emit DisputeDecided(jobId, providerValid, d.appealDeadline);
        } else {
            _settle(jobId, j, d, providerValid, false);
        }
    }

    /// @notice The losing side of round 0 may appeal once, with a bigger bond, to a bigger, disjoint committee.
    function appeal(uint256 jobId) external nonReentrant whenNotPaused {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed || d.phase != Phase.Decided || d.round != 0 || d.appellant != address(0)) revert InvalidState();
        if (_activeTimestamp() > _protectedDeadline[jobId]) revert TooLate();
        bool allowed = d.outcomeValid ? (msg.sender == j.creator || msg.sender == d.challenger) : msg.sender == j.provider;
        if (!allowed) revert NotAllowed();
        // An appeal may be filed even without enough fresh, disjoint jurors.
        // Appeal bond arithmetic unchanged; inputs are the mission's bound rules.
        uint256 ab = terms.appealBond(jobId, d.bond, d.voteFee);
        superToken.safeTransferFrom(msg.sender, address(this), ab);
        d.appellant = msg.sender;
        d.appealBond = ab;
        d.round = 1;
        d.phase = Phase.Draw;
        d.entropyBlock = uint64(block.number);
        emit Appealed(jobId, msg.sender, ab, block.number);
        _openDraw(jobId, d);
    }

    /// @notice No appeal before the deadline: settle with the round-0 majority.
    /// Allowed during a pause (finishing an already-open dispute and paying). The protected clock is frozen while
    /// paused, so this only succeeds if the appeal window had already expired before the pause.
    function finalizeDispute(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed || d.phase != Phase.Decided) revert InvalidState();
        if (_activeTimestamp() <= _protectedDeadline[jobId]) revert TooEarly();
        _settle(jobId, j, d, d.outcomeValid, false);
    }

    /// @notice The authorized arbiter decides after failed Draw or expired no-majority Voting.
    ///         There is no upper time limit, no timeout payout, and no automatic split.
    ///         Production must grant the role to a configured Safe, NOT separately to its owners.
    /// Blocked while paused (emergency freeze): funds stay in escrow until unpause.
    function arbitrate(uint256 jobId, bool providerValid) external nonReentrant whenNotPaused onlyRole(ARBITER_ROLE) {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed) revert InvalidState();
        if (d.phase != Phase.Arbitration) _requestArbitration(jobId, d);
        _settle(jobId, j, d, providerValid, true);
    }

    /// @notice Permissionless escalation ONLY; this function never pays, refunds, burns or unlocks.
    ///         A live jury majority is never replaced by escalation.
    function resolveStale(uint256 jobId) external nonReentrant {
        Dispute storage d = disputes[jobId];
        if (jobs[jobId].status != Status.Disputed) revert InvalidState();
        _requestArbitration(jobId, d);
    }

    function _requestArbitration(uint256 jobId, Dispute storage d) internal {
        if (d.phase == Phase.Draw) {
            if (_activeTimestamp() <= _protectedDeadline[jobId]) revert TooEarly();
        } else {
            if (d.phase != Phase.Voting) revert InvalidState();
            if (_activeTimestamp() <= rounds[jobId][d.round].revealDeadline) revert TooEarly();
            (bool decided,) = majorityOf(jobId);
            if (decided) revert HasMajority();
        }
        d.phase = Phase.Arbitration;
        drawEngine.close(jobId,d.round);
        emit ArbitrationRequested(jobId, d.round);
    }

    // ------------------------------------------------------------------ settlement internals
    /// Pays the equal vote fee to every revealer of `round` out of `pot`; penalizes non-revealers.
    function _processRound(uint256 jobId, uint256 round, uint256 pot, uint256 fee, uint256 penalty)
        internal returns (uint256 potLeft, uint256 toBurn)
    {
        address[] storage committee = _committees[jobId][round];
        potLeft = pot;
        for (uint256 i = 0; i < committee.length; ++i) {
            address v = committee[i];
            verifiers[v].duties -= 1;
            verifiers[v].reserved -= penalty; // duty closed: release before any penalty (max one per duty)
            uint8 mv = memberVote[jobId][v];
            if (mv >= 3) {
                uint256 pay = fee < potLeft ? fee : potLeft;
                if (pay > 0) {
                    potLeft -= pay;
                    superToken.safeTransfer(v, pay);
                    emit VerifierFeePaid(jobId, v, pay);
                }
            } else {
                toBurn += _penalize(jobId, v, penalty);
            }
        }
    }

    function _countVotes(uint256 jobId, uint256 round, uint8 vote) internal view returns (uint256 n) {
        address[] storage committee = _committees[jobId][round];
        for (uint256 i = 0; i < committee.length; ++i) if (memberVote[jobId][committee[i]] == vote) ++n;
    }

    function _payWinners(uint256 jobId, uint256 round, uint8 vote, uint256 pool, uint256 winners) internal returns (uint256 dust) {
        if (pool == 0) return 0;
        address[] storage committee = _committees[jobId][round];
        uint256 share = pool / winners;
        for (uint256 i = 0; i < committee.length; ++i) {
            address v = committee[i];
            if (memberVote[jobId][v] == vote) superToken.safeTransfer(v, share);
        }
        return pool - share * winners;
    }

    function _settle(uint256 jobId, Job storage j, Dispute storage d, bool providerValid, bool byArbiter) internal {
        d.phase = Phase.Done;
        drawEngine.close(jobId,d.round);
        uint256 dr = d.round; // deciding round
        uint8 win = providerValid ? 3 : 4;
        uint256 toBurn;
        uint256 burnPart;

        uint256 bondLeft;
        (bondLeft, burnPart) = _processRound(jobId, 0, d.bond, d.voteFee, d.penalty);
        toBurn += burnPart;
        uint256 feesFromBond = d.bond - bondLeft;
        d.bond = 0;

        uint256 appealLeft;
        if (dr == 1) {
            (appealLeft, burnPart) = _processRound(jobId, 1, d.appealBond, d.voteFee, d.penalty);
            toBurn += burnPart;
            d.appealBond = 0;
            if (providerValid != d.outcomeValid) {
                // Approved policy: only an actual appeal-jury reversal penalizes the
                // former majority. An arbitral reversal exempts those votes, NOT
                // non-revealers, whose existing penalties were processed above.
                if (!byArbiter) {
                    uint8 wrong = d.outcomeValid ? 3 : 4;
                    address[] storage c0 = _committees[jobId][0];
                    for (uint256 i = 0; i < c0.length; ++i) {
                        if (memberVote[jobId][c0[i]] == wrong) toBurn += _penalize(jobId, c0[i], d.penalty);
                    }
                }
                if (appealLeft > 0) superToken.safeTransfer(d.appellant, appealLeft);
                appealLeft = 0;
            }
        }

        uint256 winners = _countVotes(jobId, dr, win);
        // upheld appeal: appeal bond remainder rewards the appeal majority (burned if none)
        if (appealLeft > 0) {
            if (winners > 0) toBurn += _payWinners(jobId, 1, win, appealLeft, winners);
            else toBurn += appealLeft;
        }

        if (providerValid) {
            // challenger lost: bond remainder = coherence reward for the deciding majority
            if (winners > 0) toBurn += _payWinners(jobId, dr, win, bondLeft, winners);
            else if (bondLeft > 0) superToken.safeTransfer(j.provider, bondLeft);
            emit DisputeResolved(jobId, true, byArbiter);
            _payProvider(jobId, j);
        } else {
            uint256 toChallenger = bondLeft;
            uint256 slashAmt = j.lockedStake;
            j.lockedStake = 0;
            if (slashAmt > 0) {
                staking.slash(j.provider, slashAmt);
                uint256 reimb = feesFromBond < slashAmt ? feesFromBond : slashAmt; // provider pays the vote fees
                uint256 rest = slashAmt - reimb;
                uint256 cShare = (rest * d.slashChallengerBps) / BPS;
                uint256 vShare = winners > 0 ? (rest * d.slashVerifierBps) / BPS : 0;
                uint256 burnedSlash = rest - cShare - vShare;
                toChallenger += reimb + cShare;
                if (vShare > 0) burnedSlash += _payWinners(jobId, dr, win, vShare, winners);
                toBurn += burnedSlash;
                emit ProviderSlashed(jobId, j.provider, slashAmt, burnedSlash);
            }
            if (toChallenger > 0) superToken.safeTransfer(d.challenger, toChallenger);
            emit DisputeResolved(jobId, false, byArbiter);
            _refundCreator(jobId, j);
        }
        _burn(toBurn);
    }

    function _penalize(uint256 jobId, address v, uint256 penalty) internal returns (uint256 p) {
        VerifierInfo storage info = verifiers[v];
        p = penalty;
        if (p > info.bond) p = info.bond;
        if (p == 0) return 0;
        info.bond -= p;
        if (info.indexPlus1 != 0) totalVerifierBond -= p;
        staking.slash(v, p);
        emit VerifierPenalized(jobId, v, p);
        // Registry membership rule stays GLOBAL/current (not a mission term).
        if (info.indexPlus1 != 0) { (uint256 minStake,) = terms.registryRule(); if (info.bond < minStake) _removeFromList(v); }
    }

    function _payProvider(uint256 jobId, Job storage j) internal {
        uint256 budget = j.budget;
        j.budget = 0;
        j.status = Status.Finalized;
        _unlockProvider(j);

        uint256 fee = (budget * j.feeBps) / BPS;
        uint256 burned = (fee * j.burnShareBps) / BPS;
        address t = j.treasury;
        uint256 toTreasury = t == address(0) ? 0 : (fee * j.treasuryShareBps) / BPS;
        uint256 toStakers = fee - burned - toTreasury;
        uint256 payout = budget - fee;

        superToken.safeTransfer(j.provider, payout);
        _burn(burned);
        if (toTreasury > 0) {
            superToken.safeTransfer(t, toTreasury);
            emit TreasuryPaid(jobId, t, toTreasury);
        }
        if (toStakers > 0) {
            superToken.forceApprove(address(staking), toStakers);
            staking.depositRewards(toStakers);
        }
        emit JobFinalized(jobId, j.provider, payout, fee, burned, toStakers);
    }

    function _unlockProvider(Job storage j) internal {
        uint256 amt = j.lockedStake;
        if (amt > 0) {
            j.lockedStake = 0;
            staking.unlock(j.provider, amt);
        }
    }

    function _refundCreator(uint256 jobId, Job storage j) internal {
        uint256 amount = j.budget;
        j.budget = 0;
        j.status = Status.Refunded;
        superToken.safeTransfer(j.creator, amount);
        emit JobRefunded(jobId, j.creator, amount);
    }

    function _burn(uint256 amount) internal {
        if (amount > 0) {
            superToken.burn(amount);
            emit Burned(amount);
        }
    }
}

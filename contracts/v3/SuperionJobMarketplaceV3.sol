// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "../v2/ISuperToken.sol";

interface IStakingV3 {
    function availableStake(address user) external view returns (uint256);
    function lock(address user, uint256 amount) external;
    function unlock(address user, uint256 amount) external;
    function slash(address user, uint256 amount) external;
    function depositRewards(uint256 amount) external;
}

/**
 * @title SuperionJobMarketplaceV3
 * @notice Verified-work escrow marketplace (V3). Changes vs V2.1 (see CHANGELOG_V3.md):
 *   1. committee = independent stake-weighted draws without replacement, parties excluded;
 *   2. randomness = future blockhash (block after the challenge) + challenger salt + jobId + round;
 *      nobody can re-roll (one challenge per job, no seed withholding / expire-and-rechallenge path);
 *      NOTE: no Chainlink VRF; residual trust in the Base sequencer for blockhash;
 *   3. a challenge cannot open without >= committeeSize eligible verifiers; if the committee cannot
 *      be formed at draw time the challenge is cancelled (bond returned) and the worker can be paid;
 *   4. dedicated ARBITER_ROLE (governance-managed) + long arbitration window; no-majority fallback = 50/50 split;
 *   5. equal per-vote fee to every revealing verifier, whatever the verdict; treasury share of fees (hard cap);
 *   6. bond / penalty / vote fee = bps of job value with min/max floors;
 *   7. revealed minority votes are not slashed; one appeal round (bigger committee, bigger bond)
 *      slashes the original majority if overturned;
 *   8. job value capped relative to total registered verifier stake.
 */
contract SuperionJobMarketplaceV3 is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for ISuperToken;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 1_000;            // fee <= 10 % of budget
    uint256 public constant MAX_TREASURY_SHARE_BPS = 5_000; // treasury <= 50 % of the fee (hard cap)
    uint256 public constant MAX_VERIFIERS = 200;
    uint256 public constant MAX_COMMITTEE = 15;
    uint256 public constant MAX_JOB_DURATION = 365 days;
    uint256 public constant MIN_BOND_FLOOR = 1 ether / 1000;
    uint256 public constant BLOCKHASH_WINDOW = 256;

    ISuperToken public immutable superToken;
    IStakingV3 public immutable staking;

    struct Params {
        uint16 feeBps;
        uint16 burnShareBps;       // share of fee burned
        uint16 treasuryShareBps;   // share of fee to treasury (<= MAX_TREASURY_SHARE_BPS)
        uint32 challengePeriod;
        uint32 voteCommitWindow;
        uint32 voteRevealWindow;
        uint32 appealWindow;
        uint32 arbitrationWindow;
        uint8 committeeSize;       // odd, >= 3
        uint8 appealCommitteeSize; // odd, > committeeSize
        uint16 providerStakeBps;
        uint16 slashVerifierBps;   // share of provider slash to the deciding majority (coherence reward)
        uint16 slashChallengerBps; // share of provider slash to the challenger
        uint16 bondBps;            // challenge bond = bondBps of budget, clamped [minBond, maxBond]
        uint16 penaltyBps;         // non-reveal / overturned-majority penalty, clamped [minPenalty, maxPenalty]
        uint16 voteFeeBps;         // per-vote fee, clamped [minVoteFee, maxVoteFee]
        uint16 appealBondMultBps;  // appeal bond = bond * mult / BPS (>= BPS)
        uint16 maxJobStakeBps;     // budget <= totalVerifierBond * maxJobStakeBps / BPS
        uint256 minVerifierStake;
        uint256 minBond;
        uint256 maxBond;
        uint256 minPenalty;
        uint256 maxPenalty;
        uint256 minVoteFee;
        uint256 maxVoteFee;
    }
    Params public params;
    address public treasury;

    // Split appended at the end so V2 numeric values are unchanged.
    enum Status { None, Open, Assigned, Completed, Disputed, Finalized, Refunded, Cancelled, Split }
    enum Phase { None, Draw, Voting, Decided, Done }

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
    }

    struct Dispute {
        address challenger;
        address appellant;
        uint8 round;         // 0 = first committee, 1 = appeal
        Phase phase;
        bool outcomeValid;   // round-0 majority result (when Decided)
        uint64 entropyBlock; // committee entropy = blockhash(entropyBlock + 1)
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

    event ParamsUpdated(Params p);
    event TreasuryUpdated(address indexed treasury);
    event JobCreated(uint256 indexed jobId, address indexed creator, uint256 budget, uint16 feeBps, string jobURI);
    event JobAssigned(uint256 indexed jobId, address indexed provider, uint256 lockedStake);
    event JobCompleted(uint256 indexed jobId, string resultURI, uint256 challengeDeadline);
    event JobChallenged(uint256 indexed jobId, address indexed challenger, uint256 bond, bytes32 seedCommit, uint256 entropyBlock);
    event EntropyRetargeted(uint256 indexed jobId, uint256 round, uint256 entropyBlock);
    event CommitteeSelected(uint256 indexed jobId, address[] committee, uint256 voteCommitDeadline, uint256 voteRevealDeadline);
    event ChallengeCancelled(uint256 indexed jobId, uint256 round, uint256 bondReturned);
    event DisputeDecided(uint256 indexed jobId, bool providerValid, uint256 appealDeadline);
    event Appealed(uint256 indexed jobId, address indexed appellant, uint256 appealBond, uint256 entropyBlock);
    event VoteCommitted(uint256 indexed jobId, address indexed verifier, bytes32 commitHash);
    event VoteCast(uint256 indexed jobId, address indexed verifier, bool providerValid);
    event VerifierFeePaid(uint256 indexed jobId, address indexed verifier, uint256 amount);
    event DisputeResolved(uint256 indexed jobId, bool providerValid, bool byArbiter);
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

    constructor(address _superToken, address _staking, address admin, address pauser, address arbiter, address _treasury, Params memory p) {
        if (_superToken == address(0) || _staking == address(0) || admin == address(0)) revert InvalidParams();
        superToken = ISuperToken(_superToken);
        staking = IStakingV3(_staking);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (pauser != address(0)) _grantRole(PAUSER_ROLE, pauser);
        if (arbiter != address(0)) _grantRole(ARBITER_ROLE, arbiter);
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
        _setParams(p);
    }

    // ------------------------------------------------------------------ governance
    function setParams(Params calldata p) external onlyRole(DEFAULT_ADMIN_ROLE) { _setParams(p); }

    function setFees(uint16 feeBps, uint16 burnShareBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Params memory p = params;
        p.feeBps = feeBps;
        p.burnShareBps = burnShareBps;
        _setParams(p);
    }

    function setTreasury(address t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        treasury = t;
        emit TreasuryUpdated(t);
    }

    function _setParams(Params memory p) internal {
        if (
            p.feeBps > MAX_FEE_BPS || p.treasuryShareBps > MAX_TREASURY_SHARE_BPS
                || uint256(p.burnShareBps) + p.treasuryShareBps > BPS
                || p.challengePeriod < 1 minutes || p.challengePeriod > 30 days
                || p.voteCommitWindow < 1 minutes || p.voteCommitWindow > 14 days
                || p.voteRevealWindow < 1 minutes || p.voteRevealWindow > 14 days
                || p.appealWindow < 1 minutes || p.appealWindow > 14 days
                || p.arbitrationWindow < 1 hours || p.arbitrationWindow > 60 days
                || p.committeeSize < 3 || p.committeeSize % 2 == 0
                || p.appealCommitteeSize <= p.committeeSize || p.appealCommitteeSize > MAX_COMMITTEE
                || p.appealCommitteeSize % 2 == 0
                || p.providerStakeBps > 5 * BPS
                || uint256(p.slashVerifierBps) + p.slashChallengerBps > BPS
                || p.bondBps > BPS || p.penaltyBps > BPS || p.voteFeeBps > BPS
                || p.appealBondMultBps < BPS || p.maxJobStakeBps == 0
                || p.minVerifierStake == 0
                || p.minBond < MIN_BOND_FLOOR || p.maxBond < p.minBond
                || p.minPenalty > p.maxPenalty || p.maxPenalty > p.minVerifierStake
                || p.minVoteFee > p.maxVoteFee
        ) revert InvalidParams();
        params = p;
        emit ParamsUpdated(p);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // ------------------------------------------------------------------ views
    function verifierCount() external view returns (uint256) { return verifierList.length; }
    function committeeOf(uint256 jobId) external view returns (address[] memory) { return _committees[jobId][disputes[jobId].round]; }
    function committeeOfRound(uint256 jobId, uint256 round) external view returns (address[] memory) { return _committees[jobId][round]; }

    function _clamp(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return x < lo ? lo : (x > hi ? hi : x);
    }

    /// @notice Bond, non-reveal penalty and per-vote fee for a job of value `budget` under current params.
    function disputeAmounts(uint256 budget) public view returns (uint256 bond, uint256 penalty, uint256 voteFee) {
        Params memory p = params;
        voteFee = _clamp((budget * p.voteFeeBps) / BPS, p.minVoteFee, p.maxVoteFee);
        penalty = _clamp((budget * p.penaltyBps) / BPS, p.minPenalty, p.maxPenalty);
        bond = _clamp((budget * p.bondBps) / BPS, p.minBond, p.maxBond);
        uint256 feeCover = voteFee * p.committeeSize;
        if (bond < feeCover) bond = feeCover; // bond always covers the committee's vote fees
    }

    function maxJobBudget() public view returns (uint256) {
        return (totalVerifierBond * params.maxJobStakeBps) / BPS;
    }

    // ------------------------------------------------------------------ verifiers
    function registerVerifier() external { _register(params.minVerifierStake); }

    /// @notice Register with a bond above the minimum: committee draws are weighted by bond.
    function registerVerifierWithStake(uint256 amount) external { _register(amount); }

    function _register(uint256 bond) internal nonReentrant {
        VerifierInfo storage v = verifiers[msg.sender];
        if (v.indexPlus1 != 0 || v.bond != 0) revert InvalidState();
        if (bond < params.minVerifierStake) revert InvalidParams();
        if (verifierList.length >= MAX_VERIFIERS) revert VerifierCapReached();
        v.bond = bond;
        verifierList.push(msg.sender);
        v.indexPlus1 = uint32(verifierList.length);
        totalVerifierBond += bond;
        staking.lock(msg.sender, bond); // effects before interaction (CEI)
        emit VerifierRegistered(msg.sender, bond);
    }

    function exitVerifier() external nonReentrant {
        VerifierInfo storage v = verifiers[msg.sender];
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
        j.feeBps = params.feeBps;
        j.burnShareBps = params.burnShareBps;
        j.treasuryShareBps = params.treasuryShareBps;
        j.deadline = uint64(block.timestamp + duration);
        j.status = Status.Open;
        j.jobURI = jobURI;
        emit JobCreated(jobId, msg.sender, budget, j.feeBps, jobURI);
    }

    function assignJob(uint256 jobId) external nonReentrant whenNotPaused {
        Job storage j = jobs[jobId];
        if (j.status != Status.Open || block.timestamp >= j.deadline) revert InvalidState();
        if (msg.sender == j.creator) revert NotAllowed();
        uint256 lockAmt = (j.budget * params.providerStakeBps) / BPS;
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
        j.challengeDeadline = uint64(block.timestamp + params.challengePeriod);
        emit JobCompleted(jobId, resultURI, j.challengeDeadline);
    }

    /// @notice Pays the worker once the challenge period is over, or once a challenge was cancelled.
    function finalizeJob(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        if (j.status != Status.Completed) revert InvalidState();
        if (block.timestamp <= j.challengeDeadline && disputes[jobId].challenger == address(0)) revert TooEarly();
        _payProvider(jobId, j);
    }

    function cancelJob(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        if (msg.sender != j.creator) revert NotAllowed();
        if (j.status != Status.Open) revert InvalidState();
        j.status = Status.Cancelled;
        uint256 amount = j.budget;
        j.budget = 0;
        superToken.safeTransfer(j.creator, amount);
        emit JobCancelled(jobId);
    }

    function reclaimExpired(uint256 jobId) external nonReentrant {
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
        if (block.timestamp > j.challengeDeadline) revert TooLate();
        if (msg.sender == j.provider) revert NotAllowed();
        if (seedCommit == bytes32(0)) revert BadCommit();
        (, , uint256 count, ) = _eligible(jobId, msg.sender, false);
        if (count < params.committeeSize) revert NotEnoughVerifiers();

        (uint256 bond, uint256 penalty, uint256 voteFee) = disputeAmounts(j.budget);
        superToken.safeTransferFrom(msg.sender, address(this), bond);

        d.challenger = msg.sender;
        d.bond = bond;
        d.penalty = penalty;
        d.voteFee = voteFee;
        d.salt = seedCommit;
        d.slashVerifierBps = params.slashVerifierBps;
        d.slashChallengerBps = params.slashChallengerBps;
        d.entropyBlock = uint64(block.number);
        d.phase = Phase.Draw;
        j.status = Status.Disputed;
        emit JobChallenged(jobId, msg.sender, bond, seedCommit, block.number);
    }

    /// @notice Permissionless. Draws the committee of the current round from blockhash(entropyBlock + 1),
    ///         which nobody knew when the challenge / appeal was locked. If that blockhash has expired
    ///         (> 256 blocks), the target is moved to a new future block (fresh, still unpredictable).
    function drawCommittee(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed || d.phase != Phase.Draw) revert InvalidState();
        uint256 target = uint256(d.entropyBlock) + 1;
        if (block.number <= target) revert TooEarly();
        if (block.number - target > BLOCKHASH_WINDOW) {
            d.entropyBlock = uint64(block.number);
            emit EntropyRetargeted(jobId, d.round, block.number);
            return;
        }
        uint256 round = d.round;
        uint256 k = round == 0 ? params.committeeSize : params.appealCommitteeSize;
        (address[] memory list, uint256[] memory w, uint256 count, uint256 total) = _eligible(jobId, d.challenger, round == 1);
        if (count < k) {
            _cancelRound(jobId, j, d);
            return;
        }
        uint256 rand = uint256(keccak256(abi.encode(blockhash(target), d.salt, jobId, round)));
        address[] storage committee = _committees[jobId][round];
        for (uint256 t = 0; t < k; ++t) {
            uint256 r = uint256(keccak256(abi.encode(rand, t))) % total;
            uint256 idx;
            for (idx = 0; idx < count; ++idx) {
                if (r < w[idx]) break;
                r -= w[idx];
            }
            address v = list[idx];
            total -= w[idx];
            w[idx] = 0;
            committee.push(v);
            memberVote[jobId][v] = 1;
            memberRound[jobId][v] = uint8(round + 1);
            verifiers[v].duties += 1;
        }
        Round storage rd = rounds[jobId][round];
        rd.commitDeadline = uint64(block.timestamp + params.voteCommitWindow);
        rd.revealDeadline = uint64(block.timestamp + params.voteCommitWindow + params.voteRevealWindow);
        j.disputeDeadline = rd.revealDeadline;
        d.phase = Phase.Voting;
        emit CommitteeSelected(jobId, committee, rd.commitDeadline, rd.revealDeadline);
    }

    /// Committee could not be formed at draw time (verifiers left after the challenge/appeal opened).
    /// Round 0: challenge cancelled, bond returned in full, job back to Completed (finalizable -> worker paid).
    /// Round 1: appeal cancelled, appeal bond returned, round-0 decision stands (finalizable now).
    function _cancelRound(uint256 jobId, Job storage j, Dispute storage d) internal {
        uint256 refund;
        if (d.round == 0) {
            refund = d.bond;
            d.bond = 0;
            d.phase = Phase.Done;
            j.status = Status.Completed;
            if (refund > 0) superToken.safeTransfer(d.challenger, refund);
        } else {
            refund = d.appealBond;
            d.appealBond = 0;
            d.round = 0;
            d.phase = Phase.Decided;
            d.appealDeadline = uint64(block.timestamp);
            if (refund > 0) superToken.safeTransfer(d.appellant, refund);
        }
        emit ChallengeCancelled(jobId, d.round, refund);
    }

    function _eligible(uint256 jobId, address challenger, bool excludeRound0)
        internal view returns (address[] memory list, uint256[] memory w, uint256 count, uint256 total)
    {
        Job storage j = jobs[jobId];
        uint256 n = verifierList.length;
        uint256 minStake = params.minVerifierStake;
        list = new address[](n);
        w = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            address v = verifierList[i];
            if (v == j.creator || v == j.provider || v == challenger) continue;
            if (excludeRound0 && memberRound[jobId][v] != 0) continue;
            uint256 b = verifiers[v].bond;
            if (b < minStake) continue;
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
        if (block.timestamp > rounds[jobId][d.round].commitDeadline) revert TooLate();
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
        if (block.timestamp <= rd.commitDeadline) revert TooEarly();
        if (block.timestamp > rd.revealDeadline) revert TooLate();
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
    function resolveDispute(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed || d.phase != Phase.Voting) revert InvalidState();
        Round storage rd = rounds[jobId][d.round];
        bool allRevealed = uint256(rd.votesValid) + rd.votesInvalid == _committees[jobId][d.round].length;
        if (!allRevealed && block.timestamp <= rd.revealDeadline) revert TooEarly();
        (bool decided, bool providerValid) = majorityOf(jobId);
        if (!decided) revert NoMajority();
        if (d.round == 0) {
            d.outcomeValid = providerValid;
            d.phase = Phase.Decided;
            d.appealDeadline = uint64(block.timestamp + params.appealWindow);
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
        if (block.timestamp > d.appealDeadline) revert TooLate();
        bool allowed = d.outcomeValid ? (msg.sender == j.creator || msg.sender == d.challenger) : msg.sender == j.provider;
        if (!allowed) revert NotAllowed();
        Params memory p = params;
        (, , uint256 count, ) = _eligible(jobId, d.challenger, true);
        if (count < p.appealCommitteeSize) revert NotEnoughVerifiers();
        uint256 ab = (d.bond * p.appealBondMultBps) / BPS;
        uint256 feeCover = d.voteFee * p.appealCommitteeSize;
        if (ab < feeCover) ab = feeCover;
        superToken.safeTransferFrom(msg.sender, address(this), ab);
        d.appellant = msg.sender;
        d.appealBond = ab;
        d.round = 1;
        d.phase = Phase.Draw;
        d.entropyBlock = uint64(block.number);
        emit Appealed(jobId, msg.sender, ab, block.number);
    }

    /// @notice No appeal before the deadline: settle with the round-0 majority.
    function finalizeDispute(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed || d.phase != Phase.Decided) revert InvalidState();
        if (block.timestamp <= d.appealDeadline) revert TooEarly();
        _settle(jobId, j, d, d.outcomeValid, false);
    }

    /// @notice Dedicated arbiter (governance-managed role) decides a round without majority, within the window.
    function arbitrate(uint256 jobId, bool providerValid) external nonReentrant onlyRole(ARBITER_ROLE) {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed || d.phase != Phase.Voting) revert InvalidState();
        uint256 rdl = rounds[jobId][d.round].revealDeadline;
        if (block.timestamp <= rdl) revert TooEarly();
        if (block.timestamp > rdl + params.arbitrationWindow) revert TooLate();
        (bool decided,) = majorityOf(jobId);
        if (decided) revert HasMajority();
        _settle(jobId, j, d, providerValid, true);
    }

    /// @notice No majority and no arbiter decision in time.
    ///         Round 0: neutral 50/50 split of the budget (no fee), bonds returned minus vote fees.
    ///         Appeal round: the appeal failed to overturn -> round-0 decision stands.
    function resolveStale(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        Dispute storage d = disputes[jobId];
        if (j.status != Status.Disputed || d.phase != Phase.Voting) revert InvalidState();
        if (block.timestamp <= uint256(rounds[jobId][d.round].revealDeadline) + params.arbitrationWindow) revert TooEarly();
        (bool decided,) = majorityOf(jobId);
        if (decided) revert HasMajority();
        if (d.round == 1) {
            _settle(jobId, j, d, d.outcomeValid, false);
        } else {
            _split(jobId, j, d);
        }
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
                // overturned: slash the round-0 majority, appellant gets its bond remainder back
                uint8 wrong = d.outcomeValid ? 3 : 4;
                address[] storage c0 = _committees[jobId][0];
                for (uint256 i = 0; i < c0.length; ++i) {
                    if (memberVote[jobId][c0[i]] == wrong) toBurn += _penalize(jobId, c0[i], d.penalty);
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

    function _split(uint256 jobId, Job storage j, Dispute storage d) internal {
        d.phase = Phase.Done;
        (uint256 bondLeft, uint256 toBurn) = _processRound(jobId, 0, d.bond, d.voteFee, d.penalty);
        d.bond = 0;
        _unlockProvider(j);
        uint256 budget = j.budget;
        j.budget = 0;
        j.status = Status.Split;
        uint256 toProvider = budget / 2;
        uint256 toCreator = budget - toProvider;
        if (bondLeft > 0) superToken.safeTransfer(d.challenger, bondLeft);
        superToken.safeTransfer(j.provider, toProvider);
        superToken.safeTransfer(j.creator, toCreator);
        emit JobSplit(jobId, toProvider, toCreator);
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
        if (info.indexPlus1 != 0 && info.bond < params.minVerifierStake) _removeFromList(v);
    }

    function _payProvider(uint256 jobId, Job storage j) internal {
        uint256 budget = j.budget;
        j.budget = 0;
        j.status = Status.Finalized;
        _unlockProvider(j);

        uint256 fee = (budget * j.feeBps) / BPS;
        uint256 burned = (fee * j.burnShareBps) / BPS;
        address t = treasury;
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

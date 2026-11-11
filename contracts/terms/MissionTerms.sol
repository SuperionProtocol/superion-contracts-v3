// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMarketRoles { function hasRole(bytes32 role, address account) external view returns (bool); }

/// @title MissionTerms (LOCAL PROTOTYPE)
/// @notice Immutable, append-only history of marketplace rule versions. Each mission is bound
///         ONCE, at creation, to the version in force; later governance creates a new version
///         for NEW missions only. Deployed by the marketplace constructor; only that marketplace
///         may write. No owner, no proxy, no setter for the market address, no token custody,
///         and no outgoing calls (so no reentrancy surface).
contract MissionTerms {
    struct Params {
        uint16 feeBps;
        uint16 burnShareBps;       // share of fee burned
        uint16 treasuryShareBps;   // share of fee to treasury (<= MAX_TREASURY_SHARE_BPS)
        uint32 challengePeriod;
        uint32 voteCommitWindow;
        uint32 voteRevealWindow;
        uint32 appealWindow;
        uint32 arbitrationWindow; // Draw attempt duration, snapshotted on opening; NOT an arbitration expiry
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

    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_FEE_BPS = 1_000;
    uint256 internal constant MAX_TREASURY_SHARE_BPS = 5_000;
    uint256 internal constant MAX_COMMITTEE = 15;
    uint256 internal constant MIN_BOND_FLOOR = 1 ether / 1000;

    address public immutable market;
    Params[] private _versions;
    mapping(uint256 => uint256) private _jobVersionPlus1;

    error OnlyMarket();
    error InvalidParams();
    error AlreadyBound();
    error UnknownJob();
    error AccessControlUnauthorizedAccount(address account, bytes32 neededRole); // same selector as OpenZeppelin

    event ParamsUpdated(uint256 indexed version, Params p);
    event TermsBound(uint256 indexed jobId, uint256 indexed version);

    modifier onlyMarket() { if (msg.sender != market) revert OnlyMarket(); _; }
    /// Rule changes stay with the SAME authority as before: the marketplace's DEFAULT_ADMIN_ROLE
    /// holder (checked live in the marketplace AccessControl). No new role or owner is created.
    modifier onlyMarketAdmin() {
        if (!IMarketRoles(market).hasRole(bytes32(0), msg.sender)) revert AccessControlUnauthorizedAccount(msg.sender, bytes32(0));
        _;
    }

    constructor(Params memory p) { market = msg.sender; _push(p); }

    // ------------------------------------------------------------ writes
    function setParams(Params calldata p) external onlyMarketAdmin { _push(p); }

    function setFees(uint16 feeBps, uint16 burnShareBps) external onlyMarketAdmin {
        Params memory p = _versions[_versions.length - 1];
        p.feeBps = feeBps;
        p.burnShareBps = burnShareBps;
        _push(p);
    }

    /// @notice Binds a NEW mission to the current version, once. Returns its budget-fee rates.
    function bind(uint256 jobId) external onlyMarket returns (uint16 feeBps, uint16 burnShareBps, uint16 treasuryShareBps) {
        if (_jobVersionPlus1[jobId] != 0) revert AlreadyBound();
        uint256 v = _versions.length;
        _jobVersionPlus1[jobId] = v;
        emit TermsBound(jobId, v - 1);
        Params storage p = _versions[v - 1];
        return (p.feeBps, p.burnShareBps, p.treasuryShareBps);
    }

    // ------------------------------------------------------------ views
    function current() external view returns (Params memory) { return _versions[_versions.length - 1]; }
    function versionCount() external view returns (uint256) { return _versions.length; }
    function version(uint256 v) external view returns (Params memory) { return _versions[v]; }
    function jobVersion(uint256 jobId) external view returns (uint256) {
        uint256 v = _jobVersionPlus1[jobId]; if (v == 0) revert UnknownJob(); return v - 1;
    }
    function termsOf(uint256 jobId) public view returns (Params memory) {
        uint256 v = _jobVersionPlus1[jobId]; if (v == 0) revert UnknownJob(); return _versions[v - 1];
    }
    /// @notice Current-rule quote (UI / new missions only).
    function quote(uint256 budget) external view returns (uint256 bond, uint256 penalty, uint256 voteFee) {
        return amounts(budget, _versions[_versions.length - 1]);
    }

    // ---- narrow per-mission reads used by the marketplace (small ABI = small marketplace bytecode)
    function _job(uint256 jobId) internal view returns (Params storage) {
        uint256 v = _jobVersionPlus1[jobId]; if (v == 0) revert UnknownJob(); return _versions[v - 1];
    }
    /// Global registry rules (NOT mission terms): current minimum verifier bond, job cap ratio.
    function registryRule() external view returns (uint256 minVerifierStake, uint256 maxJobStakeBps) {
        Params storage p = _versions[_versions.length - 1];
        return (p.minVerifierStake, p.maxJobStakeBps);
    }
    function providerLock(uint256 jobId, uint256 budget) external view returns (uint256) {
        return (budget * _job(jobId).providerStakeBps) / BPS;
    }
    function windows(uint256 jobId) external view returns (uint256 challengePeriod, uint256 appealWindow) {
        Params storage p = _job(jobId); return (p.challengePeriod, p.appealWindow);
    }
    function filing(uint256 jobId, uint256 budget)
        external view returns (uint256 bond, uint256 penalty, uint256 voteFee, uint16 slashVerifierBps, uint16 slashChallengerBps)
    {
        Params memory p = _job(jobId);
        (bond, penalty, voteFee) = amounts(budget, p);
        return (bond, penalty, voteFee, p.slashVerifierBps, p.slashChallengerBps);
    }
    /// Same arithmetic as the previous in-marketplace appeal bond.
    function appealBond(uint256 jobId, uint256 bond, uint256 voteFee) external view returns (uint256 ab) {
        Params storage p = _job(jobId);
        ab = (bond * p.appealBondMultBps) / BPS;
        uint256 feeCover = voteFee * p.appealCommitteeSize;
        if (ab < feeCover) ab = feeCover;
    }
    function drawRule(uint256 jobId, uint256 round)
        external view returns (uint256 drawWindow, uint8 size, uint32 commitWindow, uint32 revealWindow, uint256 minVerifierStake)
    {
        Params storage p = _job(jobId);
        return (p.arbitrationWindow, round == 0 ? p.committeeSize : p.appealCommitteeSize, p.voteCommitWindow, p.voteRevealWindow, p.minVerifierStake);
    }

    /// Same arithmetic as the previous in-marketplace disputeAmounts.
    function amounts(uint256 budget, Params memory p) public pure returns (uint256 bond, uint256 penalty, uint256 voteFee) {
        voteFee = _clamp((budget * p.voteFeeBps) / BPS, p.minVoteFee, p.maxVoteFee);
        penalty = _clamp((budget * p.penaltyBps) / BPS, p.minPenalty, p.maxPenalty);
        bond = _clamp((budget * p.bondBps) / BPS, p.minBond, p.maxBond);
        uint256 feeCover = voteFee * p.committeeSize;
        if (bond < feeCover) bond = feeCover;
    }

    function _clamp(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return x < lo ? lo : (x > hi ? hi : x);
    }

    /// Validation predicates moved verbatim from the previous marketplace _setParams.
    function _push(Params memory p) internal {
        if (p.feeBps > MAX_FEE_BPS) revert InvalidParams();
        if (p.treasuryShareBps > MAX_TREASURY_SHARE_BPS) revert InvalidParams();
        if (uint256(p.burnShareBps) + p.treasuryShareBps > BPS) revert InvalidParams();
        if (p.challengePeriod < 1 minutes) revert InvalidParams();
        if (p.challengePeriod > 30 days) revert InvalidParams();
        if (p.voteCommitWindow < 1 minutes) revert InvalidParams();
        if (p.voteCommitWindow > 14 days) revert InvalidParams();
        if (p.voteRevealWindow < 1 minutes) revert InvalidParams();
        if (p.voteRevealWindow > 14 days) revert InvalidParams();
        if (p.appealWindow < 1 minutes) revert InvalidParams();
        if (p.appealWindow > 14 days) revert InvalidParams();
        if (p.arbitrationWindow < 1 hours) revert InvalidParams();
        if (p.arbitrationWindow > 60 days) revert InvalidParams();
        if (p.committeeSize < 3) revert InvalidParams();
        if (p.committeeSize % 2 == 0) revert InvalidParams();
        if (p.appealCommitteeSize <= p.committeeSize) revert InvalidParams();
        if (p.appealCommitteeSize > MAX_COMMITTEE) revert InvalidParams();
        if (p.appealCommitteeSize % 2 == 0) revert InvalidParams();
        if (p.providerStakeBps > 5 * BPS) revert InvalidParams();
        if (uint256(p.slashVerifierBps) + p.slashChallengerBps > BPS) revert InvalidParams();
        if (p.bondBps > BPS) revert InvalidParams();
        if (p.penaltyBps > BPS) revert InvalidParams();
        if (p.voteFeeBps > BPS) revert InvalidParams();
        if (p.appealBondMultBps < BPS) revert InvalidParams();
        if (p.maxJobStakeBps == 0) revert InvalidParams();
        if (p.minVerifierStake == 0) revert InvalidParams();
        if (p.minBond < MIN_BOND_FLOOR) revert InvalidParams();
        if (p.maxBond < p.minBond) revert InvalidParams();
        if (p.minPenalty > p.maxPenalty) revert InvalidParams();
        if (p.maxPenalty > p.minVerifierStake) revert InvalidParams();
        if (p.minVoteFee > p.maxVoteFee) revert InvalidParams();
        _versions.push(p);
        emit ParamsUpdated(_versions.length - 1, p);
    }
}

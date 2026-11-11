// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Minimal read-only view of SuperionJobMarketplaceV3.jobs(id) (public getter, field order of struct Job).
interface IMarketJobsView {
    function jobs(uint256 jobId) external view returns (
        address creator, address provider, uint16 feeBps, uint16 burnShareBps, uint8 status,
        uint64 deadline, uint64 challengeDeadline, uint64 disputeDeadline, uint256 budget, uint256 lockedStake,
        string memory jobURI, string memory resultURI, uint16 treasuryShareBps, address treasury);
}

/**
 * @title CodeMissionSuites (LOCAL PROTOTYPE)
 * @notice Optional, separate module for CODE missions: freezes two keccak256 fingerprints before work starts
 *         (public test suite + hidden checks) and lets anyone reveal the hidden suite only once the provider
 *         has delivered. The marketplace bytecode is NOT changed and does not call this module.
 * @dev    DOES NOT RUN TESTS and DOES NOT MOVE FUNDS. Pass/fail stays an off-chain proof; disagreements use the
 *         existing dispute path (verifiers / Safe). No admin, no owner, no pause, no upgrade: once registered,
 *         fingerprints can never change. A mission without a registration is an ordinary (non-code) mission.
 */
contract CodeMissionSuites {
    uint8 internal constant STATUS_OPEN = 1; // SuperionJobMarketplaceV3.Status.Open

    IMarketJobsView public immutable market;

    struct Suites {
        bytes32 publicSuiteHash;  // keccak256(exact public suite bytes)
        bytes32 hiddenSuiteHash;  // keccak256(exact hidden suite bytes; should start with a random 32-byte salt)
        uint64 registeredAt;
        uint64 revealedAt;
    }

    mapping(uint256 => Suites) private _suites;
    /// @notice Optional off-chain locator of the public suite (informative; the fingerprint is the source of truth).
    mapping(uint256 => string) public publicSuiteURI;

    event SuitesRegistered(uint256 indexed jobId, address indexed creator, bytes32 publicSuiteHash, bytes32 hiddenSuiteHash, string publicSuiteURI);
    event HiddenSuiteRevealed(uint256 indexed jobId, address indexed revealer, bytes32 hiddenSuiteHash, bytes hiddenSuite);

    error ZeroAddress();
    error ZeroHash();
    error AlreadyRegistered();
    error NotCreator();
    error NotOpen();
    error NotRegistered();
    error NotDelivered();
    error AlreadyRevealed();
    error HashMismatch();

    constructor(address market_) {
        if (market_ == address(0)) revert ZeroAddress();
        market = IMarketJobsView(market_);
    }

    /// @notice Job creator only, once, while the job is still Open (before any provider is assigned).
    function register(uint256 jobId, bytes32 publicSuiteHash, bytes32 hiddenSuiteHash, string calldata uri) external {
        if (publicSuiteHash == bytes32(0) || hiddenSuiteHash == bytes32(0)) revert ZeroHash();
        Suites storage s = _suites[jobId];
        if (s.registeredAt != 0) revert AlreadyRegistered();
        (address creator,,,, uint8 status,,,,,,,,,) = market.jobs(jobId);
        if (creator != msg.sender) revert NotCreator();
        if (status != STATUS_OPEN) revert NotOpen();
        s.publicSuiteHash = publicSuiteHash;
        s.hiddenSuiteHash = hiddenSuiteHash;
        s.registeredAt = uint64(block.timestamp);
        publicSuiteURI[jobId] = uri;
        emit SuitesRegistered(jobId, msg.sender, publicSuiteHash, hiddenSuiteHash, uri);
    }

    /// @notice Anyone may reveal, but only after delivery (a result was submitted) and only the exact frozen bytes.
    function revealHidden(uint256 jobId, bytes calldata hiddenSuite) external {
        Suites storage s = _suites[jobId];
        if (s.registeredAt == 0) revert NotRegistered();
        if (s.revealedAt != 0) revert AlreadyRevealed();
        (,,,,,,,,,,, string memory resultURI,,) = market.jobs(jobId);
        if (bytes(resultURI).length == 0) revert NotDelivered();
        if (keccak256(hiddenSuite) != s.hiddenSuiteHash) revert HashMismatch();
        s.revealedAt = uint64(block.timestamp);
        emit HiddenSuiteRevealed(jobId, msg.sender, s.hiddenSuiteHash, hiddenSuite);
    }

    function suitesOf(uint256 jobId) external view returns (bytes32 publicSuiteHash, bytes32 hiddenSuiteHash, uint64 registeredAt, uint64 revealedAt) {
        Suites storage s = _suites[jobId];
        return (s.publicSuiteHash, s.hiddenSuiteHash, s.registeredAt, s.revealedAt);
    }

    function isCodeMission(uint256 jobId) external view returns (bool) { return _suites[jobId].registeredAt != 0; }

    /// @notice Approved rule (local prototype): hidden checks count AGAINST the provider only if they were registered
    ///         AND validly revealed (exact frozen bytes, after delivery). Not registered or not revealed => they do NOT
    ///         count against the provider; public tests and the announced spec (jobURI) remain usable.
    /// @dev    Read-only guidance for verifiers / the Safe. It does not decide payment, run tests or penalise anyone.
    function hiddenChecksStatus(uint256 jobId) external view returns (bool registered, bool revealed, bool countAgainstProvider, uint64 revealedAt) {
        Suites storage s = _suites[jobId];
        registered = s.registeredAt != 0;
        revealed = s.revealedAt != 0;
        countAgainstProvider = registered && revealed;
        revealedAt = s.revealedAt;
    }

    /// @notice Anyone can check a copy of the public suite (any time) against the frozen fingerprint.
    function matchesPublic(uint256 jobId, bytes calldata suite) external view returns (bool) {
        Suites storage s = _suites[jobId];
        return s.registeredAt != 0 && keccak256(suite) == s.publicSuiteHash;
    }

    /// @notice Anyone can check a copy of the hidden suite against the frozen fingerprint (meaningful after reveal).
    function matchesHidden(uint256 jobId, bytes calldata suite) external view returns (bool) {
        Suites storage s = _suites[jobId];
        return s.registeredAt != 0 && keccak256(suite) == s.hiddenSuiteHash;
    }
}

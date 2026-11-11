// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/governance/TimelockController.sol";

interface IGovernanceSafe {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);
}

interface IOfficialMarket {
    function staking() external view returns (address);
    function superToken() external view returns (address);
    function hasRole(bytes32 role, address account) external view returns (bool);
}

/// @title SuperionGovernanceTimelock (LOCAL PROTOTYPE)
/// @notice OpenZeppelin TimelockController plus:
///  1. the minimum delay can never be below 48 hours (construction and updateDelay);
///  2. ROLE RECIPIENT RULE (approved): every `grantRole` executed by this timelock (the only admin of the
///     marketplace, staking and token in the governed wiring, and of itself) is checked:
///       - DEFAULT_ADMIN_ROLE (role admin / "accordeur de rôles")  -> only this timelock;
///       - OPERATOR_ROLE (staking operator)                       -> ONLY the official marketplace recorded
///         here (approved: no arbitrary contract, even one controlled by a single person);
///       - every other role (PAUSER, ARBITER, MINTER, PROPOSER, EXECUTOR, CANCELLER, any unknown role)
///         -> only the official Safe recorded here.
///  3. the official Safe can only change through this timelock (`updateSafe`, itself >= 48h), and the new
///     Safe must have threshold >= 2, >= 2 owners and the same guard code installed.
///     Proposer/executor must be that Safe; no extra admin.
///  4. the official marketplace (sole allowed staking operator) can only change through this timelock
///     (`updateMarket`, itself >= 48h); one official marketplace at a time.
/// The marketplace bytecode is NOT changed by this rule.
contract SuperionGovernanceTimelock is TimelockController {
    uint256 public constant MIN_DELAY_FLOOR = 48 hours;
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 internal constant SAFE_GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;

    /// @notice The official (local test) Safe. Changeable only by this timelock itself.
    address public safe;
    /// @notice The official marketplace: the ONLY allowed recipient of the staking OPERATOR_ROLE.
    ///         Changeable only by this timelock itself (updateMarket, >= 48h).
    address public officialMarket;
    /// @notice Code hash of the guard that every official Safe must have installed.
    bytes32 public immutable guardCodehash;

    error DelayBelowFloor(uint256 delay);
    error InvalidRoleSetup();
    error InvalidGovernanceSafe(address candidate);
    error RoleRecipientNotAllowed(bytes32 role, address account);
    error InvalidOfficialMarket(address candidate);
    event SafeUpdated(address indexed oldSafe, address indexed newSafe);
    event OfficialMarketUpdated(address indexed oldMarket, address indexed newMarket);

    /// @param market_ address of the official marketplace. It is deployed AFTER this timelock (it needs this
    ///        address as admin), so it is passed as the precomputed CREATE address and the local wiring asserts it
    ///        matches the deployed marketplace before handing over the staking admin.
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin, address market_)
        TimelockController(minDelay, proposers, executors, admin)
    {
        if (market_ == address(0)) revert InvalidOfficialMarket(market_);
        officialMarket = market_;
        if (minDelay < MIN_DELAY_FLOOR) revert DelayBelowFloor(minDelay);
        if (admin != address(0) || proposers.length != 1 || executors.length != 1 || proposers[0] != executors[0]) revert InvalidRoleSetup();
        bytes32 g = _safeGuardCodehash(proposers[0]);
        guardCodehash = g;
        safe = proposers[0];
    }

    function updateDelay(uint256 newDelay) public override {
        if (newDelay < MIN_DELAY_FLOOR) revert DelayBelowFloor(newDelay);
        super.updateDelay(newDelay);
    }

    /// @notice Change the official Safe. Only through this timelock (>= 48h). Roles still have to be moved by
    ///         explicit grantRole/revokeRole calls (they can be in the same batch, after this call).
    function updateSafe(address newSafe) external {
        if (msg.sender != address(this)) revert TimelockUnauthorizedCaller(msg.sender);
        if (newSafe == safe || _safeGuardCodehash(newSafe) != guardCodehash) revert InvalidGovernanceSafe(newSafe);
        emit SafeUpdated(safe, newSafe);
        safe = newSafe;
    }

    /// @notice Change the official marketplace (sole allowed staking operator). Only through this timelock (>= 48h).
    ///         Sanity checks only (a contract can lie in its views): the real safeguard is Safe 2-of-3 + public 48h.
    ///         The new marketplace must use the same staking and token and have this timelock as admin. The staking
    ///         OPERATOR_ROLE still has to be granted (same batch is fine) and the old one revoked once its jobs end.
    function updateMarket(address newMarket) external {
        if (msg.sender != address(this)) revert TimelockUnauthorizedCaller(msg.sender);
        address old = officialMarket;
        if (newMarket == old || newMarket.code.length == 0) revert InvalidOfficialMarket(newMarket);
        IOfficialMarket n = IOfficialMarket(newMarket);
        try n.staking() returns (address st) { if (st != IOfficialMarket(old).staking()) revert InvalidOfficialMarket(newMarket); }
        catch { revert InvalidOfficialMarket(newMarket); }
        try n.superToken() returns (address tk) { if (tk != IOfficialMarket(old).superToken()) revert InvalidOfficialMarket(newMarket); }
        catch { revert InvalidOfficialMarket(newMarket); }
        try n.hasRole(DEFAULT_ADMIN_ROLE, address(this)) returns (bool ok) { if (!ok) revert InvalidOfficialMarket(newMarket); }
        catch { revert InvalidOfficialMarket(newMarket); }
        emit OfficialMarketUpdated(old, newMarket);
        officialMarket = newMarket;
    }

    function isAllowedRoleRecipient(bytes32 role, address account) public view returns (bool) {
        if (role == DEFAULT_ADMIN_ROLE) return account == address(this);
        if (role == OPERATOR_ROLE) return account == officialMarket && account.code.length > 0;
        return account == safe;
    }

    function _execute(address target, uint256 value, bytes calldata data) internal override {
        if (data.length >= 68 && bytes4(data[:4]) == this.grantRole.selector) {
            (bytes32 role, address account) = abi.decode(data[4:68], (bytes32, address));
            if (!isAllowedRoleRecipient(role, account)) revert RoleRecipientNotAllowed(role, account);
        }
        super._execute(target, value, data);
    }

    /// @dev Returns the code hash of the guard installed on `s`; reverts unless `s` is a contract with
    ///      threshold >= 2, >= 2 owners and a guard contract installed.
    function _safeGuardCodehash(address s) internal view returns (bytes32 h) {
        if (s.code.length == 0) revert InvalidGovernanceSafe(s);
        IGovernanceSafe gs = IGovernanceSafe(s);
        if (gs.getThreshold() < 2 || gs.getOwners().length < 2) revert InvalidGovernanceSafe(s);
        address guard = address(uint160(uint256(bytes32(gs.getStorageAt(uint256(SAFE_GUARD_SLOT), 1)))));
        if (guard.code.length == 0) revert InvalidGovernanceSafe(s);
        h = guard.codehash;
    }
}

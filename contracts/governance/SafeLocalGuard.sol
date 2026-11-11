// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal views of the official Safe 1.4.1 contract used by the guard (read-only).
interface ISafeViews {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);
    function getModulesPaginated(address start, uint256 pageSize) external view returns (address[] memory array, address next);
}

/// @title SafeLocalGuard — LOCAL TEST COPY ONLY (Hardhat 31337)
/// @notice Transaction guard for the LOCAL test SafeL2 1.4.1 (3 owners, threshold 2). It must NEVER be
///         installed on the real mainnet Safe; nothing in this repository does so.
///         Same ABI as Safe 1.4.1 `Guard` (checkTransaction / checkAfterExecution / ERC165).
///         Rules (no owner, no admin, no storage, no funds, cannot be switched off):
///           - no DELEGATECALL at all (would let arbitrary code rewrite the Safe storage);
///           - changeThreshold / addOwnerWithThreshold / removeOwner: resulting threshold >= 2;
///           - removeOwner: at least 2 owners must remain;
///           - enableModule: always refused; setGuard (remove or replace): always refused;
///           - setFallbackHandler: always refused (pause/jury/guard step);
///           - after EVERY guarded transaction: threshold >= 2, owners >= 2, this guard still installed,
///             no module enabled (catch-all, e.g. for nested self-calls).
///         Limits: Safe 1.4.1 does not run guards for module transactions (none can be added here).
contract SafeLocalGuard {
    bytes32 internal constant GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    address internal constant SENTINEL = address(0x1);
    uint256 public constant MIN_SIGNATURES = 2;

    error DelegateCallBlocked();
    error ThresholdTooLow(uint256 threshold);
    error TooFewOwners(uint256 owners);
    error ModulesBlocked();
    error GuardIsPermanent();
    error GuardRemoved();
    error FallbackHandlerBlocked();

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0xe6d7a83a // type(Guard).interfaceId in Safe 1.4.1
            || interfaceId == 0x01ffc9a7; // ERC165
    }

    function checkTransaction(
        address to, uint256, bytes memory data, uint8 operation, uint256, uint256, uint256, address,
        address payable, bytes memory, address
    ) external view {
        if (operation != 0) revert DelegateCallBlocked();
        if (to != msg.sender || data.length < 4) return; // only self-calls can change the Safe configuration
        bytes4 sel;
        // solhint-disable-next-line no-inline-assembly
        assembly { sel := mload(add(data, 32)) }
        if (sel == 0xe19a9dd9) revert GuardIsPermanent();   // setGuard(address)
        if (sel == 0x610b5925) revert ModulesBlocked();     // enableModule(address)
        if (sel == 0xf08a0323) revert FallbackHandlerBlocked(); // setFallbackHandler(address)
        if (sel == 0x694e80c3) _min(_word(data, 0));        // changeThreshold(uint256)
        else if (sel == 0x0d582f13) _min(_word(data, 1));   // addOwnerWithThreshold(address,uint256)
        else if (sel == 0xf8dc5dd9) {                       // removeOwner(address,address,uint256)
            _min(_word(data, 2));
            uint256 remaining = ISafeViews(msg.sender).getOwners().length - 1;
            if (remaining < MIN_SIGNATURES) revert TooFewOwners(remaining);
        }
    }

    function checkAfterExecution(bytes32, bool) external view {
        ISafeViews s = ISafeViews(msg.sender);
        _min(s.getThreshold());
        uint256 owners = s.getOwners().length;
        if (owners < MIN_SIGNATURES) revert TooFewOwners(owners);
        if (address(uint160(uint256(bytes32(s.getStorageAt(uint256(GUARD_STORAGE_SLOT), 1))))) != address(this)) revert GuardRemoved();
        (address[] memory modules, ) = s.getModulesPaginated(SENTINEL, 1);
        if (modules.length != 0) revert ModulesBlocked();
    }

    function _word(bytes memory data, uint256 i) private pure returns (uint256 w) {
        if (data.length < 4 + 32 * (i + 1)) return 0; // malformed => treated as 0 => refused by _min
        // solhint-disable-next-line no-inline-assembly
        assembly { w := mload(add(add(data, 36), mul(i, 32))) }
    }

    function _min(uint256 t) private pure { if (t < MIN_SIGNATURES) revert ThresholdTooLow(t); }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IGuardManagerSetup {
    function setGuard(address guard) external;
}

/// @title SafeGuardSetupHelper (TESTNET Base Sepolia deployment helper)
/// @notice Used ONLY as the `to` of `Safe.setup(...)`, which DELEGATECALLs it inside the brand-new Safe proxy.
///         The Safe then calls its own `setGuard(guard)` (msg.sender == the Safe, so the official `authorized`
///         check passes). This lets a 2-of-3 Safe be created with its guard already installed, without any owner
///         signature. Holds no state, no role, no funds; a direct (non-delegate) call is refused.
contract SafeGuardSetupHelper {
    address private immutable self;
    error DelegateCallOnly();

    constructor() { self = address(this); }

    function enableGuard(address guard) external {
        if (address(this) == self) revert DelegateCallOnly();
        IGuardManagerSetup(address(this)).setGuard(guard);
    }
}

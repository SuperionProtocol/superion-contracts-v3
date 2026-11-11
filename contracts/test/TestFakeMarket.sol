// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// TEST ONLY. A one-person contract that IMITATES the official marketplace views (same staking, same token, says the
/// timelock is its admin) to show the documented limit of protection 3: `updateMarket` checks are sanity checks, a
/// contract can lie in its views; the real safeguard remains Safe 2-of-3 + the public 48h delay.
contract TestFakeMarket {
    address public immutable owner;
    address public immutable staking;
    address public immutable superToken;
    address public immutable timelock;
    constructor(address staking_, address token_, address timelock_) { owner = msg.sender; staking = staking_; superToken = token_; timelock = timelock_; }
    function hasRole(bytes32 role, address account) external view returns (bool) { return role == bytes32(0) && account == timelock; }
}

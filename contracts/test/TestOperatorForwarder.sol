// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/// TEST ONLY. A contract controlled by ONE person. Used to show the documented residual risk of protection 1:
/// OPERATOR_ROLE can still go (after the public 48h delay) to a contract, and a contract may be controlled by one key.
contract TestOperatorForwarder {
    address public immutable owner;
    constructor() { owner = msg.sender; }
    function exec(address target, bytes calldata data) external returns (bytes memory res) {
        require(msg.sender == owner, "NOT_OWNER");
        bool ok;
        (ok, res) = target.call(data);
        if (!ok) { assembly { revert(add(res, 32), mload(res)) } }
    }
}

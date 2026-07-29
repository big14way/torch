// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal stand-in for a Flare Smart Accounts PersonalAccount: a contract
/// wallet that executes arbitrary batched calls on behalf of a single
/// controller (in FSA, the FDC-verified XRPL owner via the master controller).
/// Exists to prove TorchVault has no EOA assumptions — a smart account can
/// approve, deposit, trade, and withdraw exactly like an externally owned one.
contract MockSmartAccount {
    error NotController();
    error CallFailed(uint256 index, bytes reason);

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    address public immutable controller;

    constructor(address controller_) {
        controller = controller_;
    }

    /// Mirrors FSA's executeUserOp(Call[]) shape: the whole batch is atomic —
    /// one failed call reverts everything, like a single XRPL instruction.
    function executeUserOp(Call[] calldata calls) external returns (bytes[] memory results) {
        if (msg.sender != controller) revert NotController();
        results = new bytes[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
            results[i] = ret;
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// Stands in for Flare's TeeMachineRegistry so the adapter's trust decision can
/// be tested: which addresses are attested, and what happens when that set
/// changes under it (which it does — a TEE's key does not survive a restart).
contract MockTeeRegistry {
    mapping(uint256 => address[]) private _active;

    function setActive(uint256 extensionId, address[] calldata teeIds) external {
        delete _active[extensionId];
        for (uint256 i = 0; i < teeIds.length; ++i) {
            _active[extensionId].push(teeIds[i]);
        }
    }

    function getActiveTeeMachines(uint256 extensionId)
        external
        view
        returns (address[] memory teeIds, string[] memory urls)
    {
        teeIds = _active[extensionId];
        urls = new string[](teeIds.length);
    }
}

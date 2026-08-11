// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// Test double for TorchVaultV2's executor surface: records what the adapter
/// forwarded so the tests can assert on it. Never deployed to a live network.
contract MockVaultSink {
    uint256 public lastId;
    uint256 public lastEntryPrice6;
    uint64 public lastOid;
    uint256 public calls;

    function confirmFill(uint256 id, uint256 entryPrice6, uint64 hlOid) external {
        lastId = id;
        lastEntryPrice6 = entryPrice6;
        lastOid = hlOid;
        calls++;
    }

    function acceptRequest(uint256) external {
        calls++;
    }

    function confirmClose(uint256, uint256) external {
        calls++;
    }

    function executeTrigger(uint256, uint256) external {
        calls++;
    }

    function liquidate(uint256, uint256) external {
        calls++;
    }
}

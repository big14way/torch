// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// Test double for TorchVaultV2's executor surface: records what the adapter
/// forwarded so the tests can assert on it. Never deployed to a live network.
/// Feed double: lets a test place the oracle above or below the venue price.
contract MockPriceReader {
    uint256 public value;
    int8 public dec;
    uint64 public ts;

    function set(uint256 _value, int8 _dec) external {
        value = _value;
        dec = _dec;
        ts = uint64(block.timestamp);
    }

    function getPrice(bytes21) external view returns (uint256, int8, uint64) {
        return (value, dec, ts);
    }
}

contract MockVaultSink {
    struct Position {
        uint256 id;
        address owner;
        bytes32 market;
        bool isLong;
        uint256 marginFxrp;
        uint256 sizeUsd6;
        uint256 entryPrice6;
        uint256 exitPrice6;
        int256 pnlFxrp;
        uint64 hlOid;
        uint8 status;
        uint40 openedAt;
        uint40 closedAt;
    }

    MockPriceReader public oracleImpl;
    bool public isLong = true;
    bytes32 public constant MARKET = bytes32("BTC");

    constructor() {
        oracleImpl = new MockPriceReader();
    }

    function oracle() external view returns (address) {
        return address(oracleImpl);
    }

    function setIsLong(bool v) external {
        isLong = v;
    }

    function getPosition(uint256 id) external view returns (Position memory p) {
        p.id = id;
        p.market = MARKET;
        p.isLong = isLong;
    }

    function markets(bytes32) external pure returns (bytes21, bool, uint16) {
        return (bytes21(uint168(1)), true, 100);
    }

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

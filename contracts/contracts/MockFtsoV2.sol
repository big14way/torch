// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceReader} from "./interfaces/IPriceReader.sol";

/// @notice Local stand-in for Flare FTSOv2. Prices are stored at 6 decimals.
/// TEST ONLY. setPrice is open so the demo agent can random-walk the market.
contract MockFtsoV2 is IPriceReader {
    struct Feed {
        uint256 value;
        uint64 timestamp;
    }

    mapping(bytes21 => Feed) public feeds;

    event PriceSet(bytes21 indexed feedId, uint256 value);

    function setPrice(bytes21 feedId, uint256 value6) external {
        feeds[feedId] = Feed({value: value6, timestamp: uint64(block.timestamp)});
        emit PriceSet(feedId, value6);
    }

    function getPrice(bytes21 feedId)
        external
        view
        returns (uint256 value, int8 decimals, uint64 timestamp)
    {
        Feed memory f = feeds[feedId];
        require(f.value != 0, "MockFtsoV2: feed not set");
        return (f.value, 6, f.timestamp);
    }
}

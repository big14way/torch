// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal price read surface shaped after Flare FtsoV2 getFeedById.
/// On Coston2 / Flare this is fulfilled by FtsoV2Reader (a thin adapter over
/// the enshrined FtsoV2 contract). Locally it is fulfilled by MockFtsoV2.
/// Feed ids are bytes21: 0x01 (crypto category) + ASCII feed name + zero padding.
/// Example XRP/USD: 0x015852502f55534400000000000000000000000000
interface IPriceReader {
    /// @return value      raw feed value
    /// @return decimals   feed decimals (can be negative per FtsoV2 spec)
    /// @return timestamp  unix time of the value
    function getPrice(bytes21 feedId)
        external
        view
        returns (uint256 value, int8 decimals, uint64 timestamp);
}

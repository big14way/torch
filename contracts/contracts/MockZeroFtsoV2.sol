// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceReader} from "./interfaces/IPriceReader.sol";

/// @notice Returns a fresh but ZERO price. MockFtsoV2 refuses to serve zero,
/// which hid the fact that a zero feed sailed through the deviation band and
/// permanently bricked positions. TEST ONLY.
contract MockZeroFtsoV2 is IPriceReader {
    function getPrice(bytes21) external view returns (uint256, int8, uint64) {
        return (0, 6, uint64(block.timestamp));
    }
}

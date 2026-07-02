// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceReader} from "./interfaces/IPriceReader.sol";

/// @dev View-style surface of Flare FtsoV2, matching the TestFtsoV2Interface
/// pattern from the Flare developer docs. On Coston2 the fee is currently
/// zero, so a static read works. VERIFY before mainnet: if feed fees become
/// non-zero, switch to the payable getFeedById and a FeeCalculator quote.
interface IFtsoV2Like {
    function getFeedById(bytes21 feedId)
        external
        view
        returns (uint256 value, int8 decimals, uint64 timestamp);
}

/// @notice Thin adapter so TorchVault can consume the enshrined FtsoV2 through
/// the same IPriceReader shape as the local mock. Resolve the FtsoV2 address
/// with scripts/resolveFtsoV2.ts (dynamic lookup via FlareContractRegistry,
/// never hardcode).
contract FtsoV2Reader is IPriceReader {
    IFtsoV2Like public immutable ftsoV2;

    constructor(address _ftsoV2) {
        ftsoV2 = IFtsoV2Like(_ftsoV2);
    }

    function getPrice(bytes21 feedId)
        external
        view
        returns (uint256 value, int8 decimals, uint64 timestamp)
    {
        return ftsoV2.getFeedById(feedId);
    }
}

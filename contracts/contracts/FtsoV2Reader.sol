// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IPriceReader} from "./interfaces/IPriceReader.sol";
import {ContractRegistry} from "@flarenetwork/flare-periphery-contracts/coston2/ContractRegistry.sol";

/// @notice Thin adapter so TorchVault can consume the enshrined FtsoV2 through
/// the same IPriceReader shape as the local mock. The FtsoV2 address is
/// resolved through the FlareContractRegistry on every read, so an FtsoV2
/// redeploy is picked up without touching this contract or the vault.
/// On Coston2 getFeedById is a fee-free view (TestFtsoV2Interface). VERIFY
/// before mainnet: if feed fees become non-zero, switch to the payable
/// getFeedById and a FeeCalculator quote.
contract FtsoV2Reader is IPriceReader {
    function getPrice(bytes21 feedId)
        external
        view
        returns (uint256 value, int8 decimals, uint64 timestamp)
    {
        return ContractRegistry.getTestFtsoV2().getFeedById(feedId);
    }
}

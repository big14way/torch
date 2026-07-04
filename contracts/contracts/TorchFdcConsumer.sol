// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IWeb2Json} from "@flarenetwork/flare-periphery-contracts/coston2/IWeb2Json.sol";
import {ContractRegistry} from "@flarenetwork/flare-periphery-contracts/coston2/ContractRegistry.sol";

/// @notice Records a Hyperliquid fill on-chain only if Flare's FDC has attested,
/// via a Web2Json (JsonApi) request against Hyperliquid's public /info endpoint,
/// that the fill actually exists. This is the roadmap step from Torch's trust
/// model: replace a bare executor price report with a hardware-independent proof
/// that the exchange fill really happened. The Merkle proof is verified against
/// the FDC verification contract resolved from Flare's ContractRegistry.
contract TorchFdcConsumer {
    struct HlFill {
        string coin;
        string side;
        string px;
        string sz;
        uint256 oid;
        uint256 time;
    }

    HlFill public lastFill;
    uint256 public attestedCount;

    event FillAttested(
        uint256 indexed oid,
        string coin,
        string side,
        string px,
        string sz,
        uint256 time,
        uint64 votingRound
    );

    /// @notice Verify an FDC Web2Json proof of a Hyperliquid fill and record it.
    function attestFill(IWeb2Json.Proof calldata proof) external {
        require(
            ContractRegistry.getFdcVerification().verifyWeb2Json(proof),
            "FDC: proof not verified"
        );
        HlFill memory f = abi.decode(proof.data.responseBody.abiEncodedData, (HlFill));
        lastFill = f;
        attestedCount += 1;
        emit FillAttested(f.oid, f.coin, f.side, f.px, f.sz, f.time, proof.data.votingRound);
    }
}

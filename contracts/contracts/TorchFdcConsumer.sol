// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IWeb2Json} from "@flarenetwork/flare-periphery-contracts/coston2/IWeb2Json.sol";
import {ContractRegistry} from "@flarenetwork/flare-periphery-contracts/coston2/ContractRegistry.sol";

/// @dev Minimal read-only view of TorchVault (field-for-field mirror of its
/// Position struct; the Status enum decodes as uint8).
interface ITorchVault {
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

    function getPosition(uint256 id) external view returns (Position memory);
}

/// @notice Records a Hyperliquid fill on-chain only if Flare's FDC has attested,
/// via a Web2Json (JsonApi) request against Hyperliquid's public /info endpoint,
/// that the fill actually exists. This is the step off the executor's word in
/// Torch's trust model: the Merkle proof is verified against the FDC
/// verification contract resolved from Flare's ContractRegistry, so the fill is
/// believed because Flare's validators re-fetched the exchange and agreed.
///
/// The FDC proves "this URL + body + JQ transform produced this data", so the
/// contract must pin all three or the attestation is meaningless: a different
/// URL proves someone else's API, a different body proves someone else's
/// account, and a free-form JQ can fabricate constant output regardless of what
/// the API returned.
///
/// Two entry points:
///  - attestFill: records the account's latest fill (pinned JQ).
///  - attestFillForPosition: binds a proof to a specific TorchVault position.
///    The JQ is reconstructed on-chain from the position's stored Hyperliquid
///    order id, so the only fill that can ever be attested for a position is
///    the one the vault says backs it.
contract TorchFdcConsumer {
    struct HlFill {
        string coin;
        string side;
        string px;
        string sz;
        uint256 oid;
        uint256 time;
    }

    /// Pinned request: the Hyperliquid testnet info endpoint...
    string public constant EXPECTED_URL = "https://api.hyperliquid-testnet.xyz/info";
    /// ...queried for the Torch executor account's fills...
    string public constant EXPECTED_BODY =
        "{\"type\":\"userFills\",\"user\":\"0xfDb941fe97e13B599BC576c4142128aB97D01622\"}";
    /// ...transformed by exactly this JQ (latest fill; userFills is newest-first).
    string public constant EXPECTED_JQ =
        "{coin: .[0].coin, side: .[0].dir, px: .[0].px, sz: .[0].sz, oid: .[0].oid, time: .[0].time}";

    ITorchVault public immutable vault;

    HlFill public lastFill;
    HlFill[] public fills;
    uint256 public attestedCount;
    mapping(uint256 => bool) public attestedOids;
    /// positionId => the Hyperliquid oid proven for it (0 = not attested)
    mapping(uint256 => uint256) public positionAttestedOid;

    event FillAttested(
        uint256 indexed oid,
        string coin,
        string side,
        string px,
        string sz,
        uint256 time,
        uint64 votingRound
    );
    event PositionFillAttested(
        uint256 indexed positionId,
        uint64 indexed hlOid,
        string px,
        string sz,
        uint64 votingRound
    );

    constructor(address _vault) {
        vault = ITorchVault(_vault);
    }

    /// @notice Verify an FDC Web2Json proof of the account's latest fill and
    /// record it. Permissionless on purpose: the proof, not the caller, is
    /// what's trusted.
    function attestFill(IWeb2Json.Proof calldata proof) external {
        IWeb2Json.RequestBody calldata req = _verify(proof);
        require(_eq(req.postProcessJq, EXPECTED_JQ), "FDC: wrong transform");

        HlFill memory f = abi.decode(proof.data.responseBody.abiEncodedData, (HlFill));
        require(!attestedOids[f.oid], "FDC: fill already attested");
        attestedOids[f.oid] = true;

        lastFill = f;
        fills.push(f);
        attestedCount += 1;
        emit FillAttested(f.oid, f.coin, f.side, f.px, f.sz, f.time, proof.data.votingRound);
    }

    /// @notice Bind an FDC-attested fill to the TorchVault position it backs.
    /// The expected JQ is rebuilt from the position's stored order id, so a
    /// proof for any other fill — or any looser transform — cannot pass.
    function attestFillForPosition(uint256 positionId, IWeb2Json.Proof calldata proof) external {
        IWeb2Json.RequestBody calldata req = _verify(proof);

        ITorchVault.Position memory p = vault.getPosition(positionId);
        require(p.hlOid != 0, "FDC: position has no exchange oid");
        require(positionAttestedOid[positionId] == 0, "FDC: position already attested");

        string memory expectedJq = string.concat(
            "map(select(.oid == ",
            _toString(p.hlOid),
            ")) | .[0] | {coin: .coin, side: .dir, px: .px, sz: .sz, oid: .oid, time: .time}"
        );
        require(_eq(req.postProcessJq, expectedJq), "FDC: transform not bound to position");

        HlFill memory f = abi.decode(proof.data.responseBody.abiEncodedData, (HlFill));
        require(f.oid == p.hlOid, "FDC: oid mismatch");

        positionAttestedOid[positionId] = f.oid;
        emit PositionFillAttested(positionId, p.hlOid, f.px, f.sz, proof.data.votingRound);
    }

    function _verify(IWeb2Json.Proof calldata proof)
        private
        view
        returns (IWeb2Json.RequestBody calldata req)
    {
        require(
            ContractRegistry.getFdcVerification().verifyWeb2Json(proof),
            "FDC: proof not verified"
        );
        req = proof.data.requestBody;
        require(_eq(req.url, EXPECTED_URL), "FDC: wrong source URL");
        require(_eq(req.body, EXPECTED_BODY), "FDC: wrong account");
    }

    function _eq(string calldata a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) digits++;
        bytes memory buf = new bytes(digits);
        for (uint256 v = value; v != 0; v /= 10) {
            buf[--digits] = bytes1(uint8(48 + (v % 10)));
        }
        return string(buf);
    }
}

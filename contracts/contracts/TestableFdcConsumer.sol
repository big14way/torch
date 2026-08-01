// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IWeb2Json} from "@flarenetwork/flare-periphery-contracts/coston2/IWeb2Json.sol";
import {TorchFdcConsumer, ITorchVault} from "./TorchFdcConsumer.sol";

/// @notice TorchFdcConsumer with the Merkle/consensus check stubbed, so the
/// binding, replay and pinning guards can be exercised without a live
/// FdcVerification contract. Everything else is the production code path.
/// TEST ONLY.
contract TestableFdcConsumer is TorchFdcConsumer {
    bool public proofValid = true;

    constructor(address _vault) TorchFdcConsumer(_vault) {}

    function setProofValid(bool v) external {
        proofValid = v;
    }

    function _verifyProof(IWeb2Json.Proof calldata) internal view override returns (bool) {
        return proofValid;
    }
}

/// @notice Stand-in for TorchVault's getPosition, so consumer tests can pin a
/// position's market, side and exchange order id directly. TEST ONLY.
contract MockVaultForFdc {
    mapping(uint256 => ITorchVault.Position) private _positions;

    function setPosition(
        uint256 id,
        bytes32 market,
        bool isLong,
        uint64 hlOid
    ) external {
        ITorchVault.Position memory p;
        p.id = id;
        p.market = market;
        p.isLong = isLong;
        p.hlOid = hlOid;
        _positions[id] = p;
    }

    function getPosition(uint256 id) external view returns (ITorchVault.Position memory) {
        return _positions[id];
    }
}

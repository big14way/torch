// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// Test double for TorchFdcConsumer: lets a test declare which order id the
/// validators supposedly bound to a position. Never deployed to a live network.
contract MockFdcConsumer {
    mapping(uint256 => uint256) public positionAttestedOid;

    function set(uint256 positionId, uint256 oid) external {
        positionAttestedOid[positionId] = oid;
    }
}

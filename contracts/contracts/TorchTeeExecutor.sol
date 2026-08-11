// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// Minimal surface of TorchVaultV2 that this adapter drives. Declared locally
/// so the adapter compiles against the DEPLOYED vault without importing it.
interface ITorchVault {
    function confirmFill(uint256 id, uint256 entryPrice6, uint64 hlOid) external;
    function acceptRequest(uint256 id) external;
    function confirmClose(uint256 id, uint256 exitPrice6) external;
    function executeTrigger(uint256 id, uint256 exitPrice6) external;
    function liquidate(uint256 id, uint256 markPrice6) external;
}

/// @title TorchTeeExecutor
/// @notice Sits between Torch's off-chain executor and the live vault so that
/// the ONE number the operator could previously choose — the entry price — has
/// to come from a Flare Confidential Compute enclave instead.
///
/// The live vault is not upgradeable, but its `executor` is owner-settable, so
/// pointing it at this adapter needs one transaction and is reversible in one.
/// The vault keeps every guard it already had (FTSOv2 band, never-worse-than-
/// oracle, staleness): this contract only *narrows* what reaches it.
///
/// Split of powers, deliberately conservative:
///   • confirmFill  — requires a signature from the registered TEE attestor.
///     The agent supplies the transaction; the enclave supplies the price.
///   • everything else (acceptRequest / confirmClose / executeTrigger /
///     liquidate) — forwarded from the existing agent, unchanged. Those are
///     time-critical or have no instruction to hang off, and moving them
///     behind a consensus relay would make liquidations slower, not safer.
contract TorchTeeExecutor {
    ITorchVault public immutable VAULT;

    address public owner;
    /// @notice The enclave's signing address, as registered on Flare's
    /// TeeMachineRegistry for Torch's extension.
    address public teeAttestor;
    /// @notice The off-chain agent permitted to relay non-price operations.
    address public agent;

    /// @notice Each attestation is single-use, keyed by the exchange order id,
    /// so a signature cannot be replayed onto a second position.
    mapping(uint64 => bool) public oidUsed;

    event TeeAttestorUpdated(address attestor);
    event AgentUpdated(address agent);
    event FillConfirmedFromTee(uint256 indexed id, uint256 entryPrice6, uint64 hlOid, address attestor);

    error NotOwner();
    error NotAgent();
    error BadSignature();
    error OidAlreadyUsed();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    constructor(ITorchVault _vault, address _agent, address _teeAttestor) {
        if (address(_vault) == address(0) || _agent == address(0)) revert ZeroAddress();
        VAULT = _vault;
        owner = msg.sender;
        agent = _agent;
        teeAttestor = _teeAttestor; // may be zero until the enclave is registered
    }

    // ------------------------------------------------------------ owner

    function setTeeAttestor(address _attestor) external onlyOwner {
        teeAttestor = _attestor;
        emit TeeAttestorUpdated(_attestor);
    }

    function setAgent(address _agent) external onlyOwner {
        if (_agent == address(0)) revert ZeroAddress();
        agent = _agent;
        emit AgentUpdated(_agent);
    }

    function transferOwnership(address _owner) external onlyOwner {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
    }

    // ------------------------------------------------- the attested path

    /// @notice The digest the enclave signs. Binding the vault address and
    /// chain id stops a signature produced for one deployment being replayed
    /// against another.
    function fillDigest(uint256 id, uint256 entryPrice6, uint64 hlOid) public view returns (bytes32) {
        return keccak256(
            abi.encode(block.chainid, address(VAULT), "TORCH_ATTEST_FILL", id, entryPrice6, hlOid)
        );
    }

    /// @notice Confirm a fill whose price came from the enclave.
    /// @dev The agent still pays the gas and picks the moment — it simply can
    /// no longer pick the number. If the enclave never saw this order id on the
    /// exchange it will not have signed, so this reverts.
    function confirmFillAttested(
        uint256 id,
        uint256 entryPrice6,
        uint64 hlOid,
        bytes calldata signature
    ) external onlyAgent {
        if (teeAttestor == address(0)) revert BadSignature();
        if (oidUsed[hlOid]) revert OidAlreadyUsed();

        bytes32 digest = fillDigest(id, entryPrice6, hlOid);
        // EIP-191 personal-sign envelope: what the TEE sign port produces.
        bytes32 signed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        if (_recover(signed, signature) != teeAttestor) revert BadSignature();

        oidUsed[hlOid] = true;
        emit FillConfirmedFromTee(id, entryPrice6, hlOid, teeAttestor);
        VAULT.confirmFill(id, entryPrice6, hlOid);
    }

    // --------------------------------------------- unchanged agent paths
    // Deliberately pass-through. These are time-critical (liquidation) or have
    // no on-chain event to trigger an instruction from (triggers), so routing
    // them through a consensus relay would degrade them. Named here so the
    // split is visible on-chain rather than asserted in a README.

    function acceptRequest(uint256 id) external onlyAgent {
        VAULT.acceptRequest(id);
    }

    function confirmClose(uint256 id, uint256 exitPrice6) external onlyAgent {
        VAULT.confirmClose(id, exitPrice6);
    }

    function executeTrigger(uint256 id, uint256 exitPrice6) external onlyAgent {
        VAULT.executeTrigger(id, exitPrice6);
    }

    function liquidate(uint256 id, uint256 markPrice6) external onlyAgent {
        VAULT.liquidate(id, markPrice6);
    }

    // ------------------------------------------------------------ internal

    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        // reject the malleable upper half of the curve order
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        return ecrecover(hash, v, r, s);
    }
}

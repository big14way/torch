// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// Minimal surface of TorchVaultV2 that this adapter drives. Declared locally
/// so the adapter compiles against the DEPLOYED vault without importing it.
/// Flare's TeeMachineRegistry, as exposed by the FlareTeeManager diamond.
/// Returns the machines currently attested and in PRODUCTION for an extension.
interface ITeeMachineRegistryLike {
    function getActiveTeeMachines(uint256 extensionId)
        external
        view
        returns (address[] memory teeIds, string[] memory urls);
}

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
///   • confirmFill  — requires a signature from an enclave Flare currently
///     attests for Torch's extension. The agent supplies the transaction; the
///     enclave supplies the price.
///   • everything else (acceptRequest / confirmClose / executeTrigger /
///     liquidate) — forwarded from the existing agent, unchanged. Those are
///     time-critical or have no instruction to hang off, and moving them
///     behind a consensus relay would make liquidations slower, not safer.
contract TorchTeeExecutor {
    ITorchVault public immutable VAULT;
    /// @notice Flare's TeeMachineRegistry (the FlareTeeManager diamond).
    ITeeMachineRegistryLike public immutable TEE_REGISTRY;
    /// @notice Torch's Flare Compute Extension id.
    uint256 public immutable EXTENSION_ID;

    address public owner;
    /// @notice The off-chain agent permitted to relay non-price operations.
    address public agent;

    /// @notice Each attestation is single-use, keyed by the exchange order id,
    /// so a signature cannot be replayed onto a second position.
    mapping(uint64 => bool) public oidUsed;

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

    constructor(
        ITorchVault _vault,
        address _agent,
        ITeeMachineRegistryLike _teeRegistry,
        uint256 _extensionId
    ) {
        if (address(_vault) == address(0) || _agent == address(0)) revert ZeroAddress();
        if (address(_teeRegistry) == address(0)) revert ZeroAddress();
        VAULT = _vault;
        TEE_REGISTRY = _teeRegistry;
        EXTENSION_ID = _extensionId;
        owner = msg.sender;
        agent = _agent;
    }

    // ------------------------------------------------------------ owner

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
        if (oidUsed[hlOid]) revert OidAlreadyUsed();

        bytes32 digest = fillDigest(id, entryPrice6, hlOid);
        // Match the node's SignServer exactly. Handed a message it hashes it
        // once with keccak256 and THEN applies the EIP-191 personal-sign
        // envelope, so verifying the envelope over `digest` alone recovers a
        // different address on every message and would never match.
        bytes32 inner = keccak256(abi.encodePacked(digest));
        bytes32 signed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
        address signer = _recover(signed, signature);
        if (signer == address(0) || !_isActiveTee(signer)) revert BadSignature();

        oidUsed[hlOid] = true;
        emit FillConfirmedFromTee(id, entryPrice6, hlOid, signer);
        VAULT.confirmFill(id, entryPrice6, hlOid);
    }

    /// @notice True when Flare currently attests this address as a PRODUCTION
    /// machine for Torch's extension.
    /// @dev Asked of the registry per call rather than pinned at deploy time:
    /// a TEE's key is NOT preserved across restarts, so any address stored here
    /// would be stale the first time the enclave restarts, and the vault would
    /// reject every honest fill. Trusting the registry means trusting whichever
    /// enclave Flare's data providers have attested right now.
    function _isActiveTee(address signer) internal view returns (bool) {
        (address[] memory teeIds, ) = TEE_REGISTRY.getActiveTeeMachines(EXTENSION_ID);
        for (uint256 i = 0; i < teeIds.length; ++i) {
            if (teeIds[i] == signer) return true;
        }
        return false;
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

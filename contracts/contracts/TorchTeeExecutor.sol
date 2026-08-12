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

interface IPriceReaderLike {
    function getPrice(bytes21 feedId) external view returns (uint256 value, int8 decimals, uint64 timestamp);
}

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
    function markets(bytes32 key) external view returns (bytes21 feedId, bool listed, uint16 maxLeverageX10);
    function oracle() external view returns (IPriceReaderLike);
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
///     attests for Torch's extension, then clamps that price to Flare's oracle
///     in the trader's favour. The agent supplies the transaction; the enclave
///     supplies the price; the chain does the clamping that the agent used to
///     do off-chain.
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
    /// @param attestedPrice6 what the enclave saw on the venue
    /// @param settledPrice6 what the vault stored, after the oracle clamp
    event FillConfirmedFromTee(
        uint256 indexed id,
        uint256 attestedPrice6,
        uint256 settledPrice6,
        uint64 hlOid,
        address attestor
    );

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
        uint256 settled = _clampToOracle(id, entryPrice6);
        emit FillConfirmedFromTee(id, entryPrice6, settled, hlOid, signer);
        VAULT.confirmFill(id, settled, hlOid);
    }

    /// @notice The price the vault actually stores: the better of what the
    /// venue filled at and what Flare's oracle says, from the trader's side.
    ///
    /// @dev This has to exist, and it has to live here. Hyperliquid does not
    /// track FTSO exactly, so a real fill lands on the wrong side of the
    /// vault's no-worse-than-oracle guard about half the time. Torch's agent
    /// has always absorbed that by quietly reporting the trader-favourable
    /// side — correct for the trader, but the operator's word for it. Doing it
    /// on-chain keeps the outcome and drops the trust: the venue price is
    /// enclave-signed, the clamp is a pure function of it, and both numbers are
    /// in the event, so anyone can recompute what happened.
    ///
    /// Note this can only ever move the price in the TRADER's favour. It gives
    /// the operator no new freedom: a fabricated venue price still has to carry
    /// an enclave signature, and the vault's own band check still applies to
    /// whatever comes out of here.
    function _clampToOracle(uint256 id, uint256 attested6) internal view returns (uint256) {
        ITorchVault.Position memory p = VAULT.getPosition(id);
        (bytes21 feedId, , ) = VAULT.markets(p.market);
        uint256 ref6 = _oraclePrice6(feedId);
        if (ref6 == 0) return attested6; // let the vault's own guards reject it
        // Entry: a long wants to buy lower, a short wants to sell higher.
        if (p.isLong) return attested6 < ref6 ? attested6 : ref6;
        return attested6 > ref6 ? attested6 : ref6;
    }

    /// @dev Mirrors TorchVaultV2._price6 so the adapter compares against the
    /// same number the vault is about to check. Returns 0 rather than
    /// reverting, so an oracle problem surfaces as the vault's own revert.
    function _oraclePrice6(bytes21 feedId) internal view returns (uint256) {
        try VAULT.oracle().getPrice(feedId) returns (uint256 value, int8 dec, uint64) {
            if (value == 0) return 0;
            if (dec == 6) return value;
            if (dec > 6) return value / (10 ** uint256(uint8(dec - 6)));
            return value * (10 ** uint256(6 - int256(dec)));
        } catch {
            return 0;
        }
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

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// TODO: Replace local interfaces with imports from flare-smart-contracts-v2 once published as a package.
import { ITeeExtensionRegistry } from "./interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "./interfaces/ITeeMachineRegistry.sol";

/// @title TorchInstructionSender
/// @notice Torch's on-chain entry point into its Flare Compute Extension.
///
/// Anyone may ask the enclave to look up the Hyperliquid fill behind a vault
/// position. The caller supplies only a position id and the order id the vault
/// already recorded for it — never a price. The enclave queries the exchange
/// itself and signs what it found, so the answer cannot be shaped by whoever
/// asked the question.
///
/// DO NOT MODIFY: constructor, setExtensionId(), _getExtensionId()
contract TorchInstructionSender {
    /// @notice Operation type for Torch actions.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_TORCH = bytes32("TORCH");

    /// @notice Command for the ATTEST_FILL action.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_ATTEST_FILL = bytes32("ATTEST_FILL");

    /// @notice Reference to the TEE extension registry contract.
    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    /// @notice Reference to the TEE machine registry contract.
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    /// @notice First public extension ID. The registry reserves IDs below this
    /// for system/reserved extensions; public extensions are assigned from here up.
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000; // 65536

    uint256 private _extensionId;

    /// @notice Initializes the contract with registry addresses.
    /// @param _teeExtensionRegistry Address of the TEE extension registry.
    /// @param _teeMachineRegistry Address of the TEE machine registry.
    constructor(
        ITeeExtensionRegistry _teeExtensionRegistry,
        ITeeMachineRegistry _teeMachineRegistry
    ) {
        require(address(_teeExtensionRegistry) != address(0), "TeeExtensionRegistry cannot be zero address");
        require(address(_teeMachineRegistry) != address(0), "TeeMachineRegistry cannot be zero address");
        require(address(_teeExtensionRegistry).code.length > 0, "TeeExtensionRegistry has no code");
        require(address(_teeMachineRegistry).code.length > 0, "TeeMachineRegistry has no code");
        TEE_EXTENSION_REGISTRY = _teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
    }

    /// @notice Finds and sets this contract's extension id. Can only be set once.
    /// DO NOT MODIFY this function.
    function setExtensionId() external {
        require(_extensionId == 0, "Extension ID already set.");

        uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                return;
            }
        }
        revert("Extension ID not found.");
    }

    /// @notice Ask the enclave to attest the Hyperliquid fill behind a position.
    /// @param _positionId The TorchVault position id.
    /// @param _oid The Hyperliquid order id the vault recorded at confirmFill.
    /// @dev The payload is JSON so the enclave decodes it with DisallowUnknownFields;
    /// any extra field is rejected rather than silently ignored.
    function requestFillAttestation(uint256 _positionId, uint64 _oid) external payable {
        require(_oid != 0, "oid must not be zero");

        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        bytes memory message = abi.encodePacked(
            '{"positionId":', _toString(_positionId),
            ',"oid":', _toString(uint256(_oid)), '}'
        );

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_TORCH,
            opCommand: OP_COMMAND_ATTEST_FILL,
            message: message,
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(teeIds, params);
    }

    /// @notice Digits-only uint to string. Keeps the JSON payload injection-free:
    /// no caller-supplied text ever reaches the enclave, only numbers.
    function _toString(uint256 v) internal pure returns (bytes memory) {
        if (v == 0) return bytes("0");
        uint256 d;
        for (uint256 t = v; t != 0; t /= 10) d++;
        bytes memory out = new bytes(d);
        for (uint256 i = d; i > 0; i--) {
            out[i - 1] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return out;
    }

    /// @notice Returns the cached extension ID, reverting if not yet set.
    /// @return The extension ID assigned to this contract.
    function _getExtensionId() internal view returns (uint256) {
        require(_extensionId != 0, "Extension ID is not set.");
        return _extensionId;
    }
}

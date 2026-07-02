// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Local stand-in for FXRP. Real FXRP on Coston2 comes from the
/// Coston2 faucet; on Flare mainnet it is minted through the FAssets system.
/// TEST ONLY. Anyone can mint.
contract MockFXRP is ERC20 {
    constructor() ERC20("Mock FXRP", "tFXRP") {}

    function decimals() public pure override returns (uint8) {
        return 6; // XRP drops
    }

    /// @notice Grab 10,000 tFXRP for testing.
    function faucet() external {
        _mint(msg.sender, 10_000 * 10 ** 6);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

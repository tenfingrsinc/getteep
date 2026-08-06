// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

contract MockSoulessVault is ERC4626 {
    constructor(IERC20 _asset) ERC20("Mock Souless Vault", "msvUSDC") ERC4626(_asset) {}
}

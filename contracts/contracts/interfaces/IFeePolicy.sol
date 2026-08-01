// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFeePolicy {
    function withdrawalFeeBps(address owner, address token, uint256 amount) external view returns (uint16);

    function performanceFeeBps(bytes32 strategyId) external view returns (uint16);
}

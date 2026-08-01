// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStrategyRegistry {
    struct Strategy {
        address adapter;
        address asset;
        address positionToken;
        bool enabled;
        bool emergencyDisabled;
        uint256 maxPositionAssets;
        uint256 totalAssetsCap;
        string label;
    }

    function isStrategyAvailable(bytes32 strategyId) external view returns (bool);

    function getStrategy(bytes32 strategyId) external view returns (Strategy memory);
}

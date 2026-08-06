// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStrategyAdapter {
    struct DepositParams {
        uint256 assets;
        address beneficiary;
        uint256 minShares;
        uint256 deadline;
        bytes adapterData;
    }

    struct RedeemParams {
        uint256 shares;
        address recipient;
        uint256 minAssets;
        uint256 deadline;
        bytes adapterData;
    }

    function strategyId() external view returns (bytes32);

    function asset() external view returns (address);

    function positionToken() external view returns (address);

    function totalManagedAssets() external view returns (uint256);

    function previewDeposit(uint256 assets) external view returns (uint256 shares);

    function previewRedeem(uint256 shares) external view returns (uint256 assets);

    function deposit(DepositParams calldata params) external returns (uint256 shares);

    function redeem(RedeemParams calldata params) external returns (uint256 assets);
}

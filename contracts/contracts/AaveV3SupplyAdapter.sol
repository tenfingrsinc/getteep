// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IAaveV3Pool.sol";
import "./interfaces/IStrategyAdapter.sol";
import "./interfaces/IStrategyRegistry.sol";

/**
 * @title AaveV3SupplyAdapter
 * @notice Isolated Grow Tips lending vault. It custodies aTokens and issues
 *         non-rebasing ERC-20 shares so individual ClaimWallet lots remain measurable.
 */
contract AaveV3SupplyAdapter is ERC20, Ownable, Pausable, ReentrancyGuard, IStrategyAdapter {
    using SafeERC20 for IERC20;

    uint16 public constant AAVE_REFERRAL_CODE = 0;

    IStrategyRegistry public immutable registry;
    IAaveV3Pool public immutable pool;
    bytes32 public immutable override strategyId;
    address public immutable override asset;
    address public immutable aToken;

    event Deposited(address indexed caller, address indexed beneficiary, uint256 assets, uint256 shares);
    event Redeemed(address indexed caller, address indexed recipient, uint256 shares, uint256 assets);

    constructor(
        address _registry,
        address _pool,
        bytes32 _strategyId,
        address _asset,
        address _aToken
    ) ERC20("Teep Aave USDC Strategy", "teepAaveUSDC") Ownable(msg.sender) {
        require(_registry != address(0), "Adapter: zero registry");
        require(_pool != address(0), "Adapter: zero pool");
        require(_strategyId != bytes32(0), "Adapter: zero strategy");
        require(_asset != address(0), "Adapter: zero asset");
        require(_aToken != address(0), "Adapter: zero position token");
        registry = IStrategyRegistry(_registry);
        pool = IAaveV3Pool(_pool);
        strategyId = _strategyId;
        asset = _asset;
        aToken = _aToken;
    }

    function decimals() public view override returns (uint8) {
        return IERC20Metadata(asset).decimals();
    }

    function positionToken() external view override returns (address) {
        return address(this);
    }

    function totalManagedAssets() public view override returns (uint256) {
        return IERC20(aToken).balanceOf(address(this));
    }

    function previewDeposit(uint256 assets) public view override returns (uint256 shares) {
        uint256 supply = totalSupply();
        uint256 managed = totalManagedAssets();
        return supply == 0 ? assets : Math.mulDiv(assets, supply, managed);
    }

    function previewRedeem(uint256 shares) public view override returns (uint256 assets) {
        uint256 supply = totalSupply();
        return supply == 0 ? 0 : Math.mulDiv(shares, totalManagedAssets(), supply);
    }

    function deposit(DepositParams calldata params)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        require(params.assets > 0, "Adapter: zero amount");
        require(params.beneficiary != address(0), "Adapter: zero beneficiary");
        require(block.timestamp <= params.deadline, "Adapter: deadline expired");
        require(params.adapterData.length == 0, "Adapter: unsupported data");
        require(registry.isStrategyAvailable(strategyId), "Adapter: strategy unavailable");

        IStrategyRegistry.Strategy memory strategy = registry.getStrategy(strategyId);
        require(params.assets <= strategy.maxPositionAssets, "Adapter: position cap exceeded");
        uint256 managedBefore = totalManagedAssets();
        require(managedBefore + params.assets <= strategy.totalAssetsCap, "Adapter: total cap exceeded");

        uint256 supply = totalSupply();
        require((supply == 0) == (managedBefore == 0), "Adapter: inconsistent initial state");
        shares = supply == 0 ? params.assets : Math.mulDiv(params.assets, supply, managedBefore);
        require(shares > 0, "Adapter: zero shares");
        require(shares >= params.minShares, "Adapter: insufficient shares");

        uint256 idleBefore = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), params.assets);
        require(IERC20(asset).balanceOf(address(this)) - idleBefore == params.assets, "Adapter: asset transfer mismatch");

        IERC20(asset).forceApprove(address(pool), params.assets);
        pool.supply(asset, params.assets, address(this), AAVE_REFERRAL_CODE);
        IERC20(asset).forceApprove(address(pool), 0);
        require(totalManagedAssets() >= managedBefore + params.assets, "Adapter: provider receipt mismatch");

        _mint(params.beneficiary, shares);
        emit Deposited(msg.sender, params.beneficiary, params.assets, shares);
    }

    function redeem(RedeemParams calldata params)
        external
        override
        nonReentrant
        returns (uint256 assets)
    {
        require(params.shares > 0, "Adapter: zero shares");
        require(params.recipient != address(0), "Adapter: zero recipient");
        require(block.timestamp <= params.deadline, "Adapter: deadline expired");
        require(params.adapterData.length == 0, "Adapter: unsupported data");

        uint256 supply = totalSupply();
        require(params.shares <= balanceOf(msg.sender), "Adapter: insufficient shares");
        uint256 quotedAssets = Math.mulDiv(params.shares, totalManagedAssets(), supply);
        require(quotedAssets >= params.minAssets, "Adapter: insufficient assets");

        _burn(msg.sender, params.shares);
        uint256 recipientBefore = IERC20(asset).balanceOf(params.recipient);
        pool.withdraw(asset, quotedAssets, params.recipient);
        assets = IERC20(asset).balanceOf(params.recipient) - recipientBefore;
        require(assets >= params.minAssets, "Adapter: provider slippage");

        emit Redeemed(msg.sender, params.recipient, params.shares, assets);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}

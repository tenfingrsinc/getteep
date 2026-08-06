// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IStrategyAdapter.sol";
import "./interfaces/IStrategyRegistry.sol";

/**
 * @title SoulessVaultAdapter
 * @notice A non-custodial Teep strategy boundary around one reviewed Souless
 *         ERC-4626 vault. Provider-specific Uniswap execution remains behind
 *         the immutable vault and cannot be supplied as arbitrary user calldata.
 */
contract SoulessVaultAdapter is ERC20, Ownable, Pausable, ReentrancyGuard, IStrategyAdapter {
    using SafeERC20 for IERC20;

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_DEPOSIT_LOSS_BPS = 1_000;

    IStrategyRegistry public immutable registry;
    IERC4626 public immutable providerVault;
    bytes32 public immutable override strategyId;
    address public immutable override asset;
    uint16 public immutable maxDepositLossBps;

    event Deposited(
        address indexed account,
        uint256 requestedAssets,
        uint256 creditedAssets,
        uint256 shares,
        uint256 providerShares
    );
    event Redeemed(address indexed account, uint256 shares, uint256 assets, uint256 providerShares);

    constructor(
        address _registry,
        address _providerVault,
        bytes32 _strategyId,
        address _asset,
        uint16 _maxDepositLossBps
    ) ERC20("Teep Souless USDC Strategy", "teepSoulessUSDC") Ownable(msg.sender) {
        require(_registry != address(0), "SoulessAdapter: zero registry");
        require(_providerVault != address(0), "SoulessAdapter: zero vault");
        require(_strategyId != bytes32(0), "SoulessAdapter: zero strategy");
        require(_asset != address(0), "SoulessAdapter: zero asset");
        require(_maxDepositLossBps <= MAX_DEPOSIT_LOSS_BPS, "SoulessAdapter: loss limit too high");
        require(IERC4626(_providerVault).asset() == _asset, "SoulessAdapter: asset mismatch");

        registry = IStrategyRegistry(_registry);
        providerVault = IERC4626(_providerVault);
        strategyId = _strategyId;
        asset = _asset;
        maxDepositLossBps = _maxDepositLossBps;
    }

    function decimals() public view override returns (uint8) {
        return IERC20Metadata(asset).decimals();
    }

    function positionToken() external view override returns (address) {
        return address(this);
    }

    function totalManagedAssets() public view override returns (uint256) {
        uint256 idleAssets = IERC20(asset).balanceOf(address(this));
        uint256 providerShares = providerVault.balanceOf(address(this));
        return idleAssets + providerVault.previewRedeem(providerShares);
    }

    function previewDeposit(uint256 assets) public view override returns (uint256 shares) {
        if (assets == 0) return 0;
        uint256 creditedAssets = providerVault.previewRedeem(providerVault.previewDeposit(assets));
        return _convertToShares(creditedAssets, totalSupply(), totalManagedAssets());
    }

    function previewRedeem(uint256 shares) public view override returns (uint256 assets) {
        uint256 supply = totalSupply();
        if (shares == 0 || supply == 0) return 0;

        uint256 idlePortion = Math.mulDiv(IERC20(asset).balanceOf(address(this)), shares, supply);
        uint256 providerSharePortion = Math.mulDiv(providerVault.balanceOf(address(this)), shares, supply);
        return idlePortion + providerVault.previewRedeem(providerSharePortion);
    }

    function deposit(DepositParams calldata params)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        require(params.assets > 0, "SoulessAdapter: zero amount");
        require(params.beneficiary == msg.sender, "SoulessAdapter: beneficiary must be caller");
        require(block.timestamp <= params.deadline, "SoulessAdapter: deadline expired");
        require(params.adapterData.length == 0, "SoulessAdapter: unsupported data");
        require(registry.isStrategyAvailable(strategyId), "SoulessAdapter: strategy unavailable");

        IStrategyRegistry.Strategy memory strategy = registry.getStrategy(strategyId);
        require(params.assets <= strategy.maxPositionAssets, "SoulessAdapter: position cap exceeded");

        uint256 managedBefore = totalManagedAssets();
        uint256 supplyBefore = totalSupply();
        require(managedBefore + params.assets <= strategy.totalAssetsCap, "SoulessAdapter: total cap exceeded");

        uint256 idleBefore = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), params.assets);
        require(
            IERC20(asset).balanceOf(address(this)) - idleBefore == params.assets,
            "SoulessAdapter: asset transfer mismatch"
        );

        uint256 providerSharesBefore = providerVault.balanceOf(address(this));
        IERC20(asset).forceApprove(address(providerVault), params.assets);
        uint256 reportedProviderShares = providerVault.deposit(params.assets, address(this));
        IERC20(asset).forceApprove(address(providerVault), 0);
        uint256 providerSharesReceived = providerVault.balanceOf(address(this)) - providerSharesBefore;
        require(
            providerSharesReceived > 0 && providerSharesReceived == reportedProviderShares,
            "SoulessAdapter: provider share mismatch"
        );

        uint256 managedAfter = totalManagedAssets();
        require(managedAfter >= managedBefore, "SoulessAdapter: provider value decreased");
        uint256 creditedAssets = managedAfter - managedBefore;
        uint256 minimumCredited = Math.mulDiv(
            params.assets,
            BPS_DENOMINATOR - maxDepositLossBps,
            BPS_DENOMINATOR,
            Math.Rounding.Ceil
        );
        require(creditedAssets >= minimumCredited, "SoulessAdapter: deposit loss exceeded");
        require(managedAfter <= strategy.totalAssetsCap, "SoulessAdapter: total cap exceeded");

        shares = _convertToShares(creditedAssets, supplyBefore, managedBefore);
        require(shares > 0, "SoulessAdapter: zero shares");
        require(shares >= params.minShares, "SoulessAdapter: insufficient shares");

        _mint(msg.sender, shares);
        emit Deposited(msg.sender, params.assets, creditedAssets, shares, providerSharesReceived);
    }

    function redeem(RedeemParams calldata params)
        external
        override
        nonReentrant
        returns (uint256 assets)
    {
        require(params.shares > 0, "SoulessAdapter: zero shares");
        require(params.recipient == msg.sender, "SoulessAdapter: recipient must be caller");
        require(block.timestamp <= params.deadline, "SoulessAdapter: deadline expired");
        require(params.adapterData.length == 0, "SoulessAdapter: unsupported data");

        uint256 supply = totalSupply();
        require(params.shares <= balanceOf(msg.sender), "SoulessAdapter: insufficient shares");

        uint256 idleBefore = IERC20(asset).balanceOf(address(this));
        uint256 idlePortion = Math.mulDiv(idleBefore, params.shares, supply);
        uint256 providerSharePortion = Math.mulDiv(
            providerVault.balanceOf(address(this)),
            params.shares,
            supply
        );

        _burn(msg.sender, params.shares);

        uint256 providerAssets;
        if (providerSharePortion > 0) {
            uint256 reportedAssets = providerVault.redeem(
                providerSharePortion,
                address(this),
                address(this)
            );
            providerAssets = IERC20(asset).balanceOf(address(this)) - idleBefore;
            require(providerAssets == reportedAssets, "SoulessAdapter: provider asset mismatch");
        }

        assets = idlePortion + providerAssets;
        require(assets >= params.minAssets, "SoulessAdapter: insufficient assets");
        IERC20(asset).safeTransfer(msg.sender, assets);

        emit Redeemed(msg.sender, params.shares, assets, providerSharePortion);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _convertToShares(
        uint256 assets,
        uint256 supply,
        uint256 managedAssets
    ) private pure returns (uint256) {
        // Virtual units keep direct donations from permanently blocking initial deposits.
        return Math.mulDiv(assets, supply + 1, managedAssets + 1);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(from == address(0) || to == address(0), "SoulessAdapter: shares non-transferable");
        super._update(from, to, value);
    }
}

// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/interfaces/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/ISoulessV3.sol";
import "./interfaces/IStrategyAdapter.sol";
import "./libraries/TeepV3Math.sol";
import "./libraries/SoulessV3RangePolicy.sol";

/**
 * @title SoulessV3LPVault
 * @notice One immutable USDC/token Uniswap v3 strategy. Teep's adapter is the
 *         only share owner. Deposits can be paused while permissionless,
 *         bounded USDC exits remain available.
 */
contract SoulessV3LPVault is ERC4626, Ownable, Pausable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_SLIPPAGE_BPS = 500;
    uint16 public constant MAX_VALUATION_HAIRCUT_BPS = 1_000;
    uint16 public constant MIN_ORACLE_CARDINALITY = 16;

    struct VaultConfig {
        address usdc;
        address pairedToken;
        address factory;
        address pool;
        address positionManager;
        address swapRouter;
        uint24 poolFee;
        SoulessV3RangePolicy.RangeTemplate rangeTemplate;
        uint32 twapWindow;
        uint24 maxTwapDeviationTicks;
        uint16 maxSlippageBps;
        uint16 valuationHaircutBps;
        address owner;
    }

    IERC20 public immutable pairedToken;
    ISoulessV3Factory public immutable factory;
    ISoulessV3Pool public immutable pool;
    ISoulessV3PositionManager public immutable positionManager;
    ISoulessV3SwapRouter public immutable swapRouter;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable poolFee;
    SoulessV3RangePolicy.RangeTemplate public immutable rangeTemplate;
    int24 public immutable referenceTick;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    uint32 public immutable twapWindow;
    uint24 public immutable maxTwapDeviationTicks;
    uint16 public immutable maxSlippageBps;
    uint16 public immutable valuationHaircutBps;

    address public authorizedAdapter;
    address public keeper;
    uint256 public positionTokenId;

    event AdapterBound(address indexed adapter);
    event KeeperUpdated(address indexed keeper);
    event IdleDeployed(uint256 indexed tokenId, uint256 usdcRequested, uint256 pairedReceived, uint128 liquidity);
    event FeesHarvested(uint256 usdcCollected, uint256 pairedCollected, uint256 pairedConverted);
    event LiquidityRemoved(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    event FullyUnwound(uint256 usdcBalance);

    modifier onlyAdapter() {
        require(msg.sender == authorizedAdapter && authorizedAdapter != address(0), "LPVault: not adapter");
        _;
    }

    modifier onlyKeeperOrOwner() {
        require(msg.sender == keeper || msg.sender == owner(), "LPVault: not keeper");
        _;
    }

    constructor(VaultConfig memory config)
        ERC20("Teep Souless V3 USDC Vault", "tsv3USDC")
        ERC4626(IERC20(config.usdc))
        Ownable(config.owner)
    {
        require(
            config.usdc != address(0) &&
                config.pairedToken != address(0) &&
                config.factory != address(0) &&
                config.pool != address(0) &&
                config.positionManager != address(0) &&
                config.swapRouter != address(0) &&
                config.owner != address(0),
            "LPVault: zero address"
        );
        require(config.usdc != config.pairedToken, "LPVault: identical assets");
        require(config.twapWindow >= 60 && config.twapWindow <= 1 days, "LPVault: invalid TWAP window");
        require(
            config.maxTwapDeviationTicks > 0 && config.maxTwapDeviationTicks <= 10_000,
            "LPVault: invalid deviation"
        );
        require(config.maxSlippageBps <= MAX_SLIPPAGE_BPS, "LPVault: slippage too high");
        require(
            config.valuationHaircutBps >= config.maxSlippageBps &&
                config.valuationHaircutBps <= MAX_VALUATION_HAIRCUT_BPS,
            "LPVault: invalid haircut"
        );
        ISoulessV3Factory configuredFactory = ISoulessV3Factory(config.factory);
        ISoulessV3Pool configuredPool = ISoulessV3Pool(config.pool);
        require(ISoulessV3PositionManager(config.positionManager).factory() == config.factory, "LPVault: manager mismatch");
        require(
            configuredFactory.getPool(config.usdc, config.pairedToken, config.poolFee) == config.pool,
            "LPVault: non-canonical pool"
        );
        require(configuredPool.fee() == config.poolFee, "LPVault: fee mismatch");
        int24 spacing = configuredPool.tickSpacing();
        require(spacing > 0 && configuredFactory.feeAmountTickSpacing(config.poolFee) == spacing, "LPVault: spacing mismatch");
        (,,,, uint16 observationCardinalityNext,,) = configuredPool.slot0();
        require(observationCardinalityNext >= MIN_ORACLE_CARDINALITY, "LPVault: oracle buffer too small");

        address poolToken0 = configuredPool.token0();
        address poolToken1 = configuredPool.token1();
        require(
            (poolToken0 == config.usdc && poolToken1 == config.pairedToken) ||
                (poolToken0 == config.pairedToken && poolToken1 == config.usdc),
            "LPVault: pool assets mismatch"
        );

        pairedToken = IERC20(config.pairedToken);
        factory = configuredFactory;
        pool = configuredPool;
        positionManager = ISoulessV3PositionManager(config.positionManager);
        swapRouter = ISoulessV3SwapRouter(config.swapRouter);
        token0 = poolToken0;
        token1 = poolToken1;
        poolFee = config.poolFee;
        rangeTemplate = config.rangeTemplate;
        twapWindow = config.twapWindow;
        maxTwapDeviationTicks = config.maxTwapDeviationTicks;
        maxSlippageBps = config.maxSlippageBps;
        valuationHaircutBps = config.valuationHaircutBps;

        // Fail deployment when the pool lacks oracle history, then freeze the
        // selected template around this manipulation-resistant reference tick.
        int24 deploymentReferenceTick = TeepV3Math.consult(config.pool, config.twapWindow);
        referenceTick = deploymentReferenceTick;
        (tickLower, tickUpper) = SoulessV3RangePolicy.ticks(
            config.rangeTemplate,
            deploymentReferenceTick,
            spacing
        );
    }

    function bindAdapter(address adapter) external onlyOwner {
        require(adapter != address(0), "LPVault: zero adapter");
        require(authorizedAdapter == address(0), "LPVault: adapter already bound");
        require(
            IStrategyAdapter(adapter).asset() == asset() &&
                IStrategyAdapter(adapter).positionToken() == adapter,
            "LPVault: incompatible adapter"
        );
        authorizedAdapter = adapter;
        emit AdapterBound(adapter);
    }

    function setKeeper(address newKeeper) external onlyOwner {
        keeper = newKeeper;
        emit KeeperUpdated(newKeeper);
    }

    function rangeMultiplier() external view returns (uint16) {
        return SoulessV3RangePolicy.multiplier(rangeTemplate);
    }

    function totalAssets() public view override returns (uint256) {
        int24 twapTick = TeepV3Math.consult(address(pool), twapWindow);
        uint256 usdcValue = IERC20(asset()).balanceOf(address(this));
        uint256 pairedAmount = pairedToken.balanceOf(address(this));

        uint256 tokenId = positionTokenId;
        if (tokenId != 0) {
            (uint128 liquidity, uint128 tokensOwed0, uint128 tokensOwed1) = _positionAmounts(tokenId);
            (uint256 amount0, uint256 amount1) = TeepV3Math.getAmountsForLiquidity(
                TeepV3Math.getSqrtRatioAtTick(twapTick),
                TeepV3Math.getSqrtRatioAtTick(tickLower),
                TeepV3Math.getSqrtRatioAtTick(tickUpper),
                liquidity
            );
            amount0 += tokensOwed0;
            amount1 += tokensOwed1;
            if (token0 == asset()) {
                usdcValue += amount0;
                pairedAmount += amount1;
            } else {
                usdcValue += amount1;
                pairedAmount += amount0;
            }
        }

        uint256 pairedValue = _quotePairedToUsdc(pairedAmount, twapTick);
        return usdcValue + _applyBps(pairedValue, BPS_DENOMINATOR - valuationHaircutBps);
    }

    function deposit(uint256 assets, address receiver)
        public
        override
        onlyAdapter
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        require(receiver == authorizedAdapter, "LPVault: invalid receiver");
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver)
        public
        override
        onlyAdapter
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        require(receiver == authorizedAdapter, "LPVault: invalid receiver");
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address shareOwner)
        public
        override
        onlyAdapter
        nonReentrant
        returns (uint256)
    {
        require(receiver == authorizedAdapter && shareOwner == authorizedAdapter, "LPVault: invalid exit");
        return super.withdraw(assets, receiver, shareOwner);
    }

    function redeem(uint256 shares, address receiver, address shareOwner)
        public
        override
        onlyAdapter
        nonReentrant
        returns (uint256)
    {
        require(receiver == authorizedAdapter && shareOwner == authorizedAdapter, "LPVault: invalid exit");
        if (shares == totalSupply() && shares > 0) {
            _unwindAll(block.timestamp);
            uint256 assets = IERC20(asset()).balanceOf(address(this));
            require(assets > 0, "LPVault: zero assets");
            _burn(shareOwner, shares);
            IERC20(asset()).safeTransfer(receiver, assets);
            emit Withdraw(msg.sender, receiver, shareOwner, assets, shares);
            return assets;
        }
        return super.redeem(shares, receiver, shareOwner);
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        return paused() || receiver != authorizedAdapter || authorizedAdapter == address(0) ? 0 : type(uint256).max;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return maxDeposit(receiver);
    }

    function maxWithdraw(address shareOwner) public view override returns (uint256) {
        return shareOwner == authorizedAdapter && authorizedAdapter != address(0) ? super.maxWithdraw(shareOwner) : 0;
    }

    function maxRedeem(address shareOwner) public view override returns (uint256) {
        return shareOwner == authorizedAdapter && authorizedAdapter != address(0) ? super.maxRedeem(shareOwner) : 0;
    }

    /**
     * @notice Convert idle USDC into the fixed LP mandate. The keeper chooses
     *         only the amount and deadline; price/range/slippage are immutable.
     */
    function deployIdle(uint256 usdcAmount, uint256 deadline)
        external
        onlyKeeperOrOwner
        nonReentrant
        whenNotPaused
        returns (uint128 liquidityAdded)
    {
        require(block.timestamp <= deadline, "LPVault: deadline expired");
        require(usdcAmount >= 2 && usdcAmount <= IERC20(asset()).balanceOf(address(this)), "LPVault: invalid amount");
        int24 twapTick = _requireSafeMarket();

        uint256 swapAmount = usdcAmount / 2;
        uint256 pairedReceived = _swap(asset(), address(pairedToken), swapAmount, twapTick);
        uint256 usdcForLiquidity = usdcAmount - swapAmount;
        (uint256 amount0Desired, uint256 amount1Desired) = token0 == asset()
            ? (usdcForLiquidity, pairedReceived)
            : (pairedReceived, usdcForLiquidity);
        (uint256 amount0Min, uint256 amount1Min) = _liquidityMinimums(
            twapTick,
            amount0Desired,
            amount1Desired
        );

        IERC20(token0).forceApprove(address(positionManager), amount0Desired);
        IERC20(token1).forceApprove(address(positionManager), amount1Desired);
        uint256 tokenId = positionTokenId;
        uint256 amount0Used;
        uint256 amount1Used;
        if (tokenId == 0) {
            (tokenId, liquidityAdded, amount0Used, amount1Used) = positionManager.mint(
                ISoulessV3PositionManager.MintParams({
                    token0: token0,
                    token1: token1,
                    fee: poolFee,
                    tickLower: tickLower,
                    tickUpper: tickUpper,
                    amount0Desired: amount0Desired,
                    amount1Desired: amount1Desired,
                    amount0Min: amount0Min,
                    amount1Min: amount1Min,
                    recipient: address(this),
                    deadline: deadline
                })
            );
            require(tokenId != 0 && positionManager.ownerOf(tokenId) == address(this), "LPVault: invalid NFT");
            positionTokenId = tokenId;
        } else {
            (liquidityAdded, amount0Used, amount1Used) = positionManager.increaseLiquidity(
                ISoulessV3PositionManager.IncreaseLiquidityParams({
                    tokenId: tokenId,
                    amount0Desired: amount0Desired,
                    amount1Desired: amount1Desired,
                    amount0Min: amount0Min,
                    amount1Min: amount1Min,
                    deadline: deadline
                })
            );
        }
        IERC20(token0).forceApprove(address(positionManager), 0);
        IERC20(token1).forceApprove(address(positionManager), 0);
        require(
            liquidityAdded > 0 && amount0Used <= amount0Desired && amount1Used <= amount1Desired,
            "LPVault: invalid liquidity"
        );
        emit IdleDeployed(tokenId, usdcAmount, pairedReceived, liquidityAdded);
    }

    function harvest(uint256 deadline) external nonReentrant returns (uint256 usdcCollected) {
        require(block.timestamp <= deadline, "LPVault: deadline expired");
        _requireSafeMarket();
        uint256 tokenId = positionTokenId;
        require(tokenId != 0, "LPVault: no position");
        uint256 usdcBefore = IERC20(asset()).balanceOf(address(this));
        uint256 pairedBefore = pairedToken.balanceOf(address(this));
        _collectAll(tokenId);
        uint256 pairedCollected = pairedToken.balanceOf(address(this)) - pairedBefore;
        uint256 pairedToConvert = pairedToken.balanceOf(address(this));
        if (pairedToConvert > 0) {
            _swap(address(pairedToken), asset(), pairedToConvert, TeepV3Math.consult(address(pool), twapWindow));
        }
        usdcCollected = IERC20(asset()).balanceOf(address(this)) - usdcBefore;
        emit FeesHarvested(usdcCollected, pairedCollected, pairedToConvert);
    }

    /**
     * @notice Permissionless risk reduction. Anyone can move the entire vault
     *         back to USDC, but immutable TWAP/slippage checks prevent redirection.
     */
    function unwindAll(uint256 deadline) external nonReentrant returns (uint256 usdcBalance) {
        require(block.timestamp <= deadline, "LPVault: deadline expired");
        usdcBalance = _unwindAll(deadline);
    }

    function _unwindAll(uint256 deadline) private returns (uint256 usdcBalance) {
        int24 twapTick = _requireSafeMarket();
        uint256 tokenId = positionTokenId;
        if (tokenId != 0) {
            (uint128 liquidity,,) = _positionAmounts(tokenId);
            if (liquidity > 0) _decreaseLiquidity(tokenId, liquidity, twapTick, deadline);
            _collectAll(tokenId);
            (uint128 remaining, uint128 owed0, uint128 owed1) = _positionAmounts(tokenId);
            require(remaining == 0 && owed0 == 0 && owed1 == 0, "LPVault: position not empty");
            positionManager.burn(tokenId);
            positionTokenId = 0;
        }
        uint256 pairedBalance = pairedToken.balanceOf(address(this));
        if (pairedBalance > 0) _swap(address(pairedToken), asset(), pairedBalance, twapTick);
        usdcBalance = IERC20(asset()).balanceOf(address(this));
        emit FullyUnwound(usdcBalance);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function onERC721Received(address operator, address, uint256, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        require(msg.sender == address(positionManager) && operator == address(this), "LPVault: unsupported NFT");
        return IERC721Receiver.onERC721Received.selector;
    }

    function _withdraw(address caller, address receiver, address shareOwner, uint256 assets, uint256 shares)
        internal
        override
    {
        uint256 idleUsdc = IERC20(asset()).balanceOf(address(this));
        if (idleUsdc < assets) {
            int24 twapTick = _requireSafeMarket();
            uint256 tokenId = positionTokenId;
            require(tokenId != 0, "LPVault: insufficient liquidity");
            (uint128 liquidity,,) = _positionAmounts(tokenId);
            uint256 supply = totalSupply();
            uint128 liquidityToRemove = shares == supply
                ? liquidity
                : uint128(Math.mulDiv(liquidity, shares, supply, Math.Rounding.Ceil));
            require(liquidityToRemove > 0 && liquidityToRemove <= liquidity, "LPVault: zero liquidity");
            _decreaseLiquidity(tokenId, liquidityToRemove, twapTick, block.timestamp);
            _collectAll(tokenId);

            uint256 pairedBalance = pairedToken.balanceOf(address(this));
            if (pairedBalance > 0) _swap(address(pairedToken), asset(), pairedBalance, twapTick);
            if (liquidityToRemove == liquidity) {
                (uint128 remaining, uint128 owed0, uint128 owed1) = _positionAmounts(tokenId);
                if (remaining == 0 && owed0 == 0 && owed1 == 0) {
                    positionManager.burn(tokenId);
                    positionTokenId = 0;
                }
            }
        }
        require(IERC20(asset()).balanceOf(address(this)) >= assets, "LPVault: insufficient USDC");
        super._withdraw(caller, receiver, shareOwner, assets, shares);
    }

    function _decreaseLiquidity(uint256 tokenId, uint128 liquidity, int24 twapTick, uint256 deadline) private {
        (uint256 amount0Expected, uint256 amount1Expected) = TeepV3Math.getAmountsForLiquidity(
            TeepV3Math.getSqrtRatioAtTick(twapTick),
            TeepV3Math.getSqrtRatioAtTick(tickLower),
            TeepV3Math.getSqrtRatioAtTick(tickUpper),
            liquidity
        );
        (uint256 amount0, uint256 amount1) = positionManager.decreaseLiquidity(
            ISoulessV3PositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: liquidity,
                amount0Min: _applyBps(amount0Expected, BPS_DENOMINATOR - maxSlippageBps),
                amount1Min: _applyBps(amount1Expected, BPS_DENOMINATOR - maxSlippageBps),
                deadline: deadline
            })
        );
        emit LiquidityRemoved(tokenId, liquidity, amount0, amount1);
    }

    function _collectAll(uint256 tokenId) private returns (uint256 amount0, uint256 amount1) {
        uint256 balance0Before = IERC20(token0).balanceOf(address(this));
        uint256 balance1Before = IERC20(token1).balanceOf(address(this));
        (amount0, amount1) = positionManager.collect(
            ISoulessV3PositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        require(
            IERC20(token0).balanceOf(address(this)) - balance0Before == amount0 &&
                IERC20(token1).balanceOf(address(this)) - balance1Before == amount1,
            "LPVault: collect mismatch"
        );
    }

    function _swap(address tokenIn, address tokenOut, uint256 amountIn, int24 twapTick)
        private
        returns (uint256 amountOut)
    {
        require(amountIn > 0 && amountIn <= type(uint128).max, "LPVault: invalid swap amount");
        uint256 quote = TeepV3Math.quoteAtTick(twapTick, uint128(amountIn), tokenIn, tokenOut);
        uint256 minimumOut = _applyBps(quote, BPS_DENOMINATOR - maxSlippageBps);
        require(minimumOut > 0, "LPVault: zero quote");
        uint256 outputBefore = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(address(swapRouter), amountIn);
        uint256 reported = swapRouter.exactInputSingle(
            ISoulessV3SwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minimumOut,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(tokenIn).forceApprove(address(swapRouter), 0);
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - outputBefore;
        require(amountOut == reported && amountOut >= minimumOut, "LPVault: swap mismatch");
    }

    function _liquidityMinimums(int24 twapTick, uint256 amount0Desired, uint256 amount1Desired)
        private
        view
        returns (uint256 amount0Min, uint256 amount1Min)
    {
        uint160 sqrtPrice = TeepV3Math.getSqrtRatioAtTick(twapTick);
        uint160 sqrtLower = TeepV3Math.getSqrtRatioAtTick(tickLower);
        uint160 sqrtUpper = TeepV3Math.getSqrtRatioAtTick(tickUpper);
        uint128 expectedLiquidity = TeepV3Math.getLiquidityForAmounts(
            sqrtPrice,
            sqrtLower,
            sqrtUpper,
            amount0Desired,
            amount1Desired
        );
        require(expectedLiquidity > 0, "LPVault: zero expected liquidity");
        (uint256 amount0Expected, uint256 amount1Expected) = TeepV3Math.getAmountsForLiquidity(
            sqrtPrice,
            sqrtLower,
            sqrtUpper,
            expectedLiquidity
        );
        amount0Min = _applyBps(amount0Expected, BPS_DENOMINATOR - maxSlippageBps);
        amount1Min = _applyBps(amount1Expected, BPS_DENOMINATOR - maxSlippageBps);
    }

    function _requireSafeMarket() private view returns (int24 twapTick) {
        twapTick = TeepV3Math.consult(address(pool), twapWindow);
        (, int24 spotTick,,,,, bool unlocked) = pool.slot0();
        require(unlocked, "LPVault: pool locked");
        uint256 difference = spotTick >= twapTick
            ? uint256(int256(spotTick) - int256(twapTick))
            : uint256(int256(twapTick) - int256(spotTick));
        require(difference <= maxTwapDeviationTicks, "LPVault: price deviation");
    }

    function _quotePairedToUsdc(uint256 amount, int24 twapTick) private view returns (uint256) {
        if (amount == 0) return 0;
        require(amount <= type(uint128).max, "LPVault: paired balance too large");
        return TeepV3Math.quoteAtTick(twapTick, uint128(amount), address(pairedToken), asset());
    }

    function _positionAmounts(uint256 tokenId)
        private
        view
        returns (uint128 liquidity, uint128 tokensOwed0, uint128 tokensOwed1)
    {
        address positionToken0;
        address positionToken1;
        uint24 positionFee;
        int24 positionLower;
        int24 positionUpper;
        (,, positionToken0, positionToken1, positionFee, positionLower, positionUpper, liquidity,,, tokensOwed0, tokensOwed1) =
            positionManager.positions(tokenId);
        require(
            positionToken0 == token0 &&
                positionToken1 == token1 &&
                positionFee == poolFee &&
                positionLower == tickLower &&
                positionUpper == tickUpper,
            "LPVault: position mismatch"
        );
    }

    function _applyBps(uint256 amount, uint256 bps) private pure returns (uint256) {
        return Math.mulDiv(amount, bps, BPS_DENOMINATOR);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(from == address(0) || to == address(0), "LPVault: shares non-transferable");
        super._update(from, to, value);
    }
}

// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "../interfaces/ISoulessV3.sol";
import "../libraries/TeepV3Math.sol";
import "../libraries/SoulessV3RangePolicy.sol";

contract MockTeepV3MathHarness {
    function sqrtRatioAtTick(int24 tick) external pure returns (uint160) {
        return TeepV3Math.getSqrtRatioAtTick(tick);
    }
}

contract MockSoulessV3RangePolicyHarness {
    function ticks(uint8 template, int24 referenceTick, int24 spacing)
        external
        pure
        returns (int24 lower, int24 upper)
    {
        require(template <= uint8(SoulessV3RangePolicy.RangeTemplate.UNLIMITED), "Harness: invalid template");
        return SoulessV3RangePolicy.ticks(
            SoulessV3RangePolicy.RangeTemplate(template),
            referenceTick,
            spacing
        );
    }

    function multiplier(uint8 template) external pure returns (uint16) {
        require(template <= uint8(SoulessV3RangePolicy.RangeTemplate.UNLIMITED), "Harness: invalid template");
        return SoulessV3RangePolicy.multiplier(SoulessV3RangePolicy.RangeTemplate(template));
    }
}

contract MockSoulessV3Factory is ISoulessV3Factory {
    mapping(bytes32 => address) private pools;

    function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
        pools[_key(tokenA, tokenB, fee)] = pool;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return pools[_key(tokenA, tokenB, fee)];
    }

    function feeAmountTickSpacing(uint24 fee) external pure returns (int24) {
        return fee == 3_000 ? int24(60) : int24(0);
    }

    function _key(address tokenA, address tokenB, uint24 fee) private pure returns (bytes32) {
        (address first, address second) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(first, second, fee));
    }
}

contract MockSoulessV3Pool is ISoulessV3Pool {
    address public immutable override token0;
    address public immutable override token1;
    uint24 public immutable override fee;
    int24 public immutable override tickSpacing;
    int24 public spotTick;
    int24 public twapTick;
    bool public unlocked = true;
    uint16 public observationCardinality = 16;
    uint16 public observationCardinalityNext = 16;

    constructor(address tokenA, address tokenB, uint24 _fee, int24 _tickSpacing) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        fee = _fee;
        tickSpacing = _tickSpacing;
    }

    function setTicks(int24 newSpotTick, int24 newTwapTick) external {
        spotTick = newSpotTick;
        twapTick = newTwapTick;
    }

    function setUnlocked(bool value) external {
        unlocked = value;
    }

    function setObservationCardinality(uint16 current, uint16 next) external {
        observationCardinality = current;
        observationCardinalityNext = next;
    }

    function increaseObservationCardinalityNext(uint16 next) external {
        if (next > observationCardinalityNext) observationCardinalityNext = next;
    }

    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        return (
            TeepV3Math.getSqrtRatioAtTick(spotTick),
            spotTick,
            0,
            observationCardinality,
            observationCardinalityNext,
            0,
            unlocked
        );
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            tickCumulatives[i] = int56(twapTick) * int56(uint56(block.timestamp - secondsAgos[i]));
        }
    }
}

contract MockSoulessV3PositionManager is ERC721, ISoulessV3PositionManager {
    using SafeERC20 for IERC20;

    struct Position {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    address public immutable override factory;
    ISoulessV3Pool public immutable pool;
    uint256 private nextTokenId = 1;
    mapping(uint256 => Position) private positionData;

    constructor(address _factory, address _pool) ERC721("Mock V3 Position", "MV3P") {
        factory = _factory;
        pool = ISoulessV3Pool(_pool);
    }

    function ownerOf(uint256 tokenId)
        public
        view
        override(ERC721, ISoulessV3PositionManager)
        returns (address)
    {
        return super.ownerOf(tokenId);
    }

    function positions(uint256 tokenId)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)
    {
        Position memory position = positionData[tokenId];
        return (
            0,
            address(0),
            position.token0,
            position.token1,
            position.fee,
            position.tickLower,
            position.tickUpper,
            position.liquidity,
            0,
            0,
            position.tokensOwed0,
            position.tokensOwed1
        );
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        require(block.timestamp <= params.deadline, "MockV3: expired");
        require(params.token0 == pool.token0() && params.token1 == pool.token1(), "MockV3: assets");
        (liquidity, amount0, amount1) = _amounts(
            params.tickLower,
            params.tickUpper,
            params.amount0Desired,
            params.amount1Desired
        );
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "MockV3: minimum");
        _take(params.token0, amount0);
        _take(params.token1, amount1);
        tokenId = nextTokenId++;
        positionData[tokenId] = Position({
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            tokensOwed0: 0,
            tokensOwed1: 0
        });
        _safeMint(params.recipient, tokenId);
    }

    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        require(_isAuthorized(ownerOf(params.tokenId), msg.sender, params.tokenId), "MockV3: unauthorized");
        Position storage position = positionData[params.tokenId];
        (liquidity, amount0, amount1) = _amounts(
            position.tickLower,
            position.tickUpper,
            params.amount0Desired,
            params.amount1Desired
        );
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "MockV3: minimum");
        _take(position.token0, amount0);
        _take(position.token1, amount1);
        position.liquidity += liquidity;
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        require(block.timestamp <= params.deadline, "MockV3: expired");
        require(_isAuthorized(ownerOf(params.tokenId), msg.sender, params.tokenId), "MockV3: unauthorized");
        Position storage position = positionData[params.tokenId];
        require(params.liquidity <= position.liquidity, "MockV3: liquidity");
        (uint160 sqrtPrice,,,,,,) = pool.slot0();
        (amount0, amount1) = TeepV3Math.getAmountsForLiquidity(
            sqrtPrice,
            TeepV3Math.getSqrtRatioAtTick(position.tickLower),
            TeepV3Math.getSqrtRatioAtTick(position.tickUpper),
            params.liquidity
        );
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "MockV3: minimum");
        position.liquidity -= params.liquidity;
        position.tokensOwed0 += uint128(amount0);
        position.tokensOwed1 += uint128(amount1);
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1) {
        require(_isAuthorized(ownerOf(params.tokenId), msg.sender, params.tokenId), "MockV3: unauthorized");
        Position storage position = positionData[params.tokenId];
        amount0 = Math.min(position.tokensOwed0, params.amount0Max);
        amount1 = Math.min(position.tokensOwed1, params.amount1Max);
        position.tokensOwed0 -= uint128(amount0);
        position.tokensOwed1 -= uint128(amount1);
        if (amount0 > 0) IERC20(position.token0).safeTransfer(params.recipient, amount0);
        if (amount1 > 0) IERC20(position.token1).safeTransfer(params.recipient, amount1);
    }

    function seedFees(uint256 tokenId, uint128 amount0, uint128 amount1) external {
        Position storage position = positionData[tokenId];
        _take(position.token0, amount0);
        _take(position.token1, amount1);
        position.tokensOwed0 += amount0;
        position.tokensOwed1 += amount1;
    }

    function burn(uint256 tokenId) external payable {
        require(_isAuthorized(ownerOf(tokenId), msg.sender, tokenId), "MockV3: unauthorized");
        Position memory position = positionData[tokenId];
        require(position.liquidity == 0 && position.tokensOwed0 == 0 && position.tokensOwed1 == 0, "MockV3: not empty");
        delete positionData[tokenId];
        _burn(tokenId);
    }

    function _amounts(int24 lower, int24 upper, uint256 desired0, uint256 desired1)
        private
        view
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        (uint160 sqrtPrice,,,,,,) = pool.slot0();
        uint160 sqrtLower = TeepV3Math.getSqrtRatioAtTick(lower);
        uint160 sqrtUpper = TeepV3Math.getSqrtRatioAtTick(upper);
        liquidity = TeepV3Math.getLiquidityForAmounts(sqrtPrice, sqrtLower, sqrtUpper, desired0, desired1);
        (amount0, amount1) = TeepV3Math.getAmountsForLiquidity(sqrtPrice, sqrtLower, sqrtUpper, liquidity);
    }

    function _take(address token, uint256 amount) private {
        if (amount > 0) IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }
}

contract MockSoulessV3Router is ISoulessV3SwapRouter {
    using SafeERC20 for IERC20;

    ISoulessV3Pool public immutable pool;
    uint16 public executionLossBps;

    constructor(address _pool) {
        pool = ISoulessV3Pool(_pool);
    }

    function setExecutionLossBps(uint16 lossBps) external {
        require(lossBps <= 2_000, "MockRouter: loss too high");
        executionLossBps = lossBps;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        require(params.fee == pool.fee(), "MockRouter: fee");
        (, int24 tick,,,,,) = pool.slot0();
        uint256 quote = TeepV3Math.quoteAtTick(tick, uint128(params.amountIn), params.tokenIn, params.tokenOut);
        amountOut = Math.mulDiv(quote, 10_000 - executionLossBps, 10_000);
        require(amountOut >= params.amountOutMinimum, "MockRouter: slippage");
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }
}

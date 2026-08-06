// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "../interfaces/ISoulessV3.sol";

/**
 * @notice Minimal Uniswap v3 tick, oracle and liquidity math used by Teep.
 *         Tick constants/algorithm follow Uniswap v3-core TickMath; liquidity
 *         formulas follow v3-periphery LiquidityAmounts.
 */
library TeepV3Math {
    uint256 internal constant Q96 = 0x1000000000000000000000000;
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        require(absTick <= uint256(uint24(MAX_TICK)), "V3Math: tick out of range");
        uint256 ratio = absTick & 0x1 != 0
            ? 0xfffcb933bd6fad37aa2d162d1a594001
            : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;
        if (tick > 0) ratio = type(uint256).max / ratio;
        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }

    function consult(address pool, uint32 secondsAgo) internal view returns (int24 arithmeticMeanTick) {
        require(secondsAgo > 0, "V3Math: zero window");
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = secondsAgo;
        (int56[] memory tickCumulatives,) = ISoulessV3Pool(pool).observe(secondsAgos);
        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        arithmeticMeanTick = int24(delta / int56(uint56(secondsAgo)));
        if (delta < 0 && delta % int56(uint56(secondsAgo)) != 0) arithmeticMeanTick--;
    }

    function quoteAtTick(
        int24 tick,
        uint128 baseAmount,
        address baseToken,
        address quoteToken
    ) internal pure returns (uint256 quoteAmount) {
        uint160 sqrtRatioX96 = getSqrtRatioAtTick(tick);
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            return baseToken < quoteToken
                ? Math.mulDiv(ratioX192, baseAmount, 1 << 192)
                : Math.mulDiv(1 << 192, baseAmount, ratioX192);
        }
        uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
        return baseToken < quoteToken
            ? Math.mulDiv(ratioX128, baseAmount, 1 << 128)
            : Math.mulDiv(1 << 128, baseAmount, ratioX128);
    }

    function getLiquidityForAmounts(
        uint160 sqrtRatioX96,
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint256 amount0,
        uint256 amount1
    ) internal pure returns (uint128 liquidity) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        if (sqrtRatioX96 <= sqrtRatioAX96) return _liquidityForAmount0(sqrtRatioAX96, sqrtRatioBX96, amount0);
        if (sqrtRatioX96 >= sqrtRatioBX96) return _liquidityForAmount1(sqrtRatioAX96, sqrtRatioBX96, amount1);
        uint128 liquidity0 = _liquidityForAmount0(sqrtRatioX96, sqrtRatioBX96, amount0);
        uint128 liquidity1 = _liquidityForAmount1(sqrtRatioAX96, sqrtRatioX96, amount1);
        return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
    }

    function getAmountsForLiquidity(
        uint160 sqrtRatioX96,
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint128 liquidity
    ) internal pure returns (uint256 amount0, uint256 amount1) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        if (sqrtRatioX96 <= sqrtRatioAX96) return (_amount0(sqrtRatioAX96, sqrtRatioBX96, liquidity), 0);
        if (sqrtRatioX96 >= sqrtRatioBX96) return (0, _amount1(sqrtRatioAX96, sqrtRatioBX96, liquidity));
        amount0 = _amount0(sqrtRatioX96, sqrtRatioBX96, liquidity);
        amount1 = _amount1(sqrtRatioAX96, sqrtRatioX96, liquidity);
    }

    function _liquidityForAmount0(uint160 a, uint160 b, uint256 amount0) private pure returns (uint128) {
        uint256 intermediate = Math.mulDiv(a, b, Q96);
        uint256 value = Math.mulDiv(amount0, intermediate, b - a);
        require(value <= type(uint128).max, "V3Math: liquidity overflow");
        return uint128(value);
    }

    function _liquidityForAmount1(uint160 a, uint160 b, uint256 amount1) private pure returns (uint128) {
        uint256 value = Math.mulDiv(amount1, Q96, b - a);
        require(value <= type(uint128).max, "V3Math: liquidity overflow");
        return uint128(value);
    }

    function _amount0(uint160 a, uint160 b, uint128 liquidity) private pure returns (uint256) {
        return Math.mulDiv(uint256(liquidity) << 96, b - a, b) / a;
    }

    function _amount1(uint160 a, uint160 b, uint128 liquidity) private pure returns (uint256) {
        return Math.mulDiv(liquidity, b - a, Q96);
    }
}

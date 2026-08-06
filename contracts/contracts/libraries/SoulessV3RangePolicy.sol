// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SoulessV3RangePolicy
 * @notice Reusable, named price-width presets. A multiplier N means the
 *         immutable range covers referencePrice / N through referencePrice * N.
 */
library SoulessV3RangePolicy {
    int24 internal constant MIN_TICK = -887_272;
    int24 internal constant MAX_TICK = 887_272;

    // ceil(log(multiplier) / log(1.0001)); rounding outward preserves coverage.
    int24 internal constant BALANCED_TICK_DELTA = 23_028; // x10
    int24 internal constant GROWTH_TICK_DELTA = 32_191; // x25
    int24 internal constant VOLATILE_TICK_DELTA = 39_123; // x50

    enum RangeTemplate {
        BALANCED,
        GROWTH,
        VOLATILE,
        UNLIMITED
    }

    function multiplier(RangeTemplate template) internal pure returns (uint16) {
        if (template == RangeTemplate.BALANCED) return 10;
        if (template == RangeTemplate.GROWTH) return 25;
        if (template == RangeTemplate.VOLATILE) return 50;
        return 0; // Unlimited has no finite multiplier.
    }

    function ticks(RangeTemplate template, int24 referenceTick, int24 tickSpacing)
        internal
        pure
        returns (int24 tickLower, int24 tickUpper)
    {
        require(tickSpacing > 0, "RangePolicy: invalid spacing");
        int24 minimumUsableTick = _ceilToSpacing(MIN_TICK, tickSpacing);
        int24 maximumUsableTick = _floorToSpacing(MAX_TICK, tickSpacing);
        if (template == RangeTemplate.UNLIMITED) return (minimumUsableTick, maximumUsableTick);

        int24 delta = template == RangeTemplate.BALANCED
            ? BALANCED_TICK_DELTA
            : template == RangeTemplate.GROWTH
                ? GROWTH_TICK_DELTA
                : VOLATILE_TICK_DELTA;

        int256 rawLower = int256(referenceTick) - int256(delta);
        int256 rawUpper = int256(referenceTick) + int256(delta);
        tickLower = rawLower <= minimumUsableTick
            ? minimumUsableTick
            : _floorToSpacing(int24(rawLower), tickSpacing);
        tickUpper = rawUpper >= maximumUsableTick
            ? maximumUsableTick
            : _ceilToSpacing(int24(rawUpper), tickSpacing);
        require(tickLower < tickUpper, "RangePolicy: empty range");
    }

    function _floorToSpacing(int24 tick, int24 spacing) private pure returns (int24) {
        int24 compressed = tick / spacing;
        if (tick < 0 && tick % spacing != 0) compressed--;
        return compressed * spacing;
    }

    function _ceilToSpacing(int24 tick, int24 spacing) private pure returns (int24) {
        int24 compressed = tick / spacing;
        if (tick > 0 && tick % spacing != 0) compressed++;
        return compressed * spacing;
    }
}

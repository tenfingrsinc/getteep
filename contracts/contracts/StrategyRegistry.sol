// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IStrategyAdapter.sol";
import "./interfaces/IStrategyRegistry.sol";

/**
 * @title StrategyRegistry
 * @notice Timelocked allowlist for bounded Grow Tips adapters.
 *         Emergency disablement is immediate; exits remain adapter-level operations.
 */
contract StrategyRegistry is Ownable, IStrategyRegistry {
    address public immutable canonicalAsset;
    uint64 public immutable activationDelay;

    struct PendingStrategy {
        address adapter;
        uint256 maxPositionAssets;
        uint256 totalAssetsCap;
        uint64 activateAfter;
        string label;
    }

    mapping(bytes32 => Strategy) private strategies;
    mapping(bytes32 => PendingStrategy) private pendingStrategies;
    bytes32[] private strategyIds;

    event StrategyProposed(
        bytes32 indexed strategyId,
        address indexed adapter,
        uint64 activateAfter,
        uint256 maxPositionAssets,
        uint256 totalAssetsCap,
        string label
    );
    event StrategyProposalCancelled(bytes32 indexed strategyId);
    event StrategyActivated(
        bytes32 indexed strategyId,
        address indexed adapter,
        address indexed asset,
        address positionToken,
        uint256 maxPositionAssets,
        uint256 totalAssetsCap,
        string label
    );
    event StrategyEnabledUpdated(bytes32 indexed strategyId, bool enabled);
    event StrategyEmergencyDisabled(bytes32 indexed strategyId, bool emergencyDisabled);

    constructor(address _canonicalAsset, uint64 _activationDelay) Ownable(msg.sender) {
        require(_canonicalAsset != address(0), "Registry: zero asset");
        canonicalAsset = _canonicalAsset;
        activationDelay = _activationDelay;
    }

    function proposeStrategy(
        bytes32 strategyId,
        address adapter,
        string calldata label,
        uint256 maxPositionAssets,
        uint256 totalAssetsCap
    ) external onlyOwner {
        require(strategyId != bytes32(0), "Registry: zero strategy");
        require(adapter != address(0), "Registry: zero adapter");
        require(strategies[strategyId].adapter == address(0), "Registry: strategy exists");
        require(IStrategyAdapter(adapter).strategyId() == strategyId, "Registry: strategy mismatch");
        require(IStrategyAdapter(adapter).asset() == canonicalAsset, "Registry: non-canonical asset");
        require(IStrategyAdapter(adapter).positionToken() != address(0), "Registry: zero position token");
        require(maxPositionAssets > 0, "Registry: zero position cap");
        require(totalAssetsCap >= maxPositionAssets, "Registry: invalid total cap");

        uint64 activateAfter = uint64(block.timestamp) + activationDelay;
        pendingStrategies[strategyId] = PendingStrategy({
            adapter: adapter,
            maxPositionAssets: maxPositionAssets,
            totalAssetsCap: totalAssetsCap,
            activateAfter: activateAfter,
            label: label
        });
        emit StrategyProposed(strategyId, adapter, activateAfter, maxPositionAssets, totalAssetsCap, label);
    }

    function cancelStrategyProposal(bytes32 strategyId) external onlyOwner {
        require(pendingStrategies[strategyId].adapter != address(0), "Registry: no proposal");
        delete pendingStrategies[strategyId];
        emit StrategyProposalCancelled(strategyId);
    }

    function activateStrategy(bytes32 strategyId) external {
        PendingStrategy memory pending = pendingStrategies[strategyId];
        require(pending.adapter != address(0), "Registry: no proposal");
        require(block.timestamp >= pending.activateAfter, "Registry: activation pending");
        require(strategies[strategyId].adapter == address(0), "Registry: strategy exists");

        IStrategyAdapter adapter = IStrategyAdapter(pending.adapter);
        require(adapter.strategyId() == strategyId, "Registry: strategy changed");
        require(adapter.asset() == canonicalAsset, "Registry: asset changed");
        address adapterPositionToken = adapter.positionToken();
        require(adapterPositionToken != address(0), "Registry: zero position token");

        strategies[strategyId] = Strategy({
            adapter: pending.adapter,
            asset: canonicalAsset,
            positionToken: adapterPositionToken,
            enabled: true,
            emergencyDisabled: false,
            maxPositionAssets: pending.maxPositionAssets,
            totalAssetsCap: pending.totalAssetsCap,
            label: pending.label
        });
        strategyIds.push(strategyId);
        delete pendingStrategies[strategyId];

        emit StrategyActivated(
            strategyId,
            pending.adapter,
            canonicalAsset,
            adapterPositionToken,
            pending.maxPositionAssets,
            pending.totalAssetsCap,
            pending.label
        );
        emit StrategyEnabledUpdated(strategyId, true);
    }

    function setStrategyEnabled(bytes32 strategyId, bool enabled) external onlyOwner {
        Strategy storage strategy = _requireStrategy(strategyId);
        strategy.enabled = enabled;
        emit StrategyEnabledUpdated(strategyId, enabled);
    }

    function setStrategyEmergencyDisabled(bytes32 strategyId, bool emergencyDisabled) external onlyOwner {
        Strategy storage strategy = _requireStrategy(strategyId);
        strategy.emergencyDisabled = emergencyDisabled;
        emit StrategyEmergencyDisabled(strategyId, emergencyDisabled);
    }

    function isStrategyAvailable(bytes32 strategyId) external view returns (bool) {
        Strategy storage strategy = strategies[strategyId];
        return strategy.adapter != address(0) && strategy.enabled && !strategy.emergencyDisabled;
    }

    function getStrategy(bytes32 strategyId) external view returns (Strategy memory) {
        require(strategies[strategyId].adapter != address(0), "Registry: unknown strategy");
        return strategies[strategyId];
    }

    function getPendingStrategy(bytes32 strategyId) external view returns (PendingStrategy memory) {
        return pendingStrategies[strategyId];
    }

    function getStrategyIds() external view returns (bytes32[] memory) {
        return strategyIds;
    }

    function strategyCount() external view returns (uint256) {
        return strategyIds.length;
    }

    function _requireStrategy(bytes32 strategyId) private view returns (Strategy storage strategy) {
        strategy = strategies[strategyId];
        require(strategy.adapter != address(0), "Registry: unknown strategy");
    }
}

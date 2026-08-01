// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IFeePolicy.sol";

/**
 * @title FeePolicy
 * @notice Versioned fee configuration for revised ClaimWallets and Grow Tips.
 *         Allocation and Grow Tips exit fees are deliberately absent: both are zero.
 */
contract FeePolicy is Ownable, IFeePolicy {
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_WITHDRAWAL_FEE_BPS = 2_000; // 20% governance safety cap
    uint16 public constant MAX_PERFORMANCE_FEE_BPS = 3_000; // 30% governance safety cap
    uint8 public constant MAX_WITHDRAWAL_TIERS = 16;

    struct WithdrawalTier {
        uint256 minimumAmount;
        uint16 feeBps;
    }

    uint16 public globalWithdrawalFeeBps;
    uint16 public defaultPerformanceFeeBps;
    uint64 public policyVersion;
    uint64 public immutable changeDelay;

    WithdrawalTier[] private withdrawalTiers;
    mapping(bytes32 => uint16) private strategyPerformanceFeeBps;
    mapping(bytes32 => bool) private strategyPerformanceFeeSet;
    mapping(bytes32 => uint64) public scheduledChanges;

    event GlobalWithdrawalFeeUpdated(uint16 feeBps, uint64 indexed policyVersion);
    event WithdrawalTiersUpdated(uint256 tierCount, uint64 indexed policyVersion);
    event DefaultPerformanceFeeUpdated(uint16 feeBps, uint64 indexed policyVersion);
    event StrategyPerformanceFeeUpdated(bytes32 indexed strategyId, uint16 feeBps, bool usesDefault, uint64 indexed policyVersion);
    event ChangeScheduled(bytes32 indexed changeId, uint64 executeAfter);
    event ChangeCancelled(bytes32 indexed changeId);

    constructor(uint16 _withdrawalFeeBps, uint16 _performanceFeeBps, address _owner, uint64 _changeDelay) Ownable(_owner) {
        require(_owner != address(0), "FeePolicy: zero owner");
        _requireWithdrawalFee(_withdrawalFeeBps);
        _requirePerformanceFee(_performanceFeeBps);
        globalWithdrawalFeeBps = _withdrawalFeeBps;
        defaultPerformanceFeeBps = _performanceFeeBps;
        policyVersion = 1;
        changeDelay = _changeDelay;
    }

    function scheduleChange(bytes32 changeId) external onlyOwner {
        require(changeId != bytes32(0), "FeePolicy: zero change");
        uint64 executeAfter = uint64(block.timestamp) + changeDelay;
        scheduledChanges[changeId] = executeAfter;
        emit ChangeScheduled(changeId, executeAfter);
    }

    function cancelChange(bytes32 changeId) external onlyOwner {
        require(scheduledChanges[changeId] != 0, "FeePolicy: change not scheduled");
        delete scheduledChanges[changeId];
        emit ChangeCancelled(changeId);
    }

    function setGlobalWithdrawalFeeBps(uint16 feeBps) external onlyOwner {
        _requireWithdrawalFee(feeBps);
        _consumeChange(keccak256(abi.encode("SET_GLOBAL_WITHDRAWAL_FEE", feeBps)));
        globalWithdrawalFeeBps = feeBps;
        delete withdrawalTiers;
        uint64 version = _bumpVersion();
        emit GlobalWithdrawalFeeUpdated(feeBps, version);
        emit WithdrawalTiersUpdated(0, version);
    }

    /**
     * @notice Configure amount tiers. Thresholds must be strictly increasing.
     *         The fee for the highest threshold not exceeding `amount` is used;
     *         amounts below the first threshold use the global fee.
     */
    function setWithdrawalTiers(uint256[] calldata minimumAmounts, uint16[] calldata feeBpsValues) external onlyOwner {
        require(minimumAmounts.length == feeBpsValues.length, "FeePolicy: length mismatch");
        require(minimumAmounts.length <= MAX_WITHDRAWAL_TIERS, "FeePolicy: too many tiers");
        _consumeChange(keccak256(abi.encode("SET_WITHDRAWAL_TIERS", minimumAmounts, feeBpsValues)));

        delete withdrawalTiers;
        uint256 previous;
        for (uint256 i = 0; i < minimumAmounts.length; i++) {
            require(i == 0 || minimumAmounts[i] > previous, "FeePolicy: tiers not sorted");
            _requireWithdrawalFee(feeBpsValues[i]);
            withdrawalTiers.push(WithdrawalTier(minimumAmounts[i], feeBpsValues[i]));
            previous = minimumAmounts[i];
        }

        emit WithdrawalTiersUpdated(minimumAmounts.length, _bumpVersion());
    }

    function setDefaultPerformanceFeeBps(uint16 feeBps) external onlyOwner {
        _requirePerformanceFee(feeBps);
        _consumeChange(keccak256(abi.encode("SET_DEFAULT_PERFORMANCE_FEE", feeBps)));
        defaultPerformanceFeeBps = feeBps;
        emit DefaultPerformanceFeeUpdated(feeBps, _bumpVersion());
    }

    function setStrategyPerformanceFeeBps(bytes32 strategyId, uint16 feeBps) external onlyOwner {
        require(strategyId != bytes32(0), "FeePolicy: zero strategy");
        _requirePerformanceFee(feeBps);
        _consumeChange(keccak256(abi.encode("SET_STRATEGY_PERFORMANCE_FEE", strategyId, feeBps)));
        strategyPerformanceFeeBps[strategyId] = feeBps;
        strategyPerformanceFeeSet[strategyId] = true;
        emit StrategyPerformanceFeeUpdated(strategyId, feeBps, false, _bumpVersion());
    }

    function clearStrategyPerformanceFee(bytes32 strategyId) external onlyOwner {
        require(strategyId != bytes32(0), "FeePolicy: zero strategy");
        _consumeChange(keccak256(abi.encode("CLEAR_STRATEGY_PERFORMANCE_FEE", strategyId)));
        delete strategyPerformanceFeeBps[strategyId];
        delete strategyPerformanceFeeSet[strategyId];
        emit StrategyPerformanceFeeUpdated(strategyId, defaultPerformanceFeeBps, true, _bumpVersion());
    }

    function withdrawalFeeBps(address, address, uint256 amount) external view returns (uint16 feeBps) {
        feeBps = globalWithdrawalFeeBps;
        for (uint256 i = 0; i < withdrawalTiers.length; i++) {
            if (amount < withdrawalTiers[i].minimumAmount) break;
            feeBps = withdrawalTiers[i].feeBps;
        }
    }

    function performanceFeeBps(bytes32 strategyId) public view returns (uint16) {
        return strategyPerformanceFeeSet[strategyId]
            ? strategyPerformanceFeeBps[strategyId]
            : defaultPerformanceFeeBps;
    }

    function getWithdrawalTiers() external view returns (WithdrawalTier[] memory) {
        return withdrawalTiers;
    }

    function _bumpVersion() private returns (uint64) {
        policyVersion += 1;
        return policyVersion;
    }

    function _consumeChange(bytes32 changeId) private {
        if (changeDelay == 0) return;
        uint64 executeAfter = scheduledChanges[changeId];
        require(executeAfter != 0, "FeePolicy: change not scheduled");
        require(block.timestamp >= executeAfter, "FeePolicy: change delay active");
        delete scheduledChanges[changeId];
    }

    function _requireWithdrawalFee(uint16 feeBps) private pure {
        require(feeBps <= MAX_WITHDRAWAL_FEE_BPS, "FeePolicy: withdrawal fee too high");
    }

    function _requirePerformanceFee(uint16 feeBps) private pure {
        require(feeBps <= MAX_PERFORMANCE_FEE_BPS, "FeePolicy: performance fee too high");
    }
}

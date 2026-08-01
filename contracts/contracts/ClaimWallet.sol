// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "./IReferralRegistry.sol";
import "./interfaces/IFeePolicy.sol";
import "./interfaces/IStrategyAdapter.sol";
import "./interfaces/IStrategyRegistry.sol";

/**
 * @title ClaimWallet
 * @notice A minimal smart wallet for X creators to receive and withdraw USDC tips.
 *         Deployed deterministically via CREATE2 per authorId.
 *         Can receive USDC before deployment (funds go to the pre-computed address).
 */
contract ClaimWallet is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant WITHDRAWAL_AUTHORIZATION_TYPEHASH =
        keccak256("WithdrawalAuthorization(address owner,address token,address destination,uint256 amount,uint256 expiresAt,bytes32 nonce)");

    /// @notice Owner of this wallet (set during initialization)
    address public owner;

    /// @notice The X author ID this wallet belongs to
    uint256 public authorId;

    /// @notice Whether this wallet has been initialized
    bool public initialized;

    /// @notice The factory that deployed this wallet
    address public immutable factory;

    /// @notice Referral/fee registry; set once by factory before withdrawals are enabled.
    address public referralRegistry;

    /// @notice Backend signer for non-owner withdrawal destinations.
    address public withdrawalSigner;

    /// @notice Revised withdrawal and Grow Tips performance-fee policy.
    address public feePolicy;

    /// @notice Allowlist of Grow Tips strategy adapters.
    address public strategyRegistry;

    struct GrowPosition {
        bytes32 strategyId;
        uint256 remainingPrincipal;
        uint256 remainingShares;
        uint256 realizedYield;
        uint256 performanceFeesPaid;
        uint64 createdAt;
        bool active;
    }

    uint256 public nextPositionId = 1;
    mapping(uint256 => GrowPosition) public growPositions;

    /// @notice Used authorization nonces to prevent replay.
    mapping(bytes32 => bool) public usedWithdrawalNonces;

    event OwnershipClaimed(uint256 indexed authorId, address indexed owner);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event WithdrawalWithFee(
        address indexed token,
        address indexed destination,
        uint256 netAmount,
        uint256 protocolAmount,
        uint256 referrerAmount,
        address indexed treasury,
        address referrer
    );
    event ProtocolFeePaid(address indexed treasury, address indexed token, uint256 amount);
    event ReferralFeePaid(address indexed referrer, address indexed token, uint256 amount);
    event WithdrawalSignerUpdated(address indexed signer);
    event WithdrawalAuthorizationUsed(bytes32 indexed nonce, address indexed destination, uint256 amount);
    event FeePolicySet(address indexed feePolicy);
    event StrategyRegistrySet(address indexed strategyRegistry);
    event StrategyAllocated(
        uint256 indexed positionId,
        bytes32 indexed strategyId,
        address indexed adapter,
        address asset,
        uint256 assets,
        uint256 shares
    );
    event StrategyExited(
        uint256 indexed positionId,
        bytes32 indexed strategyId,
        address indexed adapter,
        address asset,
        uint256 shares,
        uint256 principalReturned,
        uint256 grossAssets,
        uint256 realizedYield,
        uint256 performanceFee,
        uint256 netAssets
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "ClaimWallet: not owner");
        _;
    }

    modifier onlyFactory() {
        require(msg.sender == factory, "ClaimWallet: not factory");
        _;
    }

    constructor() ReentrancyGuard() EIP712("TeepClaimWallet", "1") {
        factory = msg.sender;
    }

    /**
     * @notice Initialize the wallet with an owner. Can only be called once by the factory.
     * @param _authorId The X author ID
     * @param _owner The address that will own this wallet
     */
    function initialize(uint256 _authorId, address _owner) external onlyFactory {
        require(!initialized, "ClaimWallet: already initialized");
        require(_owner != address(0), "ClaimWallet: zero owner");

        authorId = _authorId;
        owner = _owner;
        initialized = true;

        emit OwnershipClaimed(_authorId, _owner);
    }

    /**
     * @notice Set the referral registry. Can only be called once by the factory.
     */
    function setReferralRegistry(address _registry) external onlyFactory {
        require(referralRegistry == address(0), "ClaimWallet: registry already set");
        referralRegistry = _registry;
    }

    /**
     * @notice Set the signer that authorizes withdrawals to non-owner destinations.
     */
    function setWithdrawalSigner(address _signer) external onlyFactory {
        require(_signer != address(0), "ClaimWallet: zero signer");
        withdrawalSigner = _signer;
        emit WithdrawalSignerUpdated(_signer);
    }

    /**
     * @notice Set the configurable fee policy. Can only be called once by the factory.
     */
    function setFeePolicy(address _feePolicy) external onlyFactory {
        require(feePolicy == address(0), "ClaimWallet: fee policy already set");
        require(_feePolicy != address(0), "ClaimWallet: zero fee policy");
        feePolicy = _feePolicy;
        emit FeePolicySet(_feePolicy);
    }

    /**
     * @notice Set the Grow Tips strategy registry. Can only be called once by the factory.
     */
    function setStrategyRegistry(address _strategyRegistry) external onlyFactory {
        require(strategyRegistry == address(0), "ClaimWallet: strategy registry already set");
        require(_strategyRegistry != address(0), "ClaimWallet: zero strategy registry");
        strategyRegistry = _strategyRegistry;
        emit StrategyRegistrySet(_strategyRegistry);
    }

    /**
     * @notice Allocate Tips Earned to an approved Grow Tips strategy with no allocation fee.
     *         Position tokens remain in this ClaimWallet so principal and yield fees are enforceable.
     */
    function allocateToStrategy(
        bytes32 strategyId,
        uint256 assets,
        uint256 minShares,
        uint256 deadline,
        bytes calldata adapterData
    ) external onlyOwner nonReentrant returns (uint256 positionId, uint256 shares) {
        require(strategyRegistry != address(0), "ClaimWallet: strategy registry not set");
        require(assets > 0, "ClaimWallet: zero amount");
        require(block.timestamp <= deadline, "ClaimWallet: deadline expired");

        IStrategyRegistry registry = IStrategyRegistry(strategyRegistry);
        require(registry.isStrategyAvailable(strategyId), "ClaimWallet: strategy unavailable");
        IStrategyRegistry.Strategy memory strategy = registry.getStrategy(strategyId);
        require(assets <= strategy.maxPositionAssets, "ClaimWallet: position cap exceeded");
        require(IStrategyAdapter(strategy.adapter).totalManagedAssets() + assets <= strategy.totalAssetsCap, "ClaimWallet: total cap exceeded");

        uint256 sharesBefore = IERC20(strategy.positionToken).balanceOf(address(this));
        IERC20(strategy.asset).forceApprove(strategy.adapter, assets);
        shares = IStrategyAdapter(strategy.adapter).deposit(IStrategyAdapter.DepositParams({
            assets: assets,
            beneficiary: address(this),
            minShares: minShares,
            deadline: deadline,
            adapterData: adapterData
        }));
        IERC20(strategy.asset).forceApprove(strategy.adapter, 0);
        require(shares > 0 && shares >= minShares, "ClaimWallet: insufficient shares");
        require(IERC20(strategy.positionToken).balanceOf(address(this)) - sharesBefore == shares, "ClaimWallet: share mismatch");

        positionId = nextPositionId++;
        growPositions[positionId] = GrowPosition({
            strategyId: strategyId,
            remainingPrincipal: assets,
            remainingShares: shares,
            realizedYield: 0,
            performanceFeesPaid: 0,
            createdAt: uint64(block.timestamp),
            active: true
        });
        emit StrategyAllocated(positionId, strategyId, strategy.adapter, strategy.asset, assets, shares);
    }

    /**
     * @notice Exit part or all of a Grow Tips position back into this Tips Earned wallet.
     *         There is no exit fee. A configurable fee applies only to realized positive yield.
     */
    function exitStrategy(
        uint256 positionId,
        uint256 sharesToRedeem,
        uint256 minAssets,
        uint256 deadline,
        bytes calldata adapterData
    ) external onlyOwner nonReentrant returns (uint256 netAssets) {
        require(strategyRegistry != address(0), "ClaimWallet: strategy registry not set");
        require(feePolicy != address(0), "ClaimWallet: fee policy not set");
        require(block.timestamp <= deadline, "ClaimWallet: deadline expired");

        GrowPosition storage position = growPositions[positionId];
        require(position.active, "ClaimWallet: inactive position");
        require(sharesToRedeem > 0, "ClaimWallet: zero amount");

        IStrategyRegistry.Strategy memory strategy = IStrategyRegistry(strategyRegistry).getStrategy(position.strategyId);
        uint256 amountToRedeem = sharesToRedeem == type(uint256).max ? position.remainingShares : sharesToRedeem;
        require(amountToRedeem > 0 && amountToRedeem <= position.remainingShares, "ClaimWallet: insufficient position");

        uint256 principalReturned = amountToRedeem == position.remainingShares
            ? position.remainingPrincipal
            : (position.remainingPrincipal * amountToRedeem) / position.remainingShares;

        uint256 assetsBefore = IERC20(strategy.asset).balanceOf(address(this));
        IERC20(strategy.positionToken).forceApprove(strategy.adapter, amountToRedeem);
        uint256 reportedAssets = IStrategyAdapter(strategy.adapter).redeem(IStrategyAdapter.RedeemParams({
            shares: amountToRedeem,
            recipient: address(this),
            minAssets: minAssets,
            deadline: deadline,
            adapterData: adapterData
        }));
        IERC20(strategy.positionToken).forceApprove(strategy.adapter, 0);
        uint256 grossAssets = IERC20(strategy.asset).balanceOf(address(this)) - assetsBefore;
        require(grossAssets == reportedAssets && grossAssets >= minAssets, "ClaimWallet: asset mismatch");

        position.remainingPrincipal -= principalReturned;
        position.remainingShares -= amountToRedeem;
        uint256 realizedYield = grossAssets > principalReturned ? grossAssets - principalReturned : 0;
        uint256 performanceFee = (realizedYield * IFeePolicy(feePolicy).performanceFeeBps(position.strategyId)) / 10_000;
        netAssets = grossAssets - performanceFee;
        position.realizedYield += realizedYield;
        position.performanceFeesPaid += performanceFee;
        if (position.remainingShares == 0) position.active = false;

        address treasuryAddr = IReferralRegistry(referralRegistry).treasury();
        if (performanceFee > 0) {
            require(treasuryAddr != address(0), "ClaimWallet: zero treasury");
            IERC20(strategy.asset).safeTransfer(treasuryAddr, performanceFee);
        }

        emit StrategyExited(
            positionId,
            position.strategyId,
            strategy.adapter,
            strategy.asset,
            amountToRedeem,
            principalReturned,
            grossAssets,
            realizedYield,
            performanceFee,
            netAssets
        );
    }

    /**
     * @notice Withdraw ERC-20 tokens. Fee logic always applies through withdrawWithFee.
     *         Prevents bypass by calling withdraw() to avoid fees.
     */
    function withdraw(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        require(to != address(0), "ClaimWallet: zero recipient");
        require(to == owner, "ClaimWallet: destination authorization required");
        _withdrawWithFee(token, to, amount);
    }

    /**
     * @notice Withdraw with protocol fee and referrer split. User sees breakdown and agrees; contract auto-splits.
     */
    function withdrawWithFee(
        address token,
        address destination,
        uint256 amount
    ) external onlyOwner nonReentrant {
        require(destination != address(0), "ClaimWallet: zero recipient");
        require(destination == owner, "ClaimWallet: destination authorization required");
        _withdrawWithFee(token, destination, amount);
    }

    /**
     * @notice Withdraw to a non-owner destination after Teep-managed authorization.
     *         Owner-to-owner withdrawals remain permissionless through withdraw/withdrawWithFee.
     */
    function withdrawWithAuthorization(
        address token,
        address destination,
        uint256 amount,
        uint256 expiresAt,
        bytes32 nonce,
        bytes calldata signature
    ) external onlyOwner nonReentrant {
        require(destination != address(0), "ClaimWallet: zero recipient");
        _requireWithdrawalAuthorization(token, destination, amount, expiresAt, nonce, signature);
        _withdrawWithFee(token, destination, amount);
    }

    function _requireWithdrawalAuthorization(
        address token,
        address destination,
        uint256 amount,
        uint256 expiresAt,
        bytes32 nonce,
        bytes calldata signature
    ) internal {
        if (destination == owner) return;
        require(withdrawalSigner != address(0), "ClaimWallet: signer not set");
        require(block.timestamp <= expiresAt, "ClaimWallet: authorization expired");
        require(!usedWithdrawalNonces[nonce], "ClaimWallet: nonce used");

        bytes32 structHash = keccak256(
            abi.encode(WITHDRAWAL_AUTHORIZATION_TYPEHASH, owner, token, destination, amount, expiresAt, nonce)
        );
        address recovered = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        require(recovered == withdrawalSigner, "ClaimWallet: invalid authorization");

        usedWithdrawalNonces[nonce] = true;
        emit WithdrawalAuthorizationUsed(nonce, destination, amount);
    }

    /**
     * @dev Internal fee split. CEI: compute amounts and emit events first, then external transfers last.
     */
    function _withdrawWithFee(
        address token,
        address destination,
        uint256 amount
    ) internal {
        require(referralRegistry != address(0), "ClaimWallet: registry not set");

        uint256 net = amount;
        uint256 protocolAmount = 0;
        uint256 referrerAmount = 0;
        address treasuryAddr = address(0);
        address ref = address(0);

        IReferralRegistry reg = IReferralRegistry(referralRegistry);
        uint256 feeBps = feePolicy == address(0)
            ? reg.feeBps()
            : IFeePolicy(feePolicy).withdrawalFeeBps(owner, token, amount);
        uint256 fee = (amount * feeBps) / 10000;
        net = amount - fee;
        ref = reg.getReferrer(owner);
        uint256 referrerShareBps = reg.referrerShareBps();
        referrerAmount = (fee * referrerShareBps) / 10000;
        protocolAmount = fee - referrerAmount;
        treasuryAddr = reg.treasury();
        // When no referrer is set, send the referrer share to treasury (protocol gets full fee)
        if (ref == address(0) && referrerAmount > 0) {
            protocolAmount += referrerAmount;
            referrerAmount = 0;
        }

        // Effects and events (CEI)
        emit WithdrawalWithFee(token, destination, net, protocolAmount, referrerAmount, treasuryAddr, ref);
        if (protocolAmount > 0 && treasuryAddr != address(0)) {
            emit ProtocolFeePaid(treasuryAddr, token, protocolAmount);
        }
        if (referrerAmount > 0 && ref != address(0)) {
            emit ReferralFeePaid(ref, token, referrerAmount);
        }

        // Interactions last
        if (net > 0) {
            IERC20(token).safeTransfer(destination, net);
        }
        if (protocolAmount > 0 && treasuryAddr != address(0)) {
            IERC20(token).safeTransfer(treasuryAddr, protocolAmount);
        }
        if (referrerAmount > 0 && ref != address(0)) {
            IERC20(token).safeTransfer(ref, referrerAmount);
        }
    }

    /**
     * @notice Withdraw native ETH (in case any is sent by mistake)
     * @param to The recipient address
     * @param amount The amount to withdraw
     */
    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "ClaimWallet: zero recipient");
        require(to == owner, "ClaimWallet: destination authorization required");
        (bool success, ) = to.call{value: amount}("");
        require(success, "ClaimWallet: ETH transfer failed");
    }

    /// @notice Allow receiving ETH
    receive() external payable {}
}

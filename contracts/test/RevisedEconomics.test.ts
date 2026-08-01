import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("Revised ClaimWallet economics", function () {
  const STRATEGY_ID = ethers.keccak256(ethers.toUtf8Bytes("AAVE_V3_ARC_TESTNET_USDC"));

  async function fixture() {
    const [deployer, attestationSigner, creator, treasury, referrer] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    const MockAToken = await ethers.getContractFactory("MockAToken");
    const aToken = await MockAToken.deploy();
    const MockAavePool = await ethers.getContractFactory("MockAavePool");
    const pool = await MockAavePool.deploy(await usdc.getAddress(), await aToken.getAddress());
    await aToken.setPool(await pool.getAddress());

    const StrategyRegistry = await ethers.getContractFactory("StrategyRegistry");
    const strategyRegistry = await StrategyRegistry.deploy(await usdc.getAddress(), 0);
    const AaveV3SupplyAdapter = await ethers.getContractFactory("AaveV3SupplyAdapter");
    const adapter = await AaveV3SupplyAdapter.deploy(
      await strategyRegistry.getAddress(),
      await pool.getAddress(),
      STRATEGY_ID,
      await usdc.getAddress(),
      await aToken.getAddress(),
    );
    await strategyRegistry.proposeStrategy(
      STRATEGY_ID,
      await adapter.getAddress(),
      "Steady Growth",
      ethers.parseUnits("1000", 6),
      ethers.parseUnits("10000", 6),
    );
    await strategyRegistry.activateStrategy(STRATEGY_ID);

    const ReferralRegistry = await ethers.getContractFactory("ReferralRegistry");
    const referralRegistry = await ReferralRegistry.deploy(treasury.address, 500, 3000, attestationSigner.address);
    const FeePolicy = await ethers.getContractFactory("FeePolicy");
    const feePolicy = await FeePolicy.deploy(500, 1000, deployer.address, 0);

    const WalletFactory = await ethers.getContractFactory("WalletFactory");
    const factory = await WalletFactory.deploy(attestationSigner.address);
    await factory.setReferralRegistry(await referralRegistry.getAddress());
    await factory.setFeePolicy(await feePolicy.getAddress());
    await factory.setStrategyRegistry(await strategyRegistry.getAddress());

    const authorId = 4242n;
    const timestamp = BigInt(await time.latest());
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("revised-wallet-deployment"));
    const messageHash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "uint256", "bytes32"],
      [authorId, creator.address, timestamp, nonce],
    );
    const signature = await attestationSigner.signMessage(ethers.getBytes(messageHash));
    await factory.deployClaimWallet(authorId, creator.address, timestamp, nonce, signature);
    const walletAddress = await factory.computeClaimWallet(authorId);
    const wallet = await ethers.getContractAt("ClaimWallet", walletAddress);

    const strategyDeadline = BigInt(await time.latest()) + 3600n;
    return {
      deployer,
      creator,
      treasury,
      referrer,
      usdc,
      aToken,
      pool,
      adapter,
      feePolicy,
      referralRegistry,
      factory,
      wallet,
      walletAddress,
      strategyDeadline,
    };
  }

  it("uses configurable amount tiers for external Tips Earned withdrawals", async function () {
    const { creator, treasury, usdc, feePolicy, wallet, walletAddress } = await loadFixture(fixture);
    const amount = ethers.parseUnits("200", 6);
    await feePolicy.setWithdrawalTiers(
      [ethers.parseUnits("100", 6), ethers.parseUnits("1000", 6)],
      [400, 200],
    );
    await usdc.mint(walletAddress, amount);

    await wallet.connect(creator).withdrawWithFee(await usdc.getAddress(), creator.address, amount);

    expect(await usdc.balanceOf(creator.address)).to.equal(ethers.parseUnits("192", 6));
    expect(await usdc.balanceOf(treasury.address)).to.equal(ethers.parseUnits("8", 6));
  });

  it("allocates Tips Earned to an approved strategy without a deposit fee", async function () {
    const { creator, treasury, usdc, adapter, wallet, walletAddress, strategyDeadline } = await loadFixture(fixture);
    const amount = ethers.parseUnits("100", 6);
    await usdc.mint(walletAddress, amount);

    await expect(wallet.connect(creator).allocateToStrategy(STRATEGY_ID, amount, amount, strategyDeadline, "0x"))
      .to.emit(wallet, "StrategyAllocated");

    expect(await usdc.balanceOf(treasury.address)).to.equal(0);
    expect(await usdc.balanceOf(walletAddress)).to.equal(0);
    expect(await adapter.balanceOf(walletAddress)).to.equal(amount);
    const position = await wallet.growPositions(1);
    expect(position.remainingPrincipal).to.equal(amount);
    expect(position.remainingShares).to.equal(amount);
  });

  it("charges 10% only on realized positive yield and returns principal fee-free", async function () {
    const { creator, treasury, usdc, pool, adapter, wallet, walletAddress, strategyDeadline } = await loadFixture(fixture);
    const principal = ethers.parseUnits("100", 6);
    const yieldAmount = ethers.parseUnits("12", 6);
    await usdc.mint(walletAddress, principal);
    await wallet.connect(creator).allocateToStrategy(STRATEGY_ID, principal, principal, strategyDeadline, "0x");

    await usdc.mint(await pool.getAddress(), yieldAmount);
    await pool.accrueYield(await adapter.getAddress(), yieldAmount);
    await wallet.connect(creator).exitStrategy(1, ethers.MaxUint256, ethers.parseUnits("111", 6), strategyDeadline, "0x");

    expect(await usdc.balanceOf(creator.address)).to.equal(0);
    expect(await usdc.balanceOf(walletAddress)).to.equal(ethers.parseUnits("110.8", 6));
    expect(await usdc.balanceOf(treasury.address)).to.equal(ethers.parseUnits("1.2", 6));
    const position = await wallet.growPositions(1);
    expect(position.remainingPrincipal).to.equal(0);
    expect(position.active).to.equal(false);
  });

  it("charges no performance fee when a position has no profit", async function () {
    const { creator, treasury, usdc, wallet, walletAddress, strategyDeadline } = await loadFixture(fixture);
    const principal = ethers.parseUnits("100", 6);
    await usdc.mint(walletAddress, principal);
    await wallet.connect(creator).allocateToStrategy(STRATEGY_ID, principal, principal, strategyDeadline, "0x");

    await wallet.connect(creator).exitStrategy(1, ethers.MaxUint256, principal, strategyDeadline, "0x");

    expect(await usdc.balanceOf(creator.address)).to.equal(0);
    expect(await usdc.balanceOf(walletAddress)).to.equal(principal);
    expect(await usdc.balanceOf(treasury.address)).to.equal(0);
  });

  it("restricts fee changes and Grow Tips actions to their authorized owners", async function () {
    const { creator, feePolicy, wallet, strategyDeadline } = await loadFixture(fixture);
    await expect(feePolicy.connect(creator).setGlobalWithdrawalFeeBps(100))
      .to.be.revertedWithCustomError(feePolicy, "OwnableUnauthorizedAccount");
    await expect(wallet.allocateToStrategy(STRATEGY_ID, 1, 1, strategyDeadline, "0x"))
      .to.be.revertedWith("ClaimWallet: not owner");
  });

  it("can require fee changes to be scheduled before execution", async function () {
    const { deployer } = await loadFixture(fixture);
    const FeePolicy = await ethers.getContractFactory("FeePolicy");
    const delayedPolicy = await FeePolicy.deploy(500, 1000, deployer.address, 3600);
    const changeId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint16"], ["SET_GLOBAL_WITHDRAWAL_FEE", 300]),
    );
    await expect(delayedPolicy.setGlobalWithdrawalFeeBps(300)).to.be.revertedWith("FeePolicy: change not scheduled");
    await delayedPolicy.scheduleChange(changeId);
    await expect(delayedPolicy.setGlobalWithdrawalFeeBps(300)).to.be.revertedWith("FeePolicy: change delay active");
    await time.increase(3600);
    await delayedPolicy.setGlobalWithdrawalFeeBps(300);
    expect(await delayedPolicy.globalWithdrawalFeeBps()).to.equal(300);
  });

  it("cannot convert Grow Tips proceeds into fee-free Tip Balance", async function () {
    const { creator, treasury, usdc, wallet, walletAddress, strategyDeadline } = await loadFixture(fixture);
    const principal = ethers.parseUnits("100", 6);
    await usdc.mint(walletAddress, principal);
    await wallet.connect(creator).allocateToStrategy(STRATEGY_ID, principal, principal, strategyDeadline, "0x");
    await wallet.connect(creator).exitStrategy(1, ethers.MaxUint256, principal, strategyDeadline, "0x");

    expect(await usdc.balanceOf(creator.address)).to.equal(0);
    await wallet.connect(creator).withdrawWithFee(await usdc.getAddress(), creator.address, principal);
    expect(await usdc.balanceOf(creator.address)).to.equal(ethers.parseUnits("95", 6));
    expect(await usdc.balanceOf(treasury.address)).to.equal(ethers.parseUnits("5", 6));
  });
});

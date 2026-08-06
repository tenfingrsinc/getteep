import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("SoulessV3LPVault", function () {
  const STRATEGY_ID = ethers.keccak256(ethers.toUtf8Bytes("SOULESS_V3_USDC_TEST_V1"));
  const Q96 = 2n ** 96n;

  async function fixture() {
    const [deployer, user, other, attestationSigner, treasury] = await ethers.getSigners();
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    const paired = await MockUSDC.deploy();

    const Factory = await ethers.getContractFactory("MockSoulessV3Factory");
    const factory = await Factory.deploy();
    const Pool = await ethers.getContractFactory("MockSoulessV3Pool");
    const pool = await Pool.deploy(await usdc.getAddress(), await paired.getAddress(), 3000, 60);
    await factory.setPool(await usdc.getAddress(), await paired.getAddress(), 3000, await pool.getAddress());
    const PositionManager = await ethers.getContractFactory("MockSoulessV3PositionManager");
    const positionManager = await PositionManager.deploy(await factory.getAddress(), await pool.getAddress());
    const Router = await ethers.getContractFactory("MockSoulessV3Router");
    const router = await Router.deploy(await pool.getAddress());

    await usdc.mint(await router.getAddress(), ethers.parseUnits("1000000", 6));
    await paired.mint(await router.getAddress(), ethers.parseUnits("1000000", 6));

    const Vault = await ethers.getContractFactory("SoulessV3LPVault");
    const vaultConfig = {
      usdc: await usdc.getAddress(),
      pairedToken: await paired.getAddress(),
      factory: await factory.getAddress(),
      pool: await pool.getAddress(),
      positionManager: await positionManager.getAddress(),
      swapRouter: await router.getAddress(),
      poolFee: 3000,
      rangeTemplate: 1,
      twapWindow: 300,
      maxTwapDeviationTicks: 100,
      maxSlippageBps: 100,
      valuationHaircutBps: 150,
      owner: deployer.address,
    };
    const vault = await Vault.deploy(vaultConfig);

    const StrategyRegistry = await ethers.getContractFactory("StrategyRegistry");
    const registry = await StrategyRegistry.deploy(await usdc.getAddress(), 0);
    const Adapter = await ethers.getContractFactory("SoulessVaultAdapter");
    const adapter = await Adapter.deploy(
      await registry.getAddress(),
      await vault.getAddress(),
      STRATEGY_ID,
      await usdc.getAddress(),
      100,
    );
    await vault.bindAdapter(await adapter.getAddress());
    await vault.setKeeper(deployer.address);
    await registry.proposeStrategy(
      STRATEGY_ID,
      await adapter.getAddress(),
      "Market growth",
      ethers.parseUnits("1000", 6),
      ethers.parseUnits("10000", 6),
    );
    await registry.activateStrategy(STRATEGY_ID);

    const amount = ethers.parseUnits("100", 6);
    await usdc.mint(user.address, ethers.parseUnits("500", 6));
    await usdc.connect(user).approve(await adapter.getAddress(), ethers.MaxUint256);
    const deadline = BigInt(await time.latest()) + 3600n;
    const depositParams = (overrides: Record<string, unknown> = {}) => ({
      assets: amount,
      beneficiary: user.address,
      minShares: amount,
      deadline,
      adapterData: "0x",
      ...overrides,
    });

    return {
      deployer,
      user,
      other,
      attestationSigner,
      treasury,
      usdc,
      paired,
      factory,
      pool,
      positionManager,
      router,
      vaultConfig,
      vault,
      registry,
      adapter,
      amount,
      deadline,
      depositParams,
    };
  }

  it("matches canonical Uniswap tick math used by Souless", async function () {
    const Harness = await ethers.getContractFactory("MockTeepV3MathHarness");
    const harness = await Harness.deploy();
    expect(await harness.sqrtRatioAtTick(0)).to.equal(Q96);
    expect(await harness.sqrtRatioAtTick(-400620)).to.equal(158475363055025385992n);
    expect(await harness.sqrtRatioAtTick(400620)).to.equal(39609322322278968461496970930526694236n);
  });

  it("derives every named template outward from the reference tick", async function () {
    const Harness = await ethers.getContractFactory("MockSoulessV3RangePolicyHarness");
    const policy = await Harness.deploy();

    expect(await policy.ticks(0, 0, 60)).to.deep.equal([-23040n, 23040n]);
    expect(await policy.ticks(1, 0, 60)).to.deep.equal([-32220n, 32220n]);
    expect(await policy.ticks(2, 0, 60)).to.deep.equal([-39180n, 39180n]);
    expect(await policy.ticks(3, 0, 60)).to.deep.equal([-887220n, 887220n]);
    expect(await policy.ticks(1, 123, 60)).to.deep.equal([-32100n, 32340n]);

    expect(await policy.multiplier(0)).to.equal(10);
    expect(await policy.multiplier(1)).to.equal(25);
    expect(await policy.multiplier(2)).to.equal(50);
    expect(await policy.multiplier(3)).to.equal(0);
    await expect(policy.ticks(4, 0, 60)).to.be.revertedWith("Harness: invalid template");
  });

  it("fails closed when the pool cannot retain a useful TWAP history", async function () {
    const { pool, vaultConfig } = await loadFixture(fixture);
    await pool.setObservationCardinality(1, 1);
    const Vault = await ethers.getContractFactory("SoulessV3LPVault");
    await expect(Vault.deploy(vaultConfig)).to.be.revertedWith("LPVault: oracle buffer too small");
  });

  it("binds one adapter permanently and rejects direct public deposits", async function () {
    const { user, other, usdc, vault, adapter, amount } = await loadFixture(fixture);
    await usdc.connect(user).approve(await vault.getAddress(), amount);
    await expect(vault.connect(user).deposit(amount, user.address)).to.be.revertedWith("LPVault: not adapter");
    await expect(vault.bindAdapter(other.address)).to.be.revertedWith("LPVault: adapter already bound");
    expect(await vault.authorizedAdapter()).to.equal(await adapter.getAddress());
  });

  it("moves adapter deposits into one fixed LP position and reports conservative value", async function () {
    const { deployer, user, vault, positionManager, adapter, amount, deadline, depositParams } =
      await loadFixture(fixture);
    await adapter.connect(user).deposit(depositParams());
    expect(await vault.totalAssets()).to.equal(amount);
    expect(await vault.rangeTemplate()).to.equal(1);
    expect(await vault.rangeMultiplier()).to.equal(25);
    expect(await vault.referenceTick()).to.equal(0);
    expect(await vault.tickLower()).to.equal(-32220);
    expect(await vault.tickUpper()).to.equal(32220);

    await expect(vault.connect(deployer).deployIdle(amount, deadline)).to.emit(vault, "IdleDeployed");
    const tokenId = await vault.positionTokenId();
    expect(tokenId).to.be.greaterThan(0);
    expect(await positionManager.ownerOf(tokenId)).to.equal(await vault.getAddress());
    expect(await vault.totalAssets()).to.be.lessThanOrEqual(amount);
    expect(await vault.totalAssets()).to.be.greaterThan(ethers.parseUnits("98", 6));
  });

  it("collects LP fee evidence and converts paired-token fees to USDC", async function () {
    const { deployer, user, usdc, paired, vault, positionManager, adapter, amount, deadline, depositParams } =
      await loadFixture(fixture);
    await adapter.connect(user).deposit(depositParams());
    await vault.connect(deployer).deployIdle(amount, deadline);
    const tokenId = await vault.positionTokenId();

    const usdcFee = ethers.parseUnits("6", 6);
    const pairedFee = ethers.parseUnits("4", 6);
    await usdc.mint(deployer.address, usdcFee);
    await paired.mint(deployer.address, pairedFee);
    await usdc.approve(await positionManager.getAddress(), usdcFee);
    await paired.approve(await positionManager.getAddress(), pairedFee);
    const token0IsUsdc = (await vault.token0()).toLowerCase() === (await usdc.getAddress()).toLowerCase();
    await positionManager.seedFees(
      tokenId,
      token0IsUsdc ? usdcFee : pairedFee,
      token0IsUsdc ? pairedFee : usdcFee,
    );

    const before = await usdc.balanceOf(await vault.getAddress());
    await expect(vault.connect(user).harvest(deadline)).to.emit(vault, "FeesHarvested");
    expect(await paired.balanceOf(await vault.getAddress())).to.equal(0);
    expect(await usdc.balanceOf(await vault.getAddress()) - before).to.be.closeTo(usdcFee + pairedFee, 2);
  });

  it("rejects manipulated execution prices and recovers without admin intervention", async function () {
    const { deployer, user, other, pool, vault, adapter, amount, deadline, depositParams } =
      await loadFixture(fixture);
    await adapter.connect(user).deposit(depositParams());
    await pool.setTicks(101, 0);
    await expect(vault.connect(deployer).deployIdle(amount, deadline)).to.be.revertedWith("LPVault: price deviation");

    await pool.setTicks(0, 0);
    await vault.connect(deployer).deployIdle(amount, deadline);
    await pool.setTicks(101, 0);
    await expect(vault.connect(other).unwindAll(deadline)).to.be.revertedWith("LPVault: price deviation");
    await pool.setTicks(0, 0);
    await expect(vault.connect(other).unwindAll(deadline)).to.emit(vault, "FullyUnwound");
    expect(await vault.positionTokenId()).to.equal(0);
  });

  it("pauses entry and deployment while preserving a complete creator exit", async function () {
    const { deployer, user, usdc, vault, adapter, amount, deadline, depositParams } = await loadFixture(fixture);
    await adapter.connect(user).deposit(depositParams());
    await vault.connect(deployer).deployIdle(amount, deadline);
    await vault.pause();

    await expect(adapter.connect(user).deposit(depositParams())).to.be.revertedWithCustomError(vault, "EnforcedPause");
    const before = await usdc.balanceOf(user.address);
    const shares = await adapter.balanceOf(user.address);
    await adapter.connect(user).redeem({
      shares,
      recipient: user.address,
      minAssets: 0,
      deadline,
      adapterData: "0x",
    });
    expect(await usdc.balanceOf(user.address)).to.be.greaterThan(before);
    expect(await vault.positionTokenId()).to.equal(0);
    expect(await vault.totalSupply()).to.equal(0);
    expect(await adapter.totalSupply()).to.equal(0);
  });

  it("rejects keeper execution that exceeds the immutable slippage limit", async function () {
    const { deployer, user, router, vault, adapter, amount, deadline, depositParams } = await loadFixture(fixture);
    await adapter.connect(user).deposit(depositParams());
    await router.setExecutionLossBps(101);
    await expect(vault.connect(deployer).deployIdle(amount, deadline)).to.be.revertedWith("MockRouter: slippage");
  });

  async function claimWalletFixture() {
    const base = await fixture();
    const ReferralRegistry = await ethers.getContractFactory("ReferralRegistry");
    const referralRegistry = await ReferralRegistry.deploy(
      base.treasury.address,
      500,
      3000,
      base.attestationSigner.address,
    );
    const FeePolicy = await ethers.getContractFactory("FeePolicy");
    const feePolicy = await FeePolicy.deploy(500, 1000, base.deployer.address, 0);
    const WalletFactory = await ethers.getContractFactory("WalletFactory");
    const walletFactory = await WalletFactory.deploy(base.attestationSigner.address);
    await walletFactory.setReferralRegistry(await referralRegistry.getAddress());
    await walletFactory.setFeePolicy(await feePolicy.getAddress());
    await walletFactory.setStrategyRegistry(await base.registry.getAddress());

    const authorId = 7331n;
    const timestamp = BigInt(await time.latest());
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("souless-v3-lp-wallet"));
    const messageHash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "uint256", "bytes32"],
      [authorId, base.user.address, timestamp, nonce],
    );
    const signature = await base.attestationSigner.signMessage(ethers.getBytes(messageHash));
    await walletFactory.deployClaimWallet(authorId, base.user.address, timestamp, nonce, signature);
    const walletAddress = await walletFactory.computeClaimWallet(authorId);
    const wallet = await ethers.getContractAt("ClaimWallet", walletAddress);
    return { ...base, wallet, walletAddress };
  }

  it("runs Tips Earned through a real LP lifecycle and charges only realized yield", async function () {
    const {
      deployer,
      user,
      treasury,
      usdc,
      vault,
      positionManager,
      wallet,
      walletAddress,
      amount,
      deadline,
    } = await loadFixture(claimWalletFixture);
    await usdc.mint(walletAddress, amount);
    await wallet.connect(user).allocateToStrategy(STRATEGY_ID, amount, amount, deadline, "0x");
    await vault.connect(deployer).deployIdle(amount, deadline);

    const tokenId = await vault.positionTokenId();
    const fee = ethers.parseUnits("12", 6);
    await usdc.mint(deployer.address, fee);
    await usdc.approve(await positionManager.getAddress(), fee);
    const token0IsUsdc = (await vault.token0()).toLowerCase() === (await usdc.getAddress()).toLowerCase();
    await positionManager.seedFees(tokenId, token0IsUsdc ? fee : 0, token0IsUsdc ? 0 : fee);

    await wallet.connect(user).exitStrategy(1, ethers.MaxUint256, amount, deadline, "0x");
    const position = await wallet.growPositions(1);
    expect(position.active).to.equal(false);
    expect(position.remainingPrincipal).to.equal(0);
    expect(position.realizedYield).to.be.greaterThan(ethers.parseUnits("11", 6));
    expect(position.performanceFeesPaid).to.equal(position.realizedYield / 10n);
    expect(await usdc.balanceOf(treasury.address)).to.equal(position.performanceFeesPaid);
    expect(await usdc.balanceOf(walletAddress)).to.equal(
      amount + position.realizedYield - position.performanceFeesPaid,
    );
  });
});

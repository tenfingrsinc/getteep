import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("SoulessVaultAdapter", function () {
  const STRATEGY_ID = ethers.keccak256(ethers.toUtf8Bytes("SOULESS_ARC_USDC_V1"));
  const POSITION_CAP = ethers.parseUnits("1000", 6);
  const TOTAL_CAP = ethers.parseUnits("10000", 6);

  async function adapterFixture() {
    const [deployer, user, other] = await ethers.getSigners();
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    const MockSoulessVault = await ethers.getContractFactory("MockSoulessVault");
    const providerVault = await MockSoulessVault.deploy(await usdc.getAddress());
    const StrategyRegistry = await ethers.getContractFactory("StrategyRegistry");
    const registry = await StrategyRegistry.deploy(await usdc.getAddress(), 0);
    const SoulessVaultAdapter = await ethers.getContractFactory("SoulessVaultAdapter");
    const adapter = await SoulessVaultAdapter.deploy(
      await registry.getAddress(),
      await providerVault.getAddress(),
      STRATEGY_ID,
      await usdc.getAddress(),
      10,
    );

    await registry.proposeStrategy(
      STRATEGY_ID,
      await adapter.getAddress(),
      "More growth potential",
      POSITION_CAP,
      TOTAL_CAP,
    );
    await registry.activateStrategy(STRATEGY_ID);

    const amount = ethers.parseUnits("100", 6);
    await usdc.mint(user.address, ethers.parseUnits("5000", 6));
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
    const redeemParams = (overrides: Record<string, unknown> = {}) => ({
      shares: amount,
      recipient: user.address,
      minAssets: amount,
      deadline,
      adapterData: "0x",
      ...overrides,
    });

    return {
      deployer,
      user,
      other,
      usdc,
      providerVault,
      registry,
      adapter,
      amount,
      deadline,
      depositParams,
      redeemParams,
    };
  }

  it("exposes stable strategy metadata and quote methods", async function () {
    const { usdc, providerVault, adapter, amount } = await loadFixture(adapterFixture);
    expect(await adapter.strategyId()).to.equal(STRATEGY_ID);
    expect(await adapter.asset()).to.equal(await usdc.getAddress());
    expect(await adapter.positionToken()).to.equal(await adapter.getAddress());
    expect(await adapter.providerVault()).to.equal(await providerVault.getAddress());
    expect(await adapter.previewDeposit(amount)).to.equal(amount);
    expect(await adapter.previewRedeem(amount)).to.equal(0);
  });

  it("rejects incompatible vault assets and excessive loss configuration", async function () {
    const { registry, usdc, providerVault } = await loadFixture(adapterFixture);
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const otherAsset = await MockUSDC.deploy();
    const MockSoulessVault = await ethers.getContractFactory("MockSoulessVault");
    const wrongVault = await MockSoulessVault.deploy(await otherAsset.getAddress());
    const SoulessVaultAdapter = await ethers.getContractFactory("SoulessVaultAdapter");

    await expect(
      SoulessVaultAdapter.deploy(
        await registry.getAddress(),
        await wrongVault.getAddress(),
        STRATEGY_ID,
        await usdc.getAddress(),
        10,
      ),
    ).to.be.revertedWith("SoulessAdapter: asset mismatch");
    await expect(
      SoulessVaultAdapter.deploy(
        await registry.getAddress(),
        await providerVault.getAddress(),
        STRATEGY_ID,
        await usdc.getAddress(),
        1001,
      ),
    ).to.be.revertedWith("SoulessAdapter: loss limit too high");
  });

  it("deposits into the provider vault and issues non-transferable Teep shares", async function () {
    const { user, other, usdc, providerVault, adapter, amount, depositParams } = await loadFixture(adapterFixture);

    await expect(adapter.connect(user).deposit(depositParams()))
      .to.emit(adapter, "Deposited")
      .withArgs(user.address, amount, amount, amount, amount);

    expect(await adapter.balanceOf(user.address)).to.equal(amount);
    expect(await providerVault.balanceOf(await adapter.getAddress())).to.equal(amount);
    expect(await usdc.balanceOf(await adapter.getAddress())).to.equal(0);
    await expect(adapter.connect(user).transfer(other.address, 1)).to.be.revertedWith(
      "SoulessAdapter: shares non-transferable",
    );
  });

  it("returns principal plus provider yield proportionally", async function () {
    const { user, usdc, providerVault, adapter, amount, depositParams, redeemParams } = await loadFixture(adapterFixture);
    await adapter.connect(user).deposit(depositParams());
    const yieldAmount = ethers.parseUnits("10", 6);
    await usdc.mint(await providerVault.getAddress(), yieldAmount);

    const expectedRedemption = await adapter.previewRedeem(amount);
    expect(await adapter.totalManagedAssets()).to.equal(expectedRedemption);
    expect(expectedRedemption).to.be.closeTo(amount + yieldAmount, 1);

    const balanceBefore = await usdc.balanceOf(user.address);
    await expect(
      adapter.connect(user).redeem(redeemParams({ minAssets: expectedRedemption })),
    ).to.emit(adapter, "Redeemed");
    expect(await usdc.balanceOf(user.address) - balanceBefore).to.equal(expectedRedemption);
    expect(await adapter.totalSupply()).to.equal(0);
  });

  it("binds position ownership and redemption to the calling account", async function () {
    const { user, other, adapter, amount, depositParams, redeemParams } = await loadFixture(adapterFixture);
    await expect(
      adapter.connect(user).deposit(depositParams({ beneficiary: other.address })),
    ).to.be.revertedWith("SoulessAdapter: beneficiary must be caller");

    await adapter.connect(user).deposit(depositParams());
    await expect(
      adapter.connect(user).redeem(redeemParams({ recipient: other.address })),
    ).to.be.revertedWith("SoulessAdapter: recipient must be caller");
    await expect(
      adapter.connect(other).redeem(redeemParams({ recipient: other.address })),
    ).to.be.revertedWith("SoulessAdapter: insufficient shares");
    expect(await adapter.balanceOf(user.address)).to.equal(amount);
  });

  it("enforces deadlines, empty provider data, slippage and registry caps", async function () {
    const { user, adapter, amount, deadline, depositParams } = await loadFixture(adapterFixture);
    await expect(
      adapter.connect(user).deposit(depositParams({ deadline: deadline - 7200n })),
    ).to.be.revertedWith("SoulessAdapter: deadline expired");
    await expect(
      adapter.connect(user).deposit(depositParams({ adapterData: "0x01" })),
    ).to.be.revertedWith("SoulessAdapter: unsupported data");
    await expect(
      adapter.connect(user).deposit(depositParams({ minShares: amount + 1n })),
    ).to.be.revertedWith("SoulessAdapter: insufficient shares");
    await expect(
      adapter.connect(user).deposit(
        depositParams({ assets: POSITION_CAP + 1n, minShares: 0 }),
      ),
    ).to.be.revertedWith("SoulessAdapter: position cap exceeded");
  });

  it("blocks new deposits when paused or emergency-disabled but keeps exits open", async function () {
    const { deployer, user, registry, adapter, amount, depositParams, redeemParams } = await loadFixture(adapterFixture);
    await adapter.connect(user).deposit(depositParams());

    await adapter.connect(deployer).pause();
    await expect(adapter.connect(user).deposit(depositParams())).to.be.revertedWithCustomError(
      adapter,
      "EnforcedPause",
    );
    await adapter.connect(user).redeem(redeemParams());

    await adapter.connect(deployer).unpause();
    await adapter.connect(user).deposit(depositParams());
    await registry.setStrategyEmergencyDisabled(STRATEGY_ID, true);
    await expect(adapter.connect(user).deposit(depositParams())).to.be.revertedWith(
      "SoulessAdapter: strategy unavailable",
    );
    await expect(adapter.connect(user).redeem(redeemParams({ shares: amount }))).to.emit(
      adapter,
      "Redeemed",
    );
  });

  it("resists an idle-token donation without locking initial deposits", async function () {
    const { user, usdc, adapter, amount, depositParams } = await loadFixture(adapterFixture);
    await usdc.mint(await adapter.getAddress(), 1);
    const quotedShares = await adapter.previewDeposit(amount);
    await adapter.connect(user).deposit(depositParams({ minShares: quotedShares }));
    expect(await adapter.balanceOf(user.address)).to.equal(quotedShares);
    expect(quotedShares).to.be.greaterThan(0);
  });

  it("keeps multiple accounts proportional through yield and sequential exits", async function () {
    const { user, other, usdc, providerVault, adapter, amount, deadline, depositParams } =
      await loadFixture(adapterFixture);
    await usdc.mint(other.address, amount);
    await usdc.connect(other).approve(await adapter.getAddress(), amount);

    await adapter.connect(user).deposit(depositParams());
    await adapter.connect(other).deposit(
      depositParams({ beneficiary: other.address, minShares: 0 }),
    );
    await usdc.mint(await providerVault.getAddress(), ethers.parseUnits("20", 6));

    const userQuote = await adapter.previewRedeem(await adapter.balanceOf(user.address));
    const otherQuote = await adapter.previewRedeem(await adapter.balanceOf(other.address));
    expect(userQuote).to.be.closeTo(otherQuote, 1);

    await adapter.connect(user).redeem({
      shares: await adapter.balanceOf(user.address),
      recipient: user.address,
      minAssets: userQuote,
      deadline,
      adapterData: "0x",
    });
    await adapter.connect(other).redeem({
      shares: await adapter.balanceOf(other.address),
      recipient: other.address,
      minAssets: otherQuote,
      deadline,
      adapterData: "0x",
    });
    expect(await adapter.totalSupply()).to.equal(0);
    expect(await adapter.balanceOf(user.address)).to.equal(0);
    expect(await adapter.balanceOf(other.address)).to.equal(0);
  });
});

describe("Souless Grow Tips end-to-end", function () {
  const STRATEGY_ID = ethers.keccak256(ethers.toUtf8Bytes("SOULESS_ARC_USDC_V1"));

  async function claimWalletFixture() {
    const [deployer, attestationSigner, creator, treasury] = await ethers.getSigners();
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    const MockSoulessVault = await ethers.getContractFactory("MockSoulessVault");
    const providerVault = await MockSoulessVault.deploy(await usdc.getAddress());
    const StrategyRegistry = await ethers.getContractFactory("StrategyRegistry");
    const strategyRegistry = await StrategyRegistry.deploy(await usdc.getAddress(), 0);
    const SoulessVaultAdapter = await ethers.getContractFactory("SoulessVaultAdapter");
    const adapter = await SoulessVaultAdapter.deploy(
      await strategyRegistry.getAddress(),
      await providerVault.getAddress(),
      STRATEGY_ID,
      await usdc.getAddress(),
      10,
    );
    await strategyRegistry.proposeStrategy(
      STRATEGY_ID,
      await adapter.getAddress(),
      "More growth potential",
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

    const authorId = 9001n;
    const timestamp = BigInt(await time.latest());
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("souless-wallet-deployment"));
    const messageHash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "uint256", "bytes32"],
      [authorId, creator.address, timestamp, nonce],
    );
    const signature = await attestationSigner.signMessage(ethers.getBytes(messageHash));
    await factory.deployClaimWallet(authorId, creator.address, timestamp, nonce, signature);
    const walletAddress = await factory.computeClaimWallet(authorId);
    const wallet = await ethers.getContractAt("ClaimWallet", walletAddress);
    const deadline = BigInt(await time.latest()) + 3600n;

    return { creator, treasury, usdc, providerVault, adapter, wallet, walletAddress, deadline };
  }

  it("moves tips through Souless and charges a fee only on realized yield", async function () {
    const { creator, treasury, usdc, providerVault, adapter, wallet, walletAddress, deadline } =
      await loadFixture(claimWalletFixture);
    const principal = ethers.parseUnits("100", 6);
    const yieldAmount = ethers.parseUnits("12", 6);
    await usdc.mint(walletAddress, principal);

    await wallet.connect(creator).allocateToStrategy(STRATEGY_ID, principal, principal, deadline, "0x");
    expect(await adapter.balanceOf(walletAddress)).to.equal(principal);
    await usdc.mint(await providerVault.getAddress(), yieldAmount);

    await wallet.connect(creator).exitStrategy(
      1,
      ethers.MaxUint256,
      ethers.parseUnits("111", 6),
      deadline,
      "0x",
    );

    // ERC-4626 conversion can round down by one base unit; fees use realized assets.
    expect(await usdc.balanceOf(walletAddress)).to.equal(ethers.parseUnits("110.8", 6));
    expect(await usdc.balanceOf(treasury.address)).to.equal(ethers.parseUnits("1.2", 6) - 1n);
    const position = await wallet.growPositions(1);
    expect(position.remainingPrincipal).to.equal(0);
    expect(position.active).to.equal(false);
  });
});

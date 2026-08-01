import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("Grow Tips DeFi contracts", function () {
  const STRATEGY_ID = ethers.keccak256(ethers.toUtf8Bytes("AAVE_V3_ARC_TESTNET_USDC"));

  async function deployFixture() {
    const [deployer, user, beneficiary, other] = await ethers.getSigners();
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    const MockAToken = await ethers.getContractFactory("MockAToken");
    const aToken = await MockAToken.deploy();
    const MockAavePool = await ethers.getContractFactory("MockAavePool");
    const pool = await MockAavePool.deploy(await usdc.getAddress(), await aToken.getAddress());
    await aToken.setPool(await pool.getAddress());

    const StrategyRegistry = await ethers.getContractFactory("StrategyRegistry");
    const registry = await StrategyRegistry.deploy(await usdc.getAddress(), 0);
    const Adapter = await ethers.getContractFactory("AaveV3SupplyAdapter");
    const adapter = await Adapter.deploy(
      await registry.getAddress(), await pool.getAddress(), STRATEGY_ID,
      await usdc.getAddress(), await aToken.getAddress(),
    );
    await registry.proposeStrategy(
      STRATEGY_ID, await adapter.getAddress(), "Aave Arc Testnet USDC",
      ethers.parseUnits("1000", 6), ethers.parseUnits("10000", 6),
    );
    await registry.activateStrategy(STRATEGY_ID);

    const amount = ethers.parseUnits("25", 6);
    await usdc.mint(user.address, ethers.parseUnits("100", 6));
    const deadline = BigInt(await time.latest()) + 3600n;
    const depositParams = (assets = amount, receiver = beneficiary.address, minShares = assets) => ({
      assets, beneficiary: receiver, minShares, deadline, adapterData: "0x",
    });
    const redeemParams = (shares = amount, recipient = other.address, minAssets = shares) => ({
      shares, recipient, minAssets, deadline, adapterData: "0x",
    });
    return { deployer, user, beneficiary, other, usdc, aToken, pool, registry, adapter, amount, deadline, depositParams, redeemParams };
  }

  describe("StrategyRegistry", function () {
    it("registers an enabled canonical-asset strategy through proposal and activation", async function () {
      const { registry, adapter, usdc } = await loadFixture(deployFixture);
      expect(await registry.isStrategyAvailable(STRATEGY_ID)).to.equal(true);
      const strategy = await registry.getStrategy(STRATEGY_ID);
      expect(strategy.adapter).to.equal(await adapter.getAddress());
      expect(strategy.asset).to.equal(await usdc.getAddress());
      expect(strategy.positionToken).to.equal(await adapter.getAddress());
    });

    it("rejects non-owner administration and supports immediate emergency disablement", async function () {
      const { registry, user } = await loadFixture(deployFixture);
      await expect(registry.connect(user).setStrategyEnabled(STRATEGY_ID, false))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
      await registry.setStrategyEmergencyDisabled(STRATEGY_ID, true);
      expect(await registry.isStrategyAvailable(STRATEGY_ID)).to.equal(false);
    });

    it("enforces the adapter activation delay", async function () {
      const { usdc, pool, aToken } = await loadFixture(deployFixture);
      const Registry = await ethers.getContractFactory("StrategyRegistry");
      const delayedRegistry = await Registry.deploy(await usdc.getAddress(), 3600);
      const Adapter = await ethers.getContractFactory("AaveV3SupplyAdapter");
      const delayedAdapter = await Adapter.deploy(
        await delayedRegistry.getAddress(), await pool.getAddress(), STRATEGY_ID,
        await usdc.getAddress(), await aToken.getAddress(),
      );
      await delayedRegistry.proposeStrategy(
        STRATEGY_ID, await delayedAdapter.getAddress(), "Delayed",
        ethers.parseUnits("100", 6), ethers.parseUnits("1000", 6),
      );
      await expect(delayedRegistry.activateStrategy(STRATEGY_ID)).to.be.revertedWith("Registry: activation pending");
      await time.increase(3600);
      await expect(delayedRegistry.activateStrategy(STRATEGY_ID)).to.emit(delayedRegistry, "StrategyActivated");
    });
  });

  describe("AaveV3SupplyAdapter", function () {
    it("supplies assets and issues non-rebasing strategy shares", async function () {
      const { user, beneficiary, usdc, aToken, adapter, amount, depositParams } = await loadFixture(deployFixture);
      await usdc.connect(user).approve(await adapter.getAddress(), amount);
      await expect(adapter.connect(user).deposit(depositParams()))
        .to.emit(adapter, "Deposited").withArgs(user.address, beneficiary.address, amount, amount);
      expect(await adapter.balanceOf(beneficiary.address)).to.equal(amount);
      expect(await aToken.balanceOf(await adapter.getAddress())).to.equal(amount);
    });

    it("redeems proportional assets to the recipient", async function () {
      const { user, beneficiary, other, usdc, adapter, amount, depositParams, redeemParams } = await loadFixture(deployFixture);
      await usdc.connect(user).approve(await adapter.getAddress(), amount);
      await adapter.connect(user).deposit(depositParams());
      await expect(adapter.connect(beneficiary).redeem(redeemParams()))
        .to.emit(adapter, "Redeemed").withArgs(beneficiary.address, other.address, amount, amount);
      expect(await usdc.balanceOf(other.address)).to.equal(amount);
    });

    it("rejects deposits but keeps redemptions open when disabled", async function () {
      const { user, beneficiary, usdc, registry, adapter, amount, depositParams, redeemParams } = await loadFixture(deployFixture);
      await usdc.connect(user).approve(await adapter.getAddress(), amount);
      await adapter.connect(user).deposit(depositParams());
      await registry.setStrategyEmergencyDisabled(STRATEGY_ID, true);
      await expect(adapter.connect(user).deposit(depositParams())).to.be.revertedWith("Adapter: strategy unavailable");
      await expect(adapter.connect(beneficiary).redeem(redeemParams(amount, user.address))).to.emit(adapter, "Redeemed");
    });

    it("enforces minimum shares, deadlines, bounded data, and caps", async function () {
      const { user, usdc, adapter, amount, deadline, depositParams } = await loadFixture(deployFixture);
      await usdc.connect(user).approve(await adapter.getAddress(), ethers.parseUnits("100", 6));
      await expect(adapter.connect(user).deposit(depositParams(amount, user.address, amount + 1n)))
        .to.be.revertedWith("Adapter: insufficient shares");
      await expect(adapter.connect(user).deposit({ ...depositParams(amount, user.address), deadline: deadline - 7200n }))
        .to.be.revertedWith("Adapter: deadline expired");
      await expect(adapter.connect(user).deposit({ ...depositParams(amount, user.address), adapterData: "0x01" }))
        .to.be.revertedWith("Adapter: unsupported data");
      await expect(adapter.connect(user).deposit(depositParams(ethers.parseUnits("1001", 6), user.address)))
        .to.be.revertedWith("Adapter: position cap exceeded");
    });

    it("pauses deposits without pausing exits", async function () {
      const { user, beneficiary, usdc, adapter, amount, depositParams, redeemParams } = await loadFixture(deployFixture);
      await usdc.connect(user).approve(await adapter.getAddress(), amount);
      await adapter.connect(user).deposit(depositParams());
      await adapter.pause();
      await expect(adapter.connect(user).deposit(depositParams())).to.be.revertedWithCustomError(adapter, "EnforcedPause");
      await expect(adapter.connect(beneficiary).redeem(redeemParams(amount, user.address))).to.emit(adapter, "Redeemed");
    });
  });
});

import { ethers } from "hardhat";

const ADDRESS_ABI = [
  "function asset() view returns (address)",
  "function previewDeposit(uint256 assets) view returns (uint256 shares)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
];

function requiredAddress(name: string): string {
  const value = process.env[name];
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero address`);
  }
  return ethers.getAddress(value);
}

function requiredPositiveInteger(name: string, defaultValue: string): bigint {
  const value = process.env[name] || defaultValue;
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${name} must be a positive integer`);
  }
  return BigInt(value);
}

function strategyId(): string {
  const configured = process.env.GROW_TIPS_SOULESS_STRATEGY_ID || "SOULESS_ARC_USDC_V1";
  if (/^0x[0-9a-fA-F]{64}$/.test(configured)) return configured;
  if (!/^[A-Z0-9_]{3,64}$/.test(configured)) {
    throw new Error("GROW_TIPS_SOULESS_STRATEGY_ID must be bytes32 or 3-64 uppercase letters, numbers and underscores");
  }
  return ethers.keccak256(ethers.toUtf8Bytes(configured));
}

async function requireContract(address: string, name: string): Promise<void> {
  if ((await ethers.provider.getCode(address)) === "0x") {
    throw new Error(`${name} has no contract code at ${address}`);
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const registryAddress = requiredAddress("STRATEGY_REGISTRY_ADDRESS");
  const providerVaultAddress = requiredAddress("SOULESS_VAULT_ADDRESS");
  const usdcAddress = requiredAddress("USDC_ADDRESS");
  const id = strategyId();
  const label = (process.env.GROW_TIPS_SOULESS_LABEL || "More growth potential").trim();
  if (label.length < 3 || label.length > 80) throw new Error("GROW_TIPS_SOULESS_LABEL must be 3-80 characters");

  const maxPositionAssets = requiredPositiveInteger("GROW_TIPS_MAX_POSITION_USDC", "1000") * 1_000_000n;
  const totalAssetsCap = requiredPositiveInteger("GROW_TIPS_TOTAL_CAP_USDC", "10000") * 1_000_000n;
  if (totalAssetsCap < maxPositionAssets) {
    throw new Error("GROW_TIPS_TOTAL_CAP_USDC must be at least GROW_TIPS_MAX_POSITION_USDC");
  }

  const maxDepositLossBps = Number(process.env.GROW_TIPS_SOULESS_MAX_DEPOSIT_LOSS_BPS || "10");
  if (!Number.isInteger(maxDepositLossBps) || maxDepositLossBps < 0 || maxDepositLossBps > 1_000) {
    throw new Error("GROW_TIPS_SOULESS_MAX_DEPOSIT_LOSS_BPS must be an integer from 0 to 1000");
  }

  await requireContract(registryAddress, "STRATEGY_REGISTRY_ADDRESS");
  await requireContract(providerVaultAddress, "SOULESS_VAULT_ADDRESS");
  await requireContract(usdcAddress, "USDC_ADDRESS");

  const StrategyRegistry = await ethers.getContractFactory("StrategyRegistry");
  const registry = StrategyRegistry.attach(registryAddress);
  if (ethers.getAddress(await registry.owner()) !== deployer.address) {
    throw new Error("Deployer must own StrategyRegistry so registration cannot fail after adapter deployment");
  }
  const canonicalAsset = await registry.canonicalAsset();
  if (ethers.getAddress(canonicalAsset) !== usdcAddress) {
    throw new Error(`Registry canonical asset ${canonicalAsset} does not match USDC_ADDRESS ${usdcAddress}`);
  }

  const providerVault = await ethers.getContractAt(ADDRESS_ABI, providerVaultAddress);
  const vaultAsset = await providerVault.asset();
  if (ethers.getAddress(vaultAsset) !== usdcAddress) {
    throw new Error(`Souless vault asset ${vaultAsset} does not match USDC_ADDRESS ${usdcAddress}`);
  }
  await providerVault.previewDeposit(1_000_000n);
  await providerVault.previewRedeem(0);

  const existingIds = await registry.getStrategyIds();
  if (existingIds.some((existingId: string) => existingId.toLowerCase() === id.toLowerCase())) {
    throw new Error(`Strategy ID ${id} is already active; deploy material changes under a new versioned ID`);
  }
  const pending = await registry.getPendingStrategy(id);
  if (pending.adapter !== ethers.ZeroAddress) {
    throw new Error(`Strategy ID ${id} already has a pending proposal`);
  }

  console.log("Validated Souless strategy deployment inputs:");
  console.log("Deployer:", deployer.address);
  console.log("StrategyRegistry:", registryAddress);
  console.log("Souless ERC-4626 vault:", providerVaultAddress);
  console.log("Canonical USDC:", usdcAddress);
  console.log("Strategy ID:", id);
  console.log("Per-position cap:", maxPositionAssets.toString());
  console.log("Total strategy cap:", totalAssetsCap.toString());
  console.log("Maximum synchronous deposit loss (bps):", maxDepositLossBps);

  const SoulessVaultAdapter = await ethers.getContractFactory("SoulessVaultAdapter");
  const adapter = await SoulessVaultAdapter.deploy(
    registryAddress,
    providerVaultAddress,
    id,
    usdcAddress,
    maxDepositLossBps,
  );
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();
  console.log("SoulessVaultAdapter deployed:", adapterAddress);

  await (
    await registry.proposeStrategy(id, adapterAddress, label, maxPositionAssets, totalAssetsCap)
  ).wait();
  const activationDelay = await registry.activationDelay();
  if (activationDelay === 0n) {
    await (await registry.activateStrategy(id)).wait();
    console.log("Strategy registered and enabled.");
  } else {
    const pending = await registry.getPendingStrategy(id);
    console.log("Strategy proposed but not active. Activate after Unix timestamp:", pending.activateAfter.toString());
  }

  console.log("\nPersist these public deployment values in the strategy catalog:");
  console.log("GROW_TIPS_SOULESS_STRATEGY_ID=", id);
  console.log("GROW_TIPS_SOULESS_ADAPTER_ADDRESS=", adapterAddress);
  console.log("SOULESS_VAULT_ADDRESS=", providerVaultAddress);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

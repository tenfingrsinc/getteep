import { ethers } from "hardhat";

const ARC_TESTNET = {
  chainId: 5_042_002n,
  usdc: "0x3600000000000000000000000000000000000000",
  factory: "0x19bB256c9351F2a31889803A0b5E0D2Ba57D3128",
  positionManager: "0x4665EbBdD68427A5fDA9700Ac95Fe098aAB5fcFa",
  swapRouter: "0x3CA4c0A116fEf177EA2a78A52866B7eC5B367509",
};

const DEFAULT_GROWTH_TOKEN = "0x73a95b1a988d792F4096DCF026604c7e9Bc2bBa4";
const RANGE_TEMPLATES = {
  BALANCED: 0,
  GROWTH: 1,
  VOLATILE: 2,
  UNLIMITED: 3,
} as const;

function addressValue(name: string, fallback?: string): string {
  const value = process.env[name] || fallback;
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero address`);
  }
  return ethers.getAddress(value);
}

function uintValue(name: string, fallback: string, maximum?: bigint): bigint {
  const value = process.env[name] || fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an unsigned integer`);
  const parsed = BigInt(value);
  if (maximum !== undefined && parsed > maximum) throw new Error(`${name} exceeds ${maximum}`);
  return parsed;
}

function rangeTemplate(): { name: keyof typeof RANGE_TEMPLATES; value: number } {
  const name = (process.env.SOULESS_RANGE_TEMPLATE || "GROWTH").trim().toUpperCase();
  if (!(name in RANGE_TEMPLATES)) {
    throw new Error("SOULESS_RANGE_TEMPLATE must be BALANCED, GROWTH, VOLATILE or UNLIMITED");
  }
  const typedName = name as keyof typeof RANGE_TEMPLATES;
  return { name: typedName, value: RANGE_TEMPLATES[typedName] };
}

function versionedStrategyId(template: keyof typeof RANGE_TEMPLATES, pairedToken: string): string {
  const defaultId = `SOULESS_V3_${template}_${pairedToken.slice(2, 8).toUpperCase()}_V1`;
  const value = process.env.GROW_TIPS_SOULESS_STRATEGY_ID || defaultId;
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value;
  if (!/^[A-Z0-9_]{3,64}$/.test(value)) {
    throw new Error("GROW_TIPS_SOULESS_STRATEGY_ID must be bytes32 or a versioned uppercase identifier");
  }
  return ethers.keccak256(ethers.toUtf8Bytes(value));
}

async function requireCode(address: string, label: string): Promise<void> {
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`${label} has no contract code at ${address}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== ARC_TESTNET.chainId) throw new Error(`Expected Arc Testnet chain ${ARC_TESTNET.chainId}`);

  const usdc = addressValue("USDC_ADDRESS", ARC_TESTNET.usdc);
  const pairedToken = addressValue("SOULESS_PAIRED_TOKEN_ADDRESS", DEFAULT_GROWTH_TOKEN);
  const factoryAddress = addressValue("SOULESS_V3_FACTORY_ADDRESS", ARC_TESTNET.factory);
  const positionManager = addressValue("SOULESS_V3_POSITION_MANAGER_ADDRESS", ARC_TESTNET.positionManager);
  const swapRouter = addressValue("SOULESS_V3_SWAP_ROUTER_ADDRESS", ARC_TESTNET.swapRouter);
  const registryAddress = addressValue("STRATEGY_REGISTRY_ADDRESS");
  const keeper = addressValue("SOULESS_VAULT_KEEPER_ADDRESS", deployer.address);
  const finalOwner = addressValue("SOULESS_VAULT_OWNER_ADDRESS", deployer.address);
  const poolFee = Number(uintValue("SOULESS_POOL_FEE", "3000", 1_000_000n));
  const selectedRange = rangeTemplate();
  const twapWindow = Number(uintValue("SOULESS_TWAP_WINDOW_SECONDS", "1800", 86_400n));
  const maxDeviation = Number(uintValue("SOULESS_MAX_TWAP_DEVIATION_TICKS", "100", 10_000n));
  const slippageBps = Number(uintValue("SOULESS_MAX_SLIPPAGE_BPS", "100", 500n));
  const haircutBps = Number(uintValue("SOULESS_VALUATION_HAIRCUT_BPS", "150", 1_000n));
  const adapterLossBps = Number(uintValue("GROW_TIPS_SOULESS_MAX_DEPOSIT_LOSS_BPS", "10", 1_000n));
  const maxPosition = uintValue("GROW_TIPS_MAX_POSITION_USDC", "1000") * 1_000_000n;
  const totalCap = uintValue("GROW_TIPS_TOTAL_CAP_USDC", "10000") * 1_000_000n;
  if (totalCap < maxPosition) throw new Error("Total cap must be at least the per-position cap");
  const strategyId = versionedStrategyId(selectedRange.name, pairedToken);
  const label = (process.env.GROW_TIPS_SOULESS_LABEL || `${selectedRange.name[0]}${selectedRange.name.slice(1).toLowerCase()}`).trim();
  if (label.length < 3 || label.length > 80) throw new Error("Strategy label must be 3-80 characters");

  for (const [address, labelName] of [
    [usdc, "USDC"],
    [pairedToken, "paired token"],
    [factoryAddress, "factory"],
    [positionManager, "position manager"],
    [swapRouter, "swap router"],
    [registryAddress, "strategy registry"],
  ] as const) await requireCode(address, labelName);

  const factory = await ethers.getContractAt("ISoulessV3Factory", factoryAddress);
  const poolAddress = await factory.getPool(usdc, pairedToken, poolFee);
  if (poolAddress === ethers.ZeroAddress) throw new Error("No canonical Souless pool exists for this token and fee tier");
  await requireCode(poolAddress, "canonical pool");
  const pool = await ethers.getContractAt("ISoulessV3Pool", poolAddress);
  const slot0 = await pool.slot0();
  const observationCardinalityNext = slot0[4];
  if (observationCardinalityNext < 16) {
    throw new Error(
      `Pool oracle buffer is ${observationCardinalityNext}; run prepare:souless-v3-pool:arc-testnet before deployment`,
    );
  }

  const registry = await ethers.getContractAt("StrategyRegistry", registryAddress);
  if (ethers.getAddress(await registry.owner()) !== deployer.address) {
    throw new Error("Deployer must own StrategyRegistry; use a reviewed Safe proposal flow otherwise");
  }
  if (ethers.getAddress(await registry.canonicalAsset()) !== usdc) throw new Error("Registry canonical asset mismatch");
  const existingIds = await registry.getStrategyIds();
  if (existingIds.some((id: string) => id.toLowerCase() === strategyId.toLowerCase())) {
    throw new Error("Strategy ID already exists; deploy material changes under a new versioned ID");
  }
  if ((await registry.getPendingStrategy(strategyId)).adapter !== ethers.ZeroAddress) {
    throw new Error("Strategy ID already has a pending proposal");
  }

  console.log("Validated fixed Souless V3 strategy:");
  console.log("Pool:", poolAddress);
  console.log("Paired token:", pairedToken);
  console.log("Range template:", selectedRange.name);
  console.log("TWAP window:", twapWindow);
  console.log("Keeper:", keeper);
  console.log("Final owner:", finalOwner);

  const Vault = await ethers.getContractFactory("SoulessV3LPVault");
  const vault = await Vault.deploy({
    usdc,
    pairedToken,
    factory: factoryAddress,
    pool: poolAddress,
    positionManager,
    swapRouter,
    poolFee,
    rangeTemplate: selectedRange.value,
    twapWindow,
    maxTwapDeviationTicks: maxDeviation,
    maxSlippageBps: slippageBps,
    valuationHaircutBps: haircutBps,
    owner: deployer.address,
  });
  await vault.waitForDeployment();
  console.log("Reference TWAP tick:", (await vault.referenceTick()).toString());
  console.log("Immutable tick range:", (await vault.tickLower()).toString(), (await vault.tickUpper()).toString());

  const Adapter = await ethers.getContractFactory("SoulessVaultAdapter");
  const adapter = await Adapter.deploy(
    registryAddress,
    await vault.getAddress(),
    strategyId,
    usdc,
    adapterLossBps,
  );
  await adapter.waitForDeployment();
  await (await vault.bindAdapter(await adapter.getAddress())).wait();
  await (await vault.setKeeper(keeper)).wait();

  await (await registry.proposeStrategy(strategyId, await adapter.getAddress(), label, maxPosition, totalCap)).wait();
  const activationDelay = await registry.activationDelay();
  if (activationDelay === 0n) {
    await (await registry.activateStrategy(strategyId)).wait();
  } else {
    const pending = await registry.getPendingStrategy(strategyId);
    console.log("Activate after Unix timestamp:", pending.activateAfter.toString());
  }

  if (finalOwner !== deployer.address) await (await vault.transferOwnership(finalOwner)).wait();

  console.log("SoulessV3LPVault=", await vault.getAddress());
  console.log("SoulessVaultAdapter=", await adapter.getAddress());
  console.log("StrategyId=", strategyId);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

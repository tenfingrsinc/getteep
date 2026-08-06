import { ethers } from "hardhat";

function requiredAddress(name: string): string {
  const value = process.env[name];
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero address`);
  }
  return ethers.getAddress(value);
}

function strategyId(): string {
  const configured = process.env.GROW_TIPS_SOULESS_STRATEGY_ID || "SOULESS_V3_GROWTH_73A95B_V1";
  if (/^0x[0-9a-fA-F]{64}$/.test(configured)) return configured;
  if (!/^[A-Z0-9_]{3,64}$/.test(configured)) {
    throw new Error("GROW_TIPS_SOULESS_STRATEGY_ID must be bytes32 or a versioned uppercase identifier");
  }
  return ethers.keccak256(ethers.toUtf8Bytes(configured));
}

async function main() {
  const registryAddress = requiredAddress("STRATEGY_REGISTRY_ADDRESS");
  const adapterAddress = requiredAddress("GROW_TIPS_SOULESS_ADAPTER_ADDRESS");
  const id = strategyId();
  const registry = await ethers.getContractAt("StrategyRegistry", registryAddress);

  if (await registry.isStrategyAvailable(id)) {
    const active = await registry.getStrategy(id);
    if (ethers.getAddress(active.adapter) !== adapterAddress) {
      throw new Error(`Active adapter mismatch: expected ${adapterAddress}, received ${active.adapter}`);
    }
    console.log("Souless strategy is already active:", id);
    return;
  }

  const pending = await registry.getPendingStrategy(id);
  if (pending.adapter === ethers.ZeroAddress) throw new Error("No pending Souless strategy proposal exists");
  if (ethers.getAddress(pending.adapter) !== adapterAddress) {
    throw new Error(`Pending adapter mismatch: expected ${adapterAddress}, received ${pending.adapter}`);
  }
  const latest = await ethers.provider.getBlock("latest");
  if (!latest || BigInt(latest.timestamp) < pending.activateAfter) {
    throw new Error(`Strategy cannot activate before Unix timestamp ${pending.activateAfter}`);
  }

  const transaction = await registry.activateStrategy(id);
  console.log("Activation transaction:", transaction.hash);
  await transaction.wait();
  if (!(await registry.isStrategyAvailable(id))) throw new Error("Strategy activation was not confirmed");
  console.log("Souless strategy activated:", id);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

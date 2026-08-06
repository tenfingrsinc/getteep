import { ethers } from "hardhat";

const ARC_TESTNET_CHAIN_ID = 5_042_002n;
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const SOULESS_FACTORY = "0x19bB256c9351F2a31889803A0b5E0D2Ba57D3128";
const DEFAULT_GROWTH_TOKEN = "0x73a95b1a988d792F4096DCF026604c7e9Bc2bBa4";
const MINIMUM_CARDINALITY = 16;

function configuredAddress(name: string, fallback: string): string {
  const value = process.env[name] || fallback;
  if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`${name} is not a valid address`);
  return ethers.getAddress(value);
}

async function main() {
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== ARC_TESTNET_CHAIN_ID) throw new Error(`Expected Arc Testnet chain ${ARC_TESTNET_CHAIN_ID}`);

  const usdc = configuredAddress("USDC_ADDRESS", ARC_USDC);
  const pairedToken = configuredAddress("SOULESS_PAIRED_TOKEN_ADDRESS", DEFAULT_GROWTH_TOKEN);
  const factoryAddress = configuredAddress("SOULESS_V3_FACTORY_ADDRESS", SOULESS_FACTORY);
  const fee = Number(process.env.SOULESS_POOL_FEE || "3000");
  if (!Number.isInteger(fee) || fee <= 0 || fee > 1_000_000) throw new Error("SOULESS_POOL_FEE is invalid");

  const factory = await ethers.getContractAt("ISoulessV3Factory", factoryAddress);
  const poolAddress = await factory.getPool(usdc, pairedToken, fee);
  if (poolAddress === ethers.ZeroAddress) throw new Error("Canonical Souless pool does not exist");
  const pool = await ethers.getContractAt("ISoulessV3Pool", poolAddress);
  const before = await pool.slot0();
  console.log("Pool:", poolAddress);
  console.log("Current oracle cardinality:", before[3].toString());
  console.log("Current target cardinality:", before[4].toString());
  if (before[4] >= MINIMUM_CARDINALITY) {
    console.log("Oracle buffer is already prepared.");
    return;
  }

  const transaction = await pool.increaseObservationCardinalityNext(MINIMUM_CARDINALITY);
  console.log("Preparation transaction:", transaction.hash);
  await transaction.wait();
  const after = await pool.slot0();
  console.log("New target cardinality:", after[4].toString());
  console.log("The pool fills new observations during swaps. Deployment still verifies the configured TWAP window.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

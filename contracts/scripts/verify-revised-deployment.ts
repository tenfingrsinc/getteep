import { ethers } from "hardhat";
import fs from "fs";

async function main() {
  const addresses = JSON.parse(fs.readFileSync("deployed-addresses.json", "utf8"));
  const factory = await ethers.getContractAt("WalletFactory", addresses.walletFactory);
  const feePolicy = await ethers.getContractAt("FeePolicy", addresses.feePolicy);

  const strategyRegistryContract = await ethers.getContractAt("StrategyRegistry", addresses.strategyRegistry);
  const [referralRegistry, configuredFeePolicy, strategyRegistry, withdrawalFeeBps, performanceFeeBps, policyVersion, feeChangeDelay, strategyActivationDelay] =
    await Promise.all([
      factory.referralRegistry(),
      factory.feePolicy(),
      factory.strategyRegistry(),
      feePolicy.globalWithdrawalFeeBps(),
      feePolicy.defaultPerformanceFeeBps(),
      feePolicy.policyVersion(),
      feePolicy.changeDelay(),
      strategyRegistryContract.activationDelay(),
    ]);

  const checks = {
    referralRegistry: referralRegistry.toLowerCase() === addresses.referralRegistry.toLowerCase(),
    feePolicy: configuredFeePolicy.toLowerCase() === addresses.feePolicy.toLowerCase(),
    strategyRegistry: strategyRegistry.toLowerCase() === addresses.strategyRegistry.toLowerCase(),
    withdrawalFeeBps: withdrawalFeeBps === 500n,
    performanceFeeBps: performanceFeeBps === 1000n,
    policyVersion: policyVersion === 1n,
    feeChangeDelay: feeChangeDelay === 3600n,
    strategyActivationDelay: strategyActivationDelay === 3600n,
  };

  console.log(JSON.stringify({ addresses, checks }, null, 2));
  if (Object.values(checks).some((valid) => !valid)) {
    throw new Error("Revised deployment verification failed");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

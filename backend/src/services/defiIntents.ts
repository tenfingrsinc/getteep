import { getAddress } from "ethers";
import {
  encodeFunctionData,
  isAddress,
  maxUint256,
  type Address,
  type Hex,
} from "viem";
import { getChainId } from "../config/chain";
import { getDb } from "../db/database";
import { claimWalletBelongsToOwner } from "./claimWalletProvisioner";
import { getDefiStrategy } from "./defi";
import { createBackendPublicClient } from "./rpcClient";

export type DefiIntentAction = "add" | "withdraw_partial" | "withdraw_all";

export type DefiIntentInput = {
  ownerAddress: Address;
  strategyId: Hex;
  action: DefiIntentAction;
  amountRaw?: string;
  positionId?: string;
};

export class DefiIntentError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const CLAIM_WALLET_ABI = [
  {
    name: "owner",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "strategyRegistry",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "growPositions",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "strategyId", type: "bytes32" },
      { name: "remainingPrincipal", type: "uint256" },
      { name: "remainingShares", type: "uint256" },
      { name: "realizedYield", type: "uint256" },
      { name: "performanceFeesPaid", type: "uint256" },
      { name: "createdAt", type: "uint64" },
      { name: "active", type: "bool" },
    ],
  },
  {
    name: "allocateToStrategy",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "strategyId", type: "bytes32" },
      { name: "assets", type: "uint256" },
      { name: "minShares", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "adapterData", type: "bytes" },
    ],
    outputs: [
      { name: "positionId", type: "uint256" },
      { name: "shares", type: "uint256" },
    ],
  },
  {
    name: "exitStrategy",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "positionId", type: "uint256" },
      { name: "sharesToRedeem", type: "uint256" },
      { name: "minAssets", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "adapterData", type: "bytes" },
    ],
    outputs: [{ name: "netAssets", type: "uint256" }],
  },
] as const;

const REGISTRY_ABI = [
  {
    name: "isStrategyAvailable",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "strategyId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getStrategy",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "strategyId", type: "bytes32" }],
    outputs: [{
      name: "strategy",
      type: "tuple",
      components: [
        { name: "adapter", type: "address" },
        { name: "asset", type: "address" },
        { name: "positionToken", type: "address" },
        { name: "enabled", type: "bool" },
        { name: "emergencyDisabled", type: "bool" },
        { name: "maxPositionAssets", type: "uint256" },
        { name: "totalAssetsCap", type: "uint256" },
        { name: "label", type: "string" },
      ],
    }],
  },
] as const;

const ADAPTER_ABI = [
  {
    name: "registry",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "providerVault",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "strategyId",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    name: "asset",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "previewDeposit",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "assets", type: "uint256" }],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    name: "previewRedeem",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "assets", type: "uint256" }],
  },
] as const;

const SOULESS_VAULT_ABI = [{
  name: "pool",
  type: "function",
  stateMutability: "view",
  inputs: [],
  outputs: [{ name: "", type: "address" }],
}] as const;

const ERC20_ABI = [{
  name: "balanceOf",
  type: "function",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

const UINT256_MAX = (1n << 256n) - 1n;

export function parsePositiveUint(value: unknown, field = "amountRaw"): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,77}$/.test(value)) {
    throw new DefiIntentError(400, "INVALID_AMOUNT", `${field} must be a positive base-unit integer.`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) {
    throw new DefiIntentError(400, "INVALID_AMOUNT", `${field} exceeds the supported amount.`);
  }
  return parsed;
}

export function applySlippageFloor(value: bigint, slippageBps: number): bigint {
  return value * BigInt(10_000 - slippageBps) / 10_000n;
}

export function proportionalSharesCeil(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  if (assets <= 0n || totalAssets <= 0n || totalShares <= 0n) {
    throw new DefiIntentError(409, "EMPTY_POSITION", "This position has no withdrawable balance.");
  }
  return (assets * totalShares + totalAssets - 1n) / totalAssets;
}

export function parsePositionReference(value: unknown): { claimWallet: Address; positionId: bigint } {
  if (typeof value !== "string") {
    throw new DefiIntentError(400, "POSITION_REQUIRED", "Select a position to withdraw from.");
  }
  const match = value.match(/^(0x[a-fA-F0-9]{40}):([1-9][0-9]{0,77})$/);
  if (!match || !isAddress(match[1])) {
    throw new DefiIntentError(400, "INVALID_POSITION", "The selected position is invalid.");
  }
  const positionId = BigInt(match[2]);
  if (positionId > UINT256_MAX) {
    throw new DefiIntentError(400, "INVALID_POSITION", "The selected position is invalid.");
  }
  return { claimWallet: getAddress(match[1]) as Address, positionId };
}

function configuredBps(): number {
  const value = Number(process.env.DEFI_INTENT_SLIPPAGE_BPS || "100");
  return Number.isInteger(value) && value >= 0 && value <= 500 ? value : 100;
}

function configuredDeadlineSeconds(): number {
  const value = Number(process.env.DEFI_INTENT_DEADLINE_SECONDS || "600");
  return Number.isInteger(value) && value >= 60 && value <= 1_800 ? value : 600;
}

function requiredConfiguredAddress(name: string): Address {
  const value = process.env[name]?.trim();
  if (!value || !isAddress(value)) {
    throw new DefiIntentError(503, "ROUTE_NOT_CONFIGURED", "The growth transaction route is not fully configured.");
  }
  return getAddress(value) as Address;
}

async function currentClaimWallet(ownerAddress: Address): Promise<Address> {
  const db = getDb();
  const verified = await db.prepare(
    `SELECT author_id
     FROM verified_claims
     WHERE LOWER(owner_address) = LOWER(?)
     ORDER BY verified_at DESC
     LIMIT 1`
  ).get(ownerAddress) as { author_id?: string } | undefined;
  const linked = verified?.author_id ? undefined : await db.prepare(
    `SELECT x_user_id
     FROM x_accounts
     WHERE LOWER(user_address) = LOWER(?)
     ORDER BY verified_at DESC
     LIMIT 1`
  ).get(ownerAddress) as { x_user_id?: string } | undefined;
  const authorId = verified?.author_id || linked?.x_user_id;
  if (!authorId) {
    throw new DefiIntentError(403, "VERIFIED_CREATOR_REQUIRED", "Verify your creator account before using Grow Tips.");
  }
  const row = await db.prepare(
    `SELECT wallet_address
     FROM claim_wallets
     WHERE author_id = ? AND LOWER(owner_address) = LOWER(?)
     LIMIT 1`
  ).get(authorId, ownerAddress) as { wallet_address?: string } | undefined;
  if (!row?.wallet_address || !isAddress(row.wallet_address)) {
    throw new DefiIntentError(409, "CLAIM_WALLET_REQUIRED", "Your Tips Earned wallet is not ready yet.");
  }
  const claimWallet = getAddress(row.wallet_address) as Address;
  if (!(await claimWalletBelongsToOwner(ownerAddress, claimWallet))) {
    throw new DefiIntentError(403, "CLAIM_WALLET_MISMATCH", "The Tips Earned wallet does not belong to this account.");
  }
  return claimWallet;
}

function assertTransactionRouteEnabled() {
  if (process.env.ENABLE_DEFI_TRANSACTIONS !== "true" || process.env.DEFI_TRANSACTION_ROUTE_READY !== "true") {
    throw new DefiIntentError(423, "DEFI_TRANSACTIONS_DISABLED", "Growth transactions are not enabled yet.");
  }
}

export async function createDefiIntent(input: DefiIntentInput) {
  assertTransactionRouteEnabled();
  const strategy = getDefiStrategy(input.strategyId.toLowerCase());
  if (!strategy || strategy.status !== "ready" || !strategy.transactionEnabled) {
    throw new DefiIntentError(409, "STRATEGY_UNAVAILABLE", "This growth option is not currently available.");
  }
  if (strategy.sourceChainId !== getChainId()) {
    throw new DefiIntentError(409, "WRONG_CHAIN", "Switch to the supported network before continuing.");
  }

  const claimWallet = await currentClaimWallet(input.ownerAddress);
  const registryAddress = requiredConfiguredAddress("STRATEGY_REGISTRY_ADDRESS");
  const configuredAdapter = requiredConfiguredAddress("DEFI_SOULESS_ADAPTER_ADDRESS");
  const configuredVault = requiredConfiguredAddress("DEFI_SOULESS_VAULT_ADDRESS");
  const configuredPool = requiredConfiguredAddress("DEFI_SOULESS_POOL_ADDRESS");
  const configuredAsset = requiredConfiguredAddress("USDC_ADDRESS");
  const client = createBackendPublicClient();

  const [
    onchainOwner,
    walletRegistry,
    available,
    registryStrategy,
    adapterRegistry,
    adapterVault,
    adapterStrategyId,
    adapterAsset,
    vaultPool,
    latestBlock,
  ] = await Promise.all([
    client.readContract({ address: claimWallet, abi: CLAIM_WALLET_ABI, functionName: "owner" }),
    client.readContract({ address: claimWallet, abi: CLAIM_WALLET_ABI, functionName: "strategyRegistry" }),
    client.readContract({
      address: registryAddress,
      abi: REGISTRY_ABI,
      functionName: "isStrategyAvailable",
      args: [input.strategyId],
    }),
    client.readContract({
      address: registryAddress,
      abi: REGISTRY_ABI,
      functionName: "getStrategy",
      args: [input.strategyId],
    }),
    client.readContract({ address: configuredAdapter, abi: ADAPTER_ABI, functionName: "registry" }),
    client.readContract({ address: configuredAdapter, abi: ADAPTER_ABI, functionName: "providerVault" }),
    client.readContract({ address: configuredAdapter, abi: ADAPTER_ABI, functionName: "strategyId" }),
    client.readContract({ address: configuredAdapter, abi: ADAPTER_ABI, functionName: "asset" }),
    client.readContract({ address: configuredVault, abi: SOULESS_VAULT_ABI, functionName: "pool" }),
    client.getBlock({ blockTag: "latest" }),
  ]);

  if (getAddress(onchainOwner) !== getAddress(input.ownerAddress)) {
    throw new DefiIntentError(403, "OWNER_MISMATCH", "The connected wallet does not control this Tips Earned wallet.");
  }
  if (getAddress(walletRegistry) !== registryAddress) {
    throw new DefiIntentError(409, "REGISTRY_MISMATCH", "This Tips Earned wallet is not connected to the current strategy registry.");
  }
  if (!available || !registryStrategy.enabled || registryStrategy.emergencyDisabled) {
    throw new DefiIntentError(409, "STRATEGY_PAUSED", "This growth option is currently paused.");
  }
  if (
    getAddress(registryStrategy.adapter) !== configuredAdapter ||
    getAddress(registryStrategy.asset) !== configuredAsset ||
    getAddress(registryStrategy.positionToken) !== configuredAdapter ||
    getAddress(adapterRegistry) !== registryAddress ||
    getAddress(adapterVault) !== configuredVault ||
    adapterStrategyId.toLowerCase() !== input.strategyId.toLowerCase() ||
    getAddress(adapterAsset) !== configuredAsset ||
    getAddress(vaultPool) !== configuredPool
  ) {
    throw new DefiIntentError(409, "STRATEGY_MISMATCH", "The on-chain strategy does not match Teep's approved configuration.");
  }

  const deadline = latestBlock.timestamp + BigInt(configuredDeadlineSeconds());
  const slippageBps = configuredBps();

  if (input.action === "add") {
    const assets = parsePositiveUint(input.amountRaw);
    if (assets < BigInt(strategy.minDepositRaw)) {
      throw new DefiIntentError(400, "BELOW_MINIMUM", "The amount is below this option's minimum.");
    }
    if (assets > registryStrategy.maxPositionAssets) {
      throw new DefiIntentError(400, "POSITION_CAP_EXCEEDED", "The amount is above this option's per-position limit.");
    }
    const [walletBalance, expectedShares] = await Promise.all([
      client.readContract({ address: configuredAsset, abi: ERC20_ABI, functionName: "balanceOf", args: [claimWallet] }),
      client.readContract({ address: configuredAdapter, abi: ADAPTER_ABI, functionName: "previewDeposit", args: [assets] }),
    ]);
    if (walletBalance < assets) {
      throw new DefiIntentError(400, "INSUFFICIENT_BALANCE", "The amount is higher than your available Tips Earned balance.");
    }
    const minShares = applySlippageFloor(expectedShares, slippageBps);
    if (expectedShares <= 0n || minShares <= 0n) {
      throw new DefiIntentError(409, "INVALID_QUOTE", "A safe growth quote is not available right now.");
    }
    const args = [input.strategyId, assets, minShares, deadline, "0x" as Hex] as const;
    await client.simulateContract({
      account: input.ownerAddress,
      address: claimWallet,
      abi: CLAIM_WALLET_ABI,
      functionName: "allocateToStrategy",
      args,
    });
    return {
      chainId: getChainId(),
      action: input.action,
      strategyId: input.strategyId,
      claimWalletAddress: claimWallet,
      expiresAt: Number(deadline),
      quote: {
        assetsRaw: assets.toString(),
        expectedSharesRaw: expectedShares.toString(),
        minimumSharesRaw: minShares.toString(),
        slippageBps,
      },
      calls: [{
        to: claimWallet,
        data: encodeFunctionData({ abi: CLAIM_WALLET_ABI, functionName: "allocateToStrategy", args }),
      }],
    };
  }

  const reference = parsePositionReference(input.positionId);
  if (reference.claimWallet !== claimWallet) {
    throw new DefiIntentError(403, "POSITION_OWNER_MISMATCH", "The selected position does not belong to this Tips Earned wallet.");
  }
  const indexedPosition = await getDb().prepare(
    `SELECT id, strategy_id, chain_state
     FROM defi_positions
     WHERE id = ? AND LOWER(user_address) = LOWER(?) AND canonical = TRUE
     LIMIT 1`
  ).get(input.positionId, input.ownerAddress) as { id: string; strategy_id: string; chain_state: string } | undefined;
  if (!indexedPosition || indexedPosition.strategy_id.toLowerCase() !== input.strategyId.toLowerCase()) {
    throw new DefiIntentError(404, "POSITION_NOT_FOUND", "The selected indexed position could not be found.");
  }
  if (indexedPosition.chain_state.toUpperCase() !== "ACTIVE") {
    throw new DefiIntentError(409, "POSITION_INACTIVE", "This position is no longer active.");
  }

  const position = await client.readContract({
    address: claimWallet,
    abi: CLAIM_WALLET_ABI,
    functionName: "growPositions",
    args: [reference.positionId],
  });
  const [positionStrategyId, , remainingShares, , , , active] = position;
  if (!active || remainingShares <= 0n) {
    throw new DefiIntentError(409, "POSITION_INACTIVE", "This position is no longer active.");
  }
  if (positionStrategyId.toLowerCase() !== input.strategyId.toLowerCase()) {
    throw new DefiIntentError(409, "POSITION_STRATEGY_MISMATCH", "The selected position belongs to another strategy.");
  }

  const currentAssets = await client.readContract({
    address: configuredAdapter,
    abi: ADAPTER_ABI,
    functionName: "previewRedeem",
    args: [remainingShares],
  });
  if (currentAssets <= 0n) {
    throw new DefiIntentError(409, "EMPTY_POSITION", "This position has no withdrawable balance.");
  }

  let sharesToRedeem = maxUint256;
  if (input.action === "withdraw_partial") {
    const requestedAssets = parsePositiveUint(input.amountRaw);
    if (requestedAssets >= currentAssets) {
      throw new DefiIntentError(400, "USE_WITHDRAW_ALL", "Use Withdraw all for the full position balance.");
    }
    sharesToRedeem = proportionalSharesCeil(requestedAssets, currentAssets, remainingShares);
    if (sharesToRedeem >= remainingShares) {
      throw new DefiIntentError(400, "USE_WITHDRAW_ALL", "Use Withdraw all for the full position balance.");
    }
  }
  const quotedAssets = await client.readContract({
    address: configuredAdapter,
    abi: ADAPTER_ABI,
    functionName: "previewRedeem",
    args: [sharesToRedeem === maxUint256 ? remainingShares : sharesToRedeem],
  });
  const minAssets = applySlippageFloor(quotedAssets, slippageBps);
  if (quotedAssets <= 0n || minAssets <= 0n) {
    throw new DefiIntentError(409, "INVALID_QUOTE", "A safe withdrawal quote is not available right now.");
  }
  const args = [reference.positionId, sharesToRedeem, minAssets, deadline, "0x" as Hex] as const;
  await client.simulateContract({
    account: input.ownerAddress,
    address: claimWallet,
    abi: CLAIM_WALLET_ABI,
    functionName: "exitStrategy",
    args,
  });
  return {
    chainId: getChainId(),
    action: input.action,
    strategyId: input.strategyId,
    positionId: reference.positionId.toString(),
    claimWalletAddress: claimWallet,
    expiresAt: Number(deadline),
    quote: {
      sharesToRedeemRaw: sharesToRedeem.toString(),
      expectedAssetsRaw: quotedAssets.toString(),
      minimumAssetsRaw: minAssets.toString(),
      slippageBps,
    },
    calls: [{
      to: claimWallet,
      data: encodeFunctionData({ abi: CLAIM_WALLET_ABI, functionName: "exitStrategy", args }),
    }],
  };
}

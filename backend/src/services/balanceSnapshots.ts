import type { Address } from "viem";
import { ARC_TESTNET_USDC, getChainId, getRpcUrl } from "../config/chain";
import { one, run } from "../db/database";
import { createBackendPublicClient } from "./rpcClient";
import { recordServiceFailure, recordServiceSuccess } from "./serviceHealth";

const ERC20_ABI = [{
  name: "balanceOf",
  type: "function",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ type: "uint256" }],
}] as const;

const DISPLAY_RPC_TIMEOUT_MS = Math.max(1_000, Number(process.env.DISPLAY_RPC_TIMEOUT_MS || 4_000));
const BALANCE_CACHE_MS = Math.max(0, Number(process.env.BALANCE_CACHE_MS || 15_000));
const chainId = getChainId();
const tokenAddress = (process.env.MOCK_USDC_ADDRESS || process.env.USDC_ADDRESS || ARC_TESTNET_USDC).toLowerCase() as Address;

export type BalanceFreshness = "live" | "cached" | "stale" | "unavailable";

export type BalanceResult = {
  address: string;
  balanceRaw: string | null;
  balanceUsd: string | null;
  freshness: BalanceFreshness;
  live: boolean;
  observedAt: number | null;
};

type MemoryEntry = { balanceRaw: string; observedAt: number };
const memory = new Map<string, MemoryEntry>();
const inFlight = new Map<string, Promise<BalanceResult>>();

export function invalidateDisplayUsdcBalances(addresses: Array<string | null | undefined>): void {
  for (const address of addresses) {
    const normalized = (address || "").trim().toLowerCase();
    if (normalized) memory.delete(normalized);
  }
}

export async function readDisplayUsdcBalance(addressInput: string): Promise<BalanceResult> {
  const address = addressInput.toLowerCase() as Address;
  const cached = memory.get(address);
  if (cached && Date.now() - cached.observedAt <= BALANCE_CACHE_MS) {
    return result(address, cached.balanceRaw, "cached", false, cached.observedAt);
  }

  const pending = inFlight.get(address);
  if (pending) return pending;

  const request = readLiveOrSnapshot(address, true).finally(() => inFlight.delete(address));
  inFlight.set(address, request);
  return request;
}

export async function readLiveUsdcBalance(addressInput: string): Promise<BalanceResult> {
  return readLiveOrSnapshot(addressInput.toLowerCase() as Address, false);
}

async function readLiveOrSnapshot(address: Address, allowSnapshot: boolean): Promise<BalanceResult> {
  try {
    const client = createBackendPublicClient({ url: getRpcUrl(), timeoutMs: DISPLAY_RPC_TIMEOUT_MS });
    const balanceRaw = await client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address],
    });
    const raw = balanceRaw.toString();
    const observedAt = Date.now();
    memory.set(address, { balanceRaw: raw, observedAt });
    await Promise.all([
      run(
        `INSERT INTO wallet_balance_snapshots (
           chain_id, wallet_address, token_address, balance_raw, observed_at, source
         ) VALUES (?, ?, ?, ?, ?, 'rpc')
         ON CONFLICT (chain_id, wallet_address, token_address) DO UPDATE SET
           balance_raw = excluded.balance_raw,
           observed_at = excluded.observed_at,
           source = excluded.source`,
        [chainId, address, tokenAddress, raw, observedAt]
      ),
      recordServiceSuccess("arc_rpc", { operation: "balanceOf" }),
    ]);
    return result(address, raw, "live", true, observedAt);
  } catch (error) {
    await recordServiceFailure("arc_rpc", error, { operation: "balanceOf" }).catch(() => {});
    if (!allowSnapshot) return result(address, null, "unavailable", false, null);
    const snapshot = await one<{ balanceRaw: string; observedAt: number | string }>(
      `SELECT balance_raw as "balanceRaw", observed_at as "observedAt"
       FROM wallet_balance_snapshots
       WHERE chain_id = ? AND wallet_address = ? AND token_address = ?`,
      [chainId, address, tokenAddress]
    );
    if (!snapshot) return result(address, null, "unavailable", false, null);
    return result(address, snapshot.balanceRaw, "stale", false, Number(snapshot.observedAt));
  }
}

function result(address: string, balanceRaw: string | null, freshness: BalanceFreshness, live: boolean, observedAt: number | null): BalanceResult {
  return {
    address,
    balanceRaw,
    balanceUsd: balanceRaw == null ? null : (Number(balanceRaw) / 1e6).toFixed(2),
    freshness,
    live,
    observedAt,
  };
}

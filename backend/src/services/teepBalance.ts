import crypto from "crypto";
import { one, query, run, transaction, type DbClient } from "../db/database";
import { getChainId } from "../config/chain";

export type BalanceRef = {
  userAddress: string;
  tokenAddress: string;
  chainId: number;
};

function normalizeAddress(address: string) {
  return address.toLowerCase();
}

export function getDefaultTokenAddress() {
  return (process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000").toLowerCase();
}

export function getDefaultChainId() {
  return getChainId();
}

export async function getTeepBalance(ref: BalanceRef): Promise<bigint> {
  const row = await one<{ amount_raw: string }>(
    `SELECT amount_raw FROM user_teep_balances
     WHERE LOWER(user_address) = ? AND LOWER(token_address) = ? AND chain_id = ?`,
    [normalizeAddress(ref.userAddress), ref.tokenAddress.toLowerCase(), ref.chainId]
  );
  return BigInt(row?.amount_raw || "0");
}

async function applyLedgerEntry(params: {
  userAddress: string;
  tokenAddress: string;
  chainId: number;
  deltaRaw: bigint;
  reason: string;
  refId?: string;
}, client?: DbClient): Promise<bigint> {
  const userAddress = normalizeAddress(params.userAddress);
  const tokenAddress = params.tokenAddress.toLowerCase();
  const now = Date.now();

  const existing = await one<{ amount_raw: string }>(
    `SELECT amount_raw FROM user_teep_balances
     WHERE user_address = ? AND token_address = ? AND chain_id = ?`,
    [userAddress, tokenAddress, params.chainId],
    client
  );

  const current = BigInt(existing?.amount_raw || "0");
  const next = current + params.deltaRaw;
  if (next < 0n) {
    throw new Error("INSUFFICIENT_BALANCE");
  }

  await run(
    `INSERT INTO user_teep_balances (user_address, token_address, chain_id, amount_raw, updated_at)
     VALUES (?, ?, ?, ?, now())
     ON CONFLICT(user_address, token_address, chain_id)
     DO UPDATE SET amount_raw = excluded.amount_raw, updated_at = now()`,
    [userAddress, tokenAddress, params.chainId, next.toString()],
    client
  );

  await run(
    `INSERT INTO teep_balance_ledger (user_address, token_address, chain_id, delta_raw, balance_after_raw, reason, ref_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
    userAddress,
    tokenAddress,
    params.chainId,
    params.deltaRaw.toString(),
    next.toString(),
    params.reason,
    params.refId ?? null,
    now
    ],
    client
  );

  return next;
}

export async function creditTeepBalance(params: BalanceRef & { amountRaw: bigint; reason: string; refId?: string }, client?: DbClient) {
  if (params.amountRaw <= 0n) throw new Error("INVALID_AMOUNT");
  return applyLedgerEntry({ ...params, deltaRaw: params.amountRaw }, client);
}

export async function debitTeepBalance(params: BalanceRef & { amountRaw: bigint; reason: string; refId?: string }, client?: DbClient) {
  if (params.amountRaw <= 0n) throw new Error("INVALID_AMOUNT");
  return applyLedgerEntry({ ...params, deltaRaw: -params.amountRaw }, client);
}

export async function transferTeepBalance(params: {
  senderAddress: string;
  recipientAddress: string;
  amountRaw: bigint;
  tokenAddress: string;
  chainId: number;
  reason: string;
  refId: string;
}) {
  if (params.amountRaw <= 0n) throw new Error("INVALID_AMOUNT");
  await transaction(async (client) => {
    await debitTeepBalance({
      userAddress: params.senderAddress,
      tokenAddress: params.tokenAddress,
      chainId: params.chainId,
      amountRaw: params.amountRaw,
      reason: params.reason,
      refId: params.refId,
    }, client);
    await creditTeepBalance({
      userAddress: params.recipientAddress,
      tokenAddress: params.tokenAddress,
      chainId: params.chainId,
      amountRaw: params.amountRaw,
      reason: params.reason,
      refId: params.refId,
    }, client);
  });
}

export async function getDailyXBotTipTotal(senderAddress: string, tokenAddress: string, chainId: number): Promise<bigint> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const completed = await one<{ total: string }>(
    `SELECT COALESCE(SUM(CAST(amount_raw AS NUMERIC)), 0) AS total
     FROM x_bot_tips
     WHERE LOWER(sender_address) = ? AND LOWER(token_address) = ?
       AND status = 'completed' AND created_at >= ?`,
    [normalizeAddress(senderAddress), tokenAddress.toLowerCase(), startOfDay.getTime()]
  );
  const claimable = await one<{ total: string }>(
    `SELECT COALESCE(SUM(CAST(amount_raw AS NUMERIC)), 0) AS total
     FROM claimable_tips
     WHERE LOWER(sender_address) = ? AND LOWER(token_address) = ?
       AND status IN ('unclaimed', 'claimed') AND created_at >= ?`,
    [normalizeAddress(senderAddress), tokenAddress.toLowerCase(), startOfDay.getTime()]
  );
  return BigInt(completed?.total || 0) + BigInt(claimable?.total || 0);
}

export async function claimPendingTipsForXUser(xUserId: string, userAddress: string) {
  const tokenAddress = getDefaultTokenAddress();
  const chainId = getDefaultChainId();
  const now = Date.now();
  const pending = await query<{ id: string; amount_raw: string; source_tweet_id: string }>(
    `SELECT id, amount_raw, source_tweet_id FROM claimable_tips
     WHERE recipient_x_user_id = ? AND status = 'unclaimed'
       AND (expires_at IS NULL OR expires_at > ?)`,
    [xUserId, now]
  );

  let claimedCount = 0;
  for (const tip of pending) {
    const amountRaw = BigInt(tip.amount_raw);
    await transaction(async (client) => {
      await creditTeepBalance({
        userAddress,
        tokenAddress,
        chainId,
        amountRaw,
        reason: "claimable_tip",
        refId: tip.id,
      }, client);
      await run(`UPDATE claimable_tips SET status = 'claimed' WHERE id = ? AND status = 'unclaimed'`, [tip.id], client);
    });
    claimedCount += 1;
  }
  return { claimedCount, claimedAt: now };
}

export function createReceiptId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

import { erc20Abi, formatUnits, parseAbi } from "viem";
import { ARC_TESTNET_USDC, getRpcUrl } from "../config/chain";
import { getDb, type DbFacade } from "../db/database";
import { createBackendPublicClient } from "./rpcClient";
export { deletePrivyUser, verifyPrivyUserOwnsAddress } from "./privyAuth";
import { getXTippingRouterAddress } from "./xTippingRouter";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USDC_ADDRESS = (process.env.MOCK_USDC_ADDRESS || process.env.USDC_ADDRESS || ARC_TESTNET_USDC) as `0x${string}`;
const ROUTER_ABI = parseAbi([
  "function permissions(address user) view returns (bool enabled, uint256 maxPerTip, uint256 maxDaily, uint256 spentToday, uint64 day)",
]);

export type DeletionBalance = {
  key: string;
  label: string;
  raw: string;
  decimals: number;
  display: string;
  address?: string;
};

export type DeletionBlocker = {
  key: string;
  label: string;
  count?: number;
  status?: string;
};

async function getLinkedAuthorIds(db: DbFacade, address: string) {
  const rows = await db.prepare(
    `SELECT author_id FROM verified_claims WHERE LOWER(owner_address) = ?
     UNION
     SELECT x_user_id AS author_id FROM x_accounts WHERE LOWER(user_address) = ?`
  ).all<{ author_id: string }>(address, address);
  return rows.map((row) => row.author_id);
}

async function getClaimWalletAddresses(db: DbFacade, address: string, authorIds: string[]) {
  const current = await db.prepare(
    "SELECT wallet_address FROM claim_wallets WHERE LOWER(owner_address) = ?"
  ).all<{ wallet_address: string }>(address);
  if (authorIds.length === 0) return [...new Set(current.map((row) => row.wallet_address.toLowerCase()))];

  const legacy = await db.prepare(
    "SELECT wallet_address FROM claim_wallet_legacy WHERE author_id = ANY(?::text[])"
  ).all<{ wallet_address: string }>(authorIds);
  return [...new Set([...current, ...legacy].map((row) => row.wallet_address.toLowerCase()))];
}

async function readWalletBalances(address: string, labelPrefix: string): Promise<DeletionBalance[]> {
  const client = createBackendPublicClient({ url: getRpcUrl() });
  const wallet = address as `0x${string}`;
  const [nativeRaw, tokenRaw] = await Promise.all([
    client.getBalance({ address: wallet }),
    client.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
  ]);
  return [
    {
      key: `${labelPrefix.toLowerCase().replace(/\s+/g, "_")}_native`,
      label: `${labelPrefix} Arc USDC`,
      raw: nativeRaw.toString(),
      decimals: 18,
      display: formatUnits(nativeRaw, 18),
      address,
    },
    {
      key: `${labelPrefix.toLowerCase().replace(/\s+/g, "_")}_token`,
      label: `${labelPrefix} token USDC`,
      raw: tokenRaw.toString(),
      decimals: 6,
      display: formatUnits(tokenRaw, 6),
      address,
    },
  ];
}

async function countRows(db: DbFacade, sql: string, ...params: unknown[]) {
  const row = await db.prepare(sql).get<{ count: string | number }>(...params);
  return Number(row?.count || 0);
}

export async function getAccountDeleteReadiness(address: string) {
  const normalized = address.toLowerCase();
  const db = getDb();
  const authorIds = await getLinkedAuthorIds(db, normalized);
  const claimWalletAddresses = await getClaimWalletAddresses(db, normalized, authorIds);
  const walletBalanceSets = await Promise.all([
    readWalletBalances(normalized, "Account wallet"),
    ...claimWalletAddresses.map((walletAddress, index) => readWalletBalances(walletAddress, `ClaimWallet ${index + 1}`)),
  ]);
  const balances = walletBalanceSets.flat();

  const internalRows = await db.prepare(
    "SELECT token_address, chain_id, amount_raw FROM user_teep_balances WHERE LOWER(user_address) = ?"
  ).all<{ token_address: string; chain_id: number; amount_raw: string }>(normalized);
  for (const row of internalRows) {
    balances.push({
      key: `teep_internal_${row.chain_id}_${row.token_address.toLowerCase()}`,
      label: "Teep internal balance",
      raw: row.amount_raw,
      decimals: 6,
      display: formatUnits(BigInt(row.amount_raw), 6),
    });
  }

  const positions = await db.prepare(
    `SELECT id, principal_raw, current_value_raw
     FROM defi_positions
     WHERE LOWER(user_address) = ?
       AND (CAST(principal_raw AS NUMERIC) > 0 OR CAST(current_value_raw AS NUMERIC) > 0)`
  ).all<{ id: string; principal_raw: string; current_value_raw: string }>(normalized);
  for (const position of positions) {
    const raw = BigInt(position.current_value_raw) > BigInt(position.principal_raw)
      ? position.current_value_raw
      : position.principal_raw;
    balances.push({ key: `grow_${position.id}`, label: "Grow Tips position", raw, decimals: 6, display: formatUnits(BigInt(raw), 6) });
  }

  const blockers: DeletionBlocker[] = [];
  const addCountBlocker = (key: string, label: string, count: number) => {
    if (count > 0) blockers.push({ key, label, count });
  };
  const authorIdParam = authorIds.length > 0 ? authorIds : ["__none__"];
  addCountBlocker("unsettled_claimable_tips", "Unsettled claimable tips", await countRows(
    db,
    `SELECT COUNT(*) AS count FROM claimable_tips
     WHERE status = 'unclaimed' AND (LOWER(sender_address) = ? OR recipient_x_user_id = ANY(?::text[]))`,
    normalized,
    authorIdParam
  ));
  addCountBlocker("pending_funding", "Pending deposits or funding sessions", await countRows(
    db,
    `SELECT COUNT(*) AS count FROM funding_provider_sessions
     WHERE LOWER(COALESCE(user_address, '')) = ?
       AND LOWER(status) NOT IN ('completed', 'failed', 'cancelled', 'canceled', 'expired', 'refunded')`,
    normalized
  ));
  addCountBlocker("pending_withdrawals", "Pending withdrawal requests", await countRows(
    db,
    `SELECT COUNT(*) AS count FROM withdrawal_confirmations
     WHERE LOWER(owner_address) = ? AND LOWER(status) IN ('pending', 'confirmed') AND expires_at > ?`,
    normalized,
    Date.now()
  ));
  addCountBlocker("pending_grow", "Pending Grow Tips operations", await countRows(
    db,
    `SELECT COUNT(*) AS count FROM defi_transactions
     WHERE LOWER(user_address) = ?
       AND LOWER(status) NOT IN ('completed', 'failed', 'cancelled', 'canceled', 'reverted')`,
    normalized
  ));

  const routerAddress = getXTippingRouterAddress();
  let router = { configured: Boolean(routerAddress), enabled: false, allowanceRaw: "0", requiresRevocation: false };
  if (routerAddress) {
    const client = createBackendPublicClient({ url: getRpcUrl() });
    const [permission, allowance] = await Promise.all([
      client.readContract({ address: routerAddress, abi: ROUTER_ABI, functionName: "permissions", args: [normalized as `0x${string}`] }),
      client.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [normalized as `0x${string}`, routerAddress] }),
    ]);
    router = {
      configured: true,
      enabled: permission[0],
      allowanceRaw: allowance.toString(),
      requiresRevocation: permission[0] || allowance > 0n,
    };
    if (router.requiresRevocation) blockers.push({ key: "x_router_authority", label: "Active X tipping permission or token allowance" });
  }

  const blockingBalances = balances.filter((balance) => BigInt(balance.raw) > 0n);
  return {
    address: normalized,
    canDelete: blockingBalances.length === 0 && blockers.length === 0,
    balances,
    blockingBalances,
    blockingOperations: blockers,
    router,
  };
}

export async function purgeTeepAccountData(address: string) {
  const normalized = address.toLowerCase();
  const db = getDb();
  await db.transaction(async (txDb) => {
    const authorIds = await getLinkedAuthorIds(txDb, normalized);
    const authorIdParam = authorIds.length > 0 ? authorIds : ["__none__"];
    const fundingSessions = await txDb.prepare(
      "SELECT id, provider_session_id FROM funding_provider_sessions WHERE LOWER(COALESCE(user_address, '')) = ?"
    ).all<{ id: string; provider_session_id: string | null }>(normalized);
    const sessionIds = [...new Set(fundingSessions.flatMap((row) => [row.id, row.provider_session_id]).filter((id): id is string => Boolean(id)))];
    const xAccounts = await txDb.prepare(
      `SELECT x_username FROM x_accounts WHERE LOWER(user_address) = ?
       UNION
       SELECT username AS x_username FROM verified_claims WHERE LOWER(owner_address) = ?`
    ).all<{ x_username: string }>(normalized, normalized);
    const xUsernames = [...new Set(xAccounts.map((row) => row.x_username.toLowerCase()))];
    const contentRows = await txDb.prepare(
      "SELECT DISTINCT content_id FROM tips WHERE author_id = ANY(?::text[])"
    ).all<{ content_id: string }>(authorIdParam);
    const contentIds = contentRows.map((row) => row.content_id);

    // Remove this supporter's private Creator Offer access records. Reserved unique
    // codes return to inventory; already claimed codes stay consumed externally.
    await txDb.prepare(
      `UPDATE offer_codes c SET status = 'AVAILABLE', reserved_entitlement_id = NULL, reserved_at = NULL
       FROM offer_entitlements e
       WHERE c.reserved_entitlement_id = e.id AND e.supporter_address = ? AND c.status = 'RESERVED'`
    ).run(normalized);
    await txDb.prepare("UPDATE offer_claims SET supporter_address = ? WHERE supporter_address = ?").run(ZERO_ADDRESS, normalized);
    await txDb.prepare(
      `UPDATE offer_entitlements SET supporter_address = ?, claim_token_ciphertext = NULL,
         status = CASE WHEN status = 'RESERVED_UNCLAIMED' THEN 'REVOKED' ELSE status END,
         updated_at = ? WHERE supporter_address = ?`
    ).run(ZERO_ADDRESS, Date.now(), normalized);

    // Offers without earned entitlements can be deleted. Earned offers are archived
    // and anonymized so supporters keep access to what they already unlocked.
    await txDb.prepare(
      `DELETE FROM creator_offers o
       WHERE o.creator_owner_address = ?
         AND NOT EXISTS (SELECT 1 FROM offer_entitlements e WHERE e.offer_id = o.id)`
    ).run(normalized);
    await txDb.prepare(
      `UPDATE offer_entitlements e
       SET creator_author_id = 'deleted',
           offer_snapshot_json = jsonb_set(e.offer_snapshot_json::jsonb, '{creatorUsername}', '"deleted-creator"'::jsonb)::text,
           updated_at = ?
       FROM creator_offers o
       WHERE e.offer_id = o.id AND o.creator_owner_address = ?`
    ).run(Date.now(), normalized);
    await txDb.prepare(
      `UPDATE offer_events SET actor_id = NULL
       WHERE actor_id = ? OR offer_id IN (SELECT id FROM creator_offers WHERE creator_owner_address = ?)`
    ).run(normalized, normalized);
    await txDb.prepare(
      `UPDATE creator_offers SET creator_author_id = 'deleted', creator_owner_address = ?,
         creator_username = 'deleted-creator', status = 'ARCHIVED', visibility = 'HIDDEN',
         archived_at = COALESCE(archived_at, ?), updated_at = ?
       WHERE creator_owner_address = ?`
    ).run(ZERO_ADDRESS, Date.now(), Date.now(), normalized);

    if (sessionIds.length > 0) {
      await txDb.prepare("DELETE FROM funding_provider_webhooks WHERE session_id = ANY(?::text[])").run(sessionIds);
    }
    await txDb.prepare("DELETE FROM funding_provider_webhooks WHERE LOWER(COALESCE(metadata_json, '')) LIKE ?").run(`%${normalized}%`);
    if (contentIds.length > 0) {
      await txDb.prepare("DELETE FROM post_milestones WHERE content_id = ANY(?::text[])").run(contentIds);
      await txDb.prepare("DELETE FROM milestone_notified WHERE content_id = ANY(?::text[])").run(contentIds);
      await txDb.prepare("DELETE FROM tip_metadata WHERE content_id = ANY(?::text[])").run(contentIds);
    }
    await txDb.prepare("DELETE FROM milestone_notified WHERE author_id = ANY(?::text[])").run(authorIdParam);
    if (xUsernames.length > 0) {
      await txDb.prepare("DELETE FROM tip_metadata WHERE LOWER(author_handle) = ANY(?::text[])").run(xUsernames);
    }

    await txDb.prepare("DELETE FROM user_notifications WHERE LOWER(user_address) = ?").run(normalized);
    await txDb.prepare("DELETE FROM supporter_thank_yous WHERE LOWER(supporter_address) = ? OR LOWER(creator_owner_address) = ? OR creator_author_id = ANY(?::text[])").run(normalized, normalized, authorIdParam);
    await txDb.prepare("DELETE FROM user_activity WHERE LOWER(from_address) = ? OR LOWER(COALESCE(to_address, '')) = ?").run(normalized, normalized);
    await txDb.prepare("DELETE FROM referral_codes WHERE LOWER(referrer_address) = ?").run(normalized);
    await txDb.prepare("DELETE FROM user_referrals WHERE LOWER(user_address) = ? OR LOWER(referrer_address) = ?").run(normalized, normalized);
    await txDb.prepare("DELETE FROM pending_attestations WHERE LOWER(owner_address) = ?").run(normalized);
    await txDb.prepare("DELETE FROM oauth_flows WHERE LOWER(owner_address) = ?").run(normalized);
    await txDb.prepare("DELETE FROM funding_sync_state WHERE LOWER(user_address) = ?").run(normalized);
    await txDb.prepare("DELETE FROM funding_provider_sessions WHERE LOWER(COALESCE(user_address, '')) = ?").run(normalized);
    await txDb.prepare("DELETE FROM defi_transactions WHERE LOWER(user_address) = ?").run(normalized);
    await txDb.prepare("DELETE FROM defi_positions WHERE LOWER(user_address) = ?").run(normalized);
    // Completed withdrawal rows mirror immutable chain transactions. Remove only their local confirmation link.
    await txDb.prepare("UPDATE withdrawal_records SET confirmation_id = NULL WHERE LOWER(owner_address) = ?").run(normalized);
    await txDb.prepare("DELETE FROM withdrawal_confirmations WHERE LOWER(owner_address) = ?").run(normalized);
    await txDb.prepare("DELETE FROM teep_balance_ledger WHERE LOWER(user_address) = ?").run(normalized);
    await txDb.prepare("DELETE FROM user_teep_balances WHERE LOWER(user_address) = ?").run(normalized);
    await txDb.prepare("DELETE FROM x_tipping_permissions WHERE LOWER(user_address) = ?").run(normalized);
    await txDb.prepare("DELETE FROM processed_x_posts WHERE author_x_user_id = ANY(?::text[])").run(authorIdParam);
    await txDb.prepare(
      `DELETE FROM offer_x_notifications n USING x_bot_tips x
       WHERE n.source_tweet_id = x.source_tweet_id
         AND (LOWER(x.sender_address) = ? OR x.recipient_x_user_id = ANY(?::text[]))`
    ).run(normalized, authorIdParam);
    await txDb.prepare("DELETE FROM x_bot_tips WHERE (LOWER(sender_address) = ? OR recipient_x_user_id = ANY(?::text[])) AND tx_hash IS NULL").run(normalized, authorIdParam);
    await txDb.prepare(
      `UPDATE x_bot_tips
       SET recipient_x_username = NULL
       WHERE tx_hash IS NOT NULL AND recipient_x_user_id = ANY(?::text[])`
    ).run(authorIdParam);
    await txDb.prepare(
      `UPDATE x_bot_tips
       SET context_author_username = NULL, context_author_name = NULL, context_author_profile_image_url = NULL
       WHERE tx_hash IS NOT NULL AND context_author_id = ANY(?::text[])`
    ).run(authorIdParam);
    await txDb.prepare("DELETE FROM claimable_tips WHERE recipient_x_user_id = ANY(?::text[])").run(authorIdParam);
    await txDb.prepare("UPDATE claimable_tips SET sender_address = ? WHERE LOWER(sender_address) = ?").run(ZERO_ADDRESS, normalized);
    await txDb.prepare("DELETE FROM security_events WHERE LOWER(COALESCE(actor_address, '')) = ?").run(normalized);
    await txDb.prepare("DELETE FROM abuse_events WHERE LOWER(COALESCE(actor_address, '')) = ? OR LOWER(COALESCE(counterparty_address, '')) = ? OR author_id = ANY(?::text[])").run(normalized, normalized, authorIdParam);
    await txDb.prepare("DELETE FROM ops_events WHERE LOWER(COALESCE(message, '')) LIKE ? OR LOWER(COALESCE(metadata_json, '')) LIKE ?").run(`%${normalized}%`, `%${normalized}%`);
    await txDb.prepare("DELETE FROM verified_claims WHERE LOWER(owner_address) = ?").run(normalized);
    await txDb.prepare("DELETE FROM x_accounts WHERE LOWER(user_address) = ?").run(normalized);
    await txDb.prepare("DELETE FROM user_settings WHERE LOWER(address) = ?").run(normalized);
  })();
}

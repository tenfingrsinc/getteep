import { Router, Request, Response } from "express";
import { getDb } from "../db/database";

const router = Router();
const USDC_DECIMALS = 1_000_000;

function requireOpsToken(req: Request, res: Response): boolean {
  const token = process.env.OPS_TOKEN;
  if (!token) {
    if (process.env.NODE_ENV === "production") {
      res.status(503).json({ error: "OPS_TOKEN is not configured" });
      return false;
    }
    return true;
  }
  const header = req.headers.authorization || "";
  if (header !== `Bearer ${token}`) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function usdFromRaw(value: unknown): number {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric / USDC_DECIMALS : 0;
}

function mapClientMethod(method: unknown): string {
  const raw = typeof method === "string" ? method : "";
  if (raw === "extension") return "extension";
  if (raw.startsWith("web_") || raw === "creator_profile") return "web";
  if (raw) return raw;
  return "unknown_client";
}

async function rows<T = Record<string, unknown>>(statement: string, ...params: unknown[]): Promise<T[]> {
  return getDb().prepare(statement).all(...params) as Promise<T[]>;
}

async function one<T = Record<string, unknown>>(statement: string, ...params: unknown[]): Promise<T | undefined> {
  return getDb().prepare(statement).get(...params) as Promise<T | undefined>;
}

router.get("/dashboard", async (req: Request, res: Response) => {
  if (!requireOpsToken(req, res)) return;

  const limit = Math.min(Math.max(Number(req.query.limit || 25), 5), 100);
  const since24h = Math.floor(Date.now() / 1000) - 86_400;
  const since30d = Math.floor(Date.now() / 1000) - 86_400 * 30;
  const since24hMs = Date.now() - 86_400_000;

  const indexed = await one<{ count: string; raw: string; uniqueTippers: string }>(
    "SELECT COUNT(*) as count, COALESCE(SUM(CAST(amount AS NUMERIC)), 0) as raw, COUNT(DISTINCT from_address) as uniqueTippers FROM tips"
  ) || { count: 0, raw: 0, uniqueTippers: 0 };
  const indexed24h = await one<{ count: string; raw: string }>(
    "SELECT COUNT(*) as count, COALESCE(SUM(CAST(amount AS NUMERIC)), 0) as raw FROM tips WHERE timestamp >= ?",
    since24h
  ) || { count: 0, raw: 0 };
  const xSettled = await one<{ count: string; raw: string }>(
    "SELECT COUNT(*) as count, COALESCE(SUM(CAST(amount_raw AS NUMERIC)), 0) as raw FROM x_bot_tips"
  ) || { count: 0, raw: 0 };
  const xClaimable = await one<{ count: string; raw: string }>(
    "SELECT COUNT(*) as count, COALESCE(SUM(CAST(amount_raw AS NUMERIC)), 0) as raw FROM claimable_tips"
  ) || { count: 0, raw: 0 };
  const withdrawals = await one<{ count: string; raw: string }>(
    "SELECT COUNT(*) as count, COALESCE(SUM(CAST(amount_raw AS NUMERIC)), 0) as raw FROM withdrawal_records"
  ) || { count: 0, raw: 0 };
  const creators = await one<{ count: string }>("SELECT COUNT(DISTINCT owner_address) as count FROM verified_claims") || { count: 0 };

  const clientSourceRows = await rows<{ sourceMethod: string | null; count: string; raw: string }>(
    `SELECT source_method as sourceMethod, COUNT(*) as count, COALESCE(SUM(CAST(amount AS NUMERIC)), 0) as raw
     FROM user_activity
     WHERE type IN ('tip_sent', 'direct_creator_tip')
     GROUP BY source_method`
  );
  const sourceMap = new Map<string, { key: string; label: string; count: number; usd: number }>();
  const addSource = (key: string, label: string, count: number, usd: number) => {
    const current = sourceMap.get(key) || { key, label, count: 0, usd: 0 };
    current.count += Number(count || 0);
    current.usd += Number(usd || 0);
    sourceMap.set(key, current);
  };
  for (const row of clientSourceRows) {
    const key = mapClientMethod(row.sourceMethod);
    const label =
      key === "web" ? "Web app" :
      key === "extension" ? "Extension" :
      key === "unknown_client" ? "Indexed, source unknown" :
      key.replace(/_/g, " ");
    addSource(key, label, Number(row.count || 0), usdFromRaw(row.raw));
  }
  addSource("x_bot", "X bot", Number(xSettled.count) + Number(xClaimable.count), usdFromRaw(xSettled.raw) + usdFromRaw(xClaimable.raw));

  const recentTips = await rows(
    `SELECT t.tx_hash as txHash, t.content_id as contentId, t.author_id as authorId, t.from_address as fromAddress,
            t.to_address as toAddress, t.amount as amountRaw, t.timestamp,
            m.author_handle as authorHandle, m.kind,
            ua.source_method as sourceMethod
       FROM tips t
       LEFT JOIN tip_metadata m ON LOWER(m.content_id) = LOWER(t.content_id)
       LEFT JOIN user_activity ua ON LOWER(ua.tx_hash) = LOWER(t.tx_hash)
      ORDER BY t.timestamp DESC
      LIMIT ?`,
    limit
  );
  const recentXBot = await rows(
    `SELECT 'settled' as bucket, sender_address as senderAddress, recipient_address as recipientAddress,
            recipient_x_username as recipientXUsername, amount_raw as amountRaw, source_tweet_id as sourceTweetId,
            receipt_id as receiptId, status, created_at as createdAt
       FROM x_bot_tips
      UNION ALL
     SELECT 'claimable' as bucket, sender_address as senderAddress, NULL as recipientAddress,
            recipient_x_username as recipientXUsername, amount_raw as amountRaw, source_tweet_id as sourceTweetId,
            receipt_id as receiptId, status, created_at as createdAt
       FROM claimable_tips
      ORDER BY createdAt DESC
      LIMIT ?`,
    limit
  );
  const recentWithdrawals = await rows(
    `SELECT owner_address as ownerAddress, destination_address as destinationAddress, source, amount_raw as amountRaw,
            tx_hash as txHash, created_at as createdAt
       FROM withdrawal_records
      ORDER BY created_at DESC
      LIMIT ?`,
    limit
  );
  const recentEvents = await rows(
    `SELECT level, source, event_type as eventType, message, metadata_json as metadataJson, created_at as createdAt
       FROM ops_events
      WHERE level IN ('warn', 'error')
      ORDER BY created_at DESC
      LIMIT ?`,
    limit
  );
  const securityEvents = await rows(
    `SELECT event_type as eventType, actor_address as actorAddress, route, reason, created_at as createdAt
       FROM security_events
      ORDER BY created_at DESC
      LIMIT ?`,
    limit
  );
  const abuseOpen = await rows(
    `SELECT id, severity, event_type as eventType, actor_address as actorAddress, counterparty_address as counterpartyAddress,
            reason, status, created_at as createdAt
       FROM abuse_events
      WHERE status IN ('open', 'reviewing')
      ORDER BY created_at DESC
      LIMIT ?`,
    limit
  );
  const indexerState = await one(
    "SELECT last_block as lastBlock, current_block as currentBlock, updated_at as updatedAt, last_success_at as lastSuccessAt, last_error as lastError, last_error_at as lastErrorAt FROM indexer_state WHERE id = 1"
  );
  const opsLevelCounts = await rows(
    `SELECT level, COUNT(*) as count
       FROM ops_events
      WHERE created_at >= ?
      GROUP BY level`,
    since24hMs
  );
  const activityByDay = await rows(
    `SELECT to_char(to_timestamp(timestamp), 'YYYY-MM-DD') as day, COUNT(*) as count, COALESCE(SUM(CAST(amount AS NUMERIC)), 0) as raw
       FROM tips
      WHERE timestamp >= ?
      GROUP BY day
      ORDER BY day ASC`,
    since30d
  );

  res.json({
    generatedAt: Date.now(),
    mode: process.env.OPS_TOKEN ? "token_required" : "dev_open",
    metrics: {
      indexedTips: Number(indexed.count),
      indexedTipVolumeUsd: usdFromRaw(indexed.raw),
      indexedTips24h: Number(indexed24h.count),
      indexedTipVolume24hUsd: usdFromRaw(indexed24h.raw),
      uniqueTippers: Number(indexed.uniqueTippers),
      xBotTips: Number(xSettled.count) + Number(xClaimable.count),
      xBotVolumeUsd: usdFromRaw(xSettled.raw) + usdFromRaw(xClaimable.raw),
      withdrawals: Number(withdrawals.count),
      withdrawalVolumeUsd: usdFromRaw(withdrawals.raw),
      verifiedCreators: Number(creators.count),
    },
    sourceBreakdown: Array.from(sourceMap.values()).sort((a, b) => b.usd - a.usd),
    activityByDay: activityByDay.map((row: any) => ({ ...row, usd: usdFromRaw(row.raw) })),
    health: {
      indexerState,
      opsLevelCounts,
      openAbuseEvents: abuseOpen.length,
      recentSecurityEvents: securityEvents.length,
    },
    tables: {
      recentTips,
      recentXBot,
      recentWithdrawals,
      recentEvents,
      securityEvents,
      abuseOpen,
    },
  });
});

router.get("/events", async (req: Request, res: Response) => {
  if (!requireOpsToken(req, res)) return;
  const limit = Math.min(Number(req.query.limit || 50), 100);
  const db = getDb();
  const opsEvents = await db.prepare(
    "SELECT level, source, event_type, message, metadata_json, created_at FROM ops_events ORDER BY created_at DESC LIMIT ?"
  ).all(limit);
  const abuseEvents = await db.prepare(
    "SELECT severity, event_type, actor_address, counterparty_address, author_id, content_id, tx_hash, reason, metadata_json, status, created_at FROM abuse_events ORDER BY created_at DESC LIMIT ?"
  ).all(limit);
  const securityEvents = await db.prepare(
    "SELECT event_type, actor_address, route, reason, created_at FROM security_events ORDER BY created_at DESC LIMIT ?"
  ).all(limit);
  res.json({ opsEvents, abuseEvents, securityEvents });
});

router.get("/abuse/summary", async (req: Request, res: Response) => {
  if (!requireOpsToken(req, res)) return;
  const db = getDb();
  const totals = await db.prepare(
    "SELECT event_type, severity, status, COUNT(*) as count FROM abuse_events GROUP BY event_type, severity, status ORDER BY count DESC"
  ).all();
  const recent = await db.prepare(
    "SELECT severity, event_type, actor_address, counterparty_address, reason, status, created_at FROM abuse_events ORDER BY created_at DESC LIMIT 50"
  ).all();
  res.json({ totals, recent });
});

router.get("/indexer/state", async (req: Request, res: Response) => {
  if (!requireOpsToken(req, res)) return;
  const state = await getDb()
    .prepare("SELECT last_block, current_block, updated_at, last_success_at, last_error, last_error_at FROM indexer_state WHERE id = 1")
    .get();
  res.json({ state });
});

router.post("/indexer/rewind", async (req: Request, res: Response) => {
  if (!requireOpsToken(req, res)) return;
  let fromBlock: bigint;
  try {
    fromBlock = BigInt(String(req.body?.fromBlock ?? ""));
  } catch {
    res.status(400).json({ error: "fromBlock must be a non-negative integer" });
    return;
  }
  if (fromBlock < 0n) {
    res.status(400).json({ error: "fromBlock must be a non-negative integer" });
    return;
  }
  const nextLastBlock = fromBlock > 0n ? fromBlock - 1n : 0n;
  await getDb()
    .prepare("UPDATE indexer_state SET last_block = ?, last_error = NULL, updated_at = now() WHERE id = 1")
    .run(nextLastBlock.toString());
  res.json({
    success: true,
    lastBlock: nextLastBlock.toString(),
    message: `Indexer will resume from block ${fromBlock.toString()} on the next poll.`,
  });
});

router.post("/abuse/:id/status", async (req: Request, res: Response) => {
  if (!requireOpsToken(req, res)) return;
  const id = Number(req.params.id);
  const status = String(req.body?.status || "");
  if (!Number.isSafeInteger(id) || !["open", "reviewing", "resolved", "ignored"].includes(status)) {
    res.status(400).json({ error: "Valid id and status required" });
    return;
  }
  await getDb().prepare("UPDATE abuse_events SET status = ? WHERE id = ?").run(status, id);
  res.json({ success: true });
});

export default router;

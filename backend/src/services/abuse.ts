import { one, query, run } from "../db/database";
import { recordOpsEvent } from "./ops";

const DAY_SECONDS = 24 * 60 * 60;
const HIGH_FREQUENCY_TIP_COUNT = parseInt(process.env.ABUSE_HIGH_FREQUENCY_TIP_COUNT || "25", 10);
const CIRCULAR_TIP_WINDOW_SECONDS = parseInt(process.env.ABUSE_CIRCULAR_TIP_WINDOW_SECONDS || String(7 * DAY_SECONDS), 10);
const WASH_REFERRAL_WINDOW_SECONDS = parseInt(process.env.ABUSE_WASH_REFERRAL_WINDOW_SECONDS || String(14 * DAY_SECONDS), 10);

async function insertAbuseEvent(params: {
  severity: "low" | "medium" | "high";
  eventType: string;
  actorAddress?: string | null;
  counterpartyAddress?: string | null;
  authorId?: string | null;
  contentId?: string | null;
  txHash?: string | null;
  reason: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;
    await run(`
      INSERT INTO abuse_events (
        severity, event_type, actor_address, counterparty_address, author_id, content_id, tx_hash, reason, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      params.severity,
      params.eventType,
      params.actorAddress?.toLowerCase() || null,
      params.counterpartyAddress?.toLowerCase() || null,
      params.authorId || null,
      params.contentId || null,
      params.txHash?.toLowerCase() || null,
      params.reason,
      metadataJson,
      Date.now()
    ]);
  } catch {}
}

async function countOpenRecent(eventType: string, actorAddress: string, reason: string, sinceMs: number): Promise<number> {
  const row = await one<{ c: string }>(
    "SELECT COUNT(*) as c FROM abuse_events WHERE event_type = ? AND actor_address = ? AND reason = ? AND created_at >= ?",
    [eventType, actorAddress.toLowerCase(), reason, sinceMs]
  );
  return Number(row?.c ?? 0);
}

export async function inspectTipForAbuse(params: {
  fromAddress: string;
  toAddress: string;
  authorId: string;
  contentId: string;
  amountRaw: string;
  txHash: string;
}) {
  const from = params.fromAddress.toLowerCase();
  const to = params.toAddress.toLowerCase();
  const nowSeconds = Math.floor(Date.now() / 1000);

  const claim = await one<{ owner_address: string }>(
    "SELECT owner_address FROM verified_claims WHERE author_id = ? LIMIT 1",
    [params.authorId]
  );

  if (claim?.owner_address?.toLowerCase() === from && await countOpenRecent("self_tipping", from, params.authorId, Date.now() - DAY_SECONDS * 1000) === 0) {
    await insertAbuseEvent({
      severity: "high",
      eventType: "self_tipping",
      actorAddress: from,
      counterpartyAddress: to,
      authorId: params.authorId,
      contentId: params.contentId,
      txHash: params.txHash,
      reason: params.authorId,
      metadata: { amountRaw: params.amountRaw },
    });
  }

  const reciprocal = await one<{ c: string }>(
    `SELECT COUNT(*) as c FROM tips
     WHERE from_address = ? AND to_address = ? AND timestamp >= ?`
  , [to, from, nowSeconds - CIRCULAR_TIP_WINDOW_SECONDS]);
  if (Number(reciprocal?.c ?? 0) > 0 && await countOpenRecent("circular_tipping", from, to, Date.now() - DAY_SECONDS * 1000) === 0) {
    await insertAbuseEvent({
      severity: "medium",
      eventType: "circular_tipping",
      actorAddress: from,
      counterpartyAddress: to,
      authorId: params.authorId,
      contentId: params.contentId,
      txHash: params.txHash,
      reason: to,
      metadata: { reciprocalCount: Number(reciprocal?.c ?? 0), windowSeconds: CIRCULAR_TIP_WINDOW_SECONDS },
    });
  }

  const frequency = await one<{ c: string }>(
    "SELECT COUNT(*) as c FROM tips WHERE from_address = ? AND timestamp >= ?"
  , [from, nowSeconds - DAY_SECONDS]);
  if (Number(frequency?.c ?? 0) >= HIGH_FREQUENCY_TIP_COUNT && await countOpenRecent("high_frequency_tipping", from, "daily", Date.now() - DAY_SECONDS * 1000) === 0) {
    await insertAbuseEvent({
      severity: "low",
      eventType: "high_frequency_tipping",
      actorAddress: from,
      reason: "daily",
      txHash: params.txHash,
      metadata: { count: Number(frequency?.c ?? 0), threshold: HIGH_FREQUENCY_TIP_COUNT },
    });
  }

  const referral = await one<{ referrer_address: string }>(
    "SELECT referrer_address FROM user_referrals WHERE user_address = ?",
    [from]
  );
  if (referral?.referrer_address) {
    const referrer = referral.referrer_address.toLowerCase();
    const referrerClaim = await one<{ author_id: string }>(
      "SELECT author_id FROM verified_claims WHERE owner_address = ? LIMIT 1",
      [referrer]
    );
    if (referrerClaim?.author_id === params.authorId) {
      const recentToReferrer = await one<{ c: string }>(
        "SELECT COUNT(*) as c FROM tips WHERE from_address = ? AND author_id = ? AND timestamp >= ?"
      , [from, params.authorId, nowSeconds - WASH_REFERRAL_WINDOW_SECONDS]);
      if (Number(recentToReferrer?.c ?? 0) > 0 && await countOpenRecent("wash_referral", from, referrer, Date.now() - DAY_SECONDS * 1000) === 0) {
        await insertAbuseEvent({
          severity: "medium",
          eventType: "wash_referral",
          actorAddress: from,
          counterpartyAddress: referrer,
          authorId: params.authorId,
          txHash: params.txHash,
          reason: referrer,
          metadata: { tipsToReferrer: Number(recentToReferrer?.c ?? 0), windowSeconds: WASH_REFERRAL_WINDOW_SECONDS },
        });
      }
    }
  }
}

export async function inspectReferralForAbuse(userAddress: string, referrerAddress: string, referralCode: string) {
  const user = userAddress.toLowerCase();
  const referrer = referrerAddress.toLowerCase();

  const reciprocal = await one("SELECT 1 FROM user_referrals WHERE user_address = ? AND referrer_address = ? LIMIT 1", [referrer, user]);
  if (reciprocal) {
    await insertAbuseEvent({
      severity: "high",
      eventType: "reciprocal_referral",
      actorAddress: user,
      counterpartyAddress: referrer,
      reason: referralCode,
    });
  }

  const sameCreator = await one<{ c: string }>(
    `SELECT COUNT(DISTINCT author_id) as c FROM verified_claims
     WHERE owner_address IN (?, ?)`
  , [user, referrer]);
  if (Number(sameCreator?.c ?? 0) === 1) {
    await insertAbuseEvent({
      severity: "high",
      eventType: "creator_referral_self_link",
      actorAddress: user,
      counterpartyAddress: referrer,
      reason: referralCode,
    });
  }
}

export async function summarizeOpenAbuseEvents(limit = 20) {
  const totals = await query<{ event_type: string; severity: string; count: string }>(
    "SELECT event_type, severity, COUNT(*) as count FROM abuse_events WHERE status = 'open' GROUP BY event_type, severity ORDER BY count DESC"
  );
  const recent = await query<Record<string, unknown>>(
    "SELECT severity, event_type, actor_address, reason, created_at FROM abuse_events WHERE status = 'open' ORDER BY created_at DESC LIMIT ?",
    [limit]
  );
  return { totals, recent };
}

export async function logAbuseSummary() {
  const summary = await summarizeOpenAbuseEvents(5);
  if (summary.recent.length) {
    await recordOpsEvent({
      level: "warn",
      source: "abuse",
      eventType: "open_abuse_events",
      message: `${summary.recent.length} recent open abuse events`,
      metadata: { totals: summary.totals },
    });
  }
}

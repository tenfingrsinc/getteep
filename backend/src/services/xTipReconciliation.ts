import { getDb } from "../db/database";
import { publishDashboardUpdate } from "./dashboardUpdates";
import { createBackendPublicClient } from "./rpcClient";
import {
  recordServiceFailure,
  recordServiceSuccess,
  sanitizeOperationalError,
} from "./serviceHealth";
import { requeueOfferEvaluationsForContent } from "./creatorOffers";
import { recoverMissingCompletedXTips } from "./xTipLedgerRecovery";

type SubmittedXTip = {
  sourceTweetId: string;
  receiptId: string;
  txHash: `0x${string}`;
  senderAddress: string;
  recipientAddress: string | null;
  recipientXUserId: string;
  contentId: string | null;
};

function positiveNumber(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function receiptNotFound(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return /TransactionReceiptNotFound/i.test(name) || /transaction receipt.*not found|could not be found/i.test(message);
}

async function markConfirmed(row: SubmittedXTip, source: "goldsky" | "rpc") {
  const now = Date.now();
  await getDb().transaction(async (db) => {
    await db.prepare(
      `UPDATE x_bot_tips
       SET status = 'completed', confirmed_at = COALESCE(confirmed_at, ?),
           updated_at = ?, last_error = NULL
       WHERE source_tweet_id = ? AND status = 'submitted'`
    ).run(now, now, row.sourceTweetId);
    await db.prepare(
      `UPDATE processed_x_posts
       SET status = 'completed', reason = ?, receipt_id = COALESCE(receipt_id, ?), updated_at = ?
       WHERE tweet_id = ? AND status = 'submitted'`
    ).run(source === "goldsky" ? "CONFIRMED_VIA_GOLDSKY" : "CONFIRMED_VIA_RPC", row.receiptId, now, row.sourceTweetId);
  });

  if (row.contentId) {
    await requeueOfferEvaluationsForContent(row.contentId).catch((error) => {
      console.error(`[XBot] Could not requeue reconciled tip ${row.txHash}: ${sanitizeOperationalError(error)}`);
    });
  }
  await publishDashboardUpdate({
    reason: "x_tip_confirmed",
    addresses: [row.senderAddress, row.recipientAddress],
    authorIds: [row.recipientXUserId],
  }).catch((error) => console.error(`[XBot] Could not publish reconciled tip update: ${sanitizeOperationalError(error)}`));
  console.log(`[XBot] Reconciled submitted tip ${row.sourceTweetId} as completed via ${source} (${row.txHash})`);
}

async function markReverted(row: SubmittedXTip) {
  const now = Date.now();
  await getDb().transaction(async (db) => {
    await db.prepare(
      `UPDATE x_bot_tips
       SET status = 'failed', updated_at = ?, last_error = 'Transaction reverted'
       WHERE source_tweet_id = ? AND status = 'submitted'`
    ).run(now, row.sourceTweetId);
    await db.prepare(
      `UPDATE processed_x_posts
       SET status = 'failed', reason = 'X_TIP_REVERTED', updated_at = ?
       WHERE tweet_id = ? AND status = 'submitted'`
    ).run(now, row.sourceTweetId);
  });
  console.warn(`[XBot] Reconciled submitted tip ${row.sourceTweetId} as reverted (${row.txHash})`);
}

export async function reconcileSubmittedXTips(): Promise<number> {
  const limit = positiveNumber(process.env.X_TIP_RECONCILIATION_BATCH_SIZE, 25, 1);
  const rows = await getDb().prepare(
    `SELECT source_tweet_id as "sourceTweetId", receipt_id as "receiptId", tx_hash as "txHash",
            sender_address as "senderAddress", recipient_address as "recipientAddress",
            recipient_x_user_id as "recipientXUserId", content_id as "contentId"
     FROM x_bot_tips
     WHERE status = 'submitted' AND tx_hash IS NOT NULL
     ORDER BY COALESCE(updated_at, created_at) ASC
     LIMIT ?`
  ).all<SubmittedXTip>(limit);
  if (!rows.length) return 0;

  const publicClient = createBackendPublicClient({
    timeoutMs: positiveNumber(process.env.RPC_HEALTH_PROBE_TIMEOUT_MS, 5_000, 1_000),
  });
  let reconciled = 0;
  for (const row of rows) {
    const projected = await getDb().prepare(
      `SELECT tx_hash FROM tips WHERE LOWER(tx_hash) = LOWER(?) LIMIT 1`
    ).get<{ tx_hash: string }>(row.txHash);
    if (projected) {
      await markConfirmed(row, "goldsky");
      reconciled += 1;
      continue;
    }

    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: row.txHash });
      await recordServiceSuccess("arc_rpc", { operation: "x_tip_reconciliation" }).catch(() => undefined);
      if (receipt.status === "success") await markConfirmed(row, "rpc");
      else await markReverted(row);
      reconciled += 1;
    } catch (error) {
      if (receiptNotFound(error)) {
        await recordServiceSuccess("arc_rpc", { operation: "x_tip_reconciliation_not_found" }).catch(() => undefined);
        continue;
      }
      const message = sanitizeOperationalError(error);
      await recordServiceFailure("arc_rpc", error, { operation: "x_tip_reconciliation" }).catch(() => undefined);
      await getDb().prepare(
        `UPDATE x_bot_tips SET updated_at = ?, last_error = ?
         WHERE source_tweet_id = ? AND status = 'submitted'`
      ).run(Date.now(), message, row.sourceTweetId).catch(() => undefined);
    }
  }
  return reconciled;
}

export class XTipReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start() {
    if (process.env.X_TIP_RECONCILIATION_ENABLED === "false") return;
    const intervalMs = positiveNumber(process.env.X_TIP_RECONCILIATION_INTERVAL_MS, 15_000, 5_000);
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        const recovered = await recoverMissingCompletedXTips();
        if (recovered > 0) console.log(`[XBot] Recovered ${recovered} missing completed X-tip ledger row(s)`);
        await reconcileSubmittedXTips();
      } catch (error) {
        console.error(`[XBot] Reconciliation failed: ${sanitizeOperationalError(error)}`);
      } finally {
        this.running = false;
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref?.();
    console.log(`[XBot] Submitted-tip reconciliation enabled (${intervalMs}ms interval)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

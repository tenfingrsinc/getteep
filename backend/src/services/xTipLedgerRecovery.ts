import crypto from "node:crypto";
import { parseUnits } from "viem";
import { getDb } from "../db/database";
import { publishDashboardUpdate } from "./dashboardUpdates";
import { getDefaultTokenAddress } from "./teepBalance";

type MissingLedgerRow = {
  tweetId: string;
  receiptId: string;
  replyText: string;
  createdAt: number | string;
  senderAddress: string;
};

type IndexedTipCandidate = {
  contentId: string;
  authorId: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  txHash: string;
  timestamp: number | string;
};

function parseCompletedReply(replyText: string): { recipientHandle: string; amountRaw: string } | null {
  const match = replyText.match(/\btipped\s+@([a-z0-9_]{1,15})\s+(\d+(?:\.\d{1,6})?)\s+USD\b/i);
  if (!match) return null;
  try {
    return { recipientHandle: match[1], amountRaw: parseUnits(match[2], 6).toString() };
  } catch {
    return null;
  }
}

async function missingRow(receiptId: string): Promise<MissingLedgerRow | undefined> {
  return getDb().prepare(
    `SELECT p.tweet_id as "tweetId", p.receipt_id as "receiptId", p.reply_text as "replyText",
            p.created_at as "createdAt", xa.user_address as "senderAddress"
     FROM processed_x_posts p
     JOIN x_accounts xa ON xa.x_user_id = p.author_x_user_id
     LEFT JOIN x_bot_tips xbt ON xbt.receipt_id = p.receipt_id
     WHERE p.receipt_id = ? AND p.status = 'completed' AND p.reply_text IS NOT NULL
       AND xbt.receipt_id IS NULL
     LIMIT 1`
  ).get<MissingLedgerRow>(receiptId);
}

async function recipientAuthorIds(handle: string): Promise<string[]> {
  const rows = await getDb().prepare(
    `SELECT author_id as "authorId" FROM verified_claims WHERE LOWER(username) = LOWER(?)
     UNION
     SELECT x_user_id as "authorId" FROM x_accounts WHERE LOWER(x_username) = LOWER(?)`
  ).all<{ authorId: string }>(handle, handle);
  return [...new Set(rows.map((row) => row.authorId).filter(Boolean))];
}

async function uniqueIndexedCandidate(
  row: MissingLedgerRow,
  recipientHandle: string,
  amountRaw: string,
): Promise<IndexedTipCandidate | null> {
  const authorIds = await recipientAuthorIds(recipientHandle);
  const commandTime = Math.floor(Number(row.createdAt) / 1000);
  const placeholders = authorIds.map(() => "?").join(", ");
  const authorClause = authorIds.length ? `AND t.author_id IN (${placeholders})` : "";
  const candidates = await getDb().prepare(
    `SELECT t.content_id as "contentId", t.author_id as "authorId",
            t.from_address as "fromAddress", t.to_address as "toAddress",
            t.amount, t.tx_hash as "txHash", t.timestamp
     FROM tips t
     LEFT JOIN x_bot_tips xbt ON LOWER(xbt.tx_hash) = LOWER(t.tx_hash)
     WHERE LOWER(t.from_address) = LOWER(?)
       ${authorClause}
       AND CAST(t.amount AS NUMERIC) = CAST(? AS NUMERIC)
       AND t.timestamp BETWEEN ? AND ?
       AND xbt.tx_hash IS NULL
     ORDER BY ABS(t.timestamp - ?) ASC
     LIMIT 2`
  ).all<IndexedTipCandidate>(
    row.senderAddress,
    ...authorIds,
    amountRaw,
    commandTime - 600,
    commandTime + 600,
    commandTime,
  );
  return candidates.length === 1 ? candidates[0] : null;
}

export async function recoverCompletedXTipByReceipt(receiptId: string): Promise<boolean> {
  if (!/^[a-f0-9]{16}$/i.test(receiptId)) return false;
  const row = await missingRow(receiptId);
  if (!row) return false;
  const parsed = parseCompletedReply(row.replyText);
  if (!parsed) return false;
  const candidate = await uniqueIndexedCandidate(row, parsed.recipientHandle, parsed.amountRaw);
  if (!candidate) return false;
  const now = Date.now();
  const inserted = await getDb().transaction(async (db) => {
    await db.prepare(
      `INSERT INTO tip_metadata (content_id, author_handle, tweet_id, kind)
       VALUES (?, ?, NULL, 'direct_creator_tip')
       ON CONFLICT(content_id) DO UPDATE SET
         author_handle = COALESCE(tip_metadata.author_handle, excluded.author_handle),
         kind = COALESCE(tip_metadata.kind, excluded.kind)`
    ).run(candidate.contentId, parsed.recipientHandle);
    return db.prepare(
      `INSERT INTO x_bot_tips (
         id, sender_address, recipient_address, recipient_x_user_id, recipient_x_username,
         token_address, amount_raw, source_tweet_id, receipt_id, tx_hash, status, created_at,
         tip_kind, content_id, updated_at, confirmed_at, last_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?,
                 'direct_creator_tip', ?, ?, ?, 'RECOVERED_FROM_INDEXED_TIP')
       ON CONFLICT DO NOTHING`
    ).run(
      crypto.randomUUID(),
      candidate.fromAddress.toLowerCase(),
      candidate.toAddress.toLowerCase(),
      candidate.authorId,
      parsed.recipientHandle,
      getDefaultTokenAddress().toLowerCase(),
      candidate.amount,
      row.tweetId,
      row.receiptId,
      candidate.txHash.toLowerCase(),
      Number(row.createdAt),
      candidate.contentId,
      now,
      now,
    );
  });
  if (inserted.changes === 0) return false;
  await publishDashboardUpdate({
    reason: "x_tip_ledger_recovered",
    addresses: [candidate.fromAddress, candidate.toAddress],
    authorIds: [candidate.authorId],
  }).catch(() => undefined);
  console.log(`[XBot] Recovered missing receipt ${receiptId} from indexed tip ${candidate.txHash}`);
  return true;
}

export async function recoverMissingCompletedXTips(limit = 25): Promise<number> {
  const rows = await getDb().prepare(
    `SELECT p.receipt_id as "receiptId"
     FROM processed_x_posts p
     LEFT JOIN x_bot_tips xbt ON xbt.receipt_id = p.receipt_id
     WHERE p.status = 'completed' AND p.receipt_id IS NOT NULL AND p.reply_text IS NOT NULL
       AND xbt.receipt_id IS NULL
     ORDER BY p.created_at ASC
     LIMIT ?`
  ).all<{ receiptId: string }>(Math.max(1, Math.min(limit, 100)));
  let recovered = 0;
  for (const row of rows) {
    if (await recoverCompletedXTipByReceipt(row.receiptId)) recovered += 1;
  }
  return recovered;
}

export const __xTipLedgerRecoveryTest = { parseCompletedReply };

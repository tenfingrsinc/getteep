import crypto from "crypto";
import type { Hex } from "viem";
import { getDb } from "../../db/database";
import { XOAuthService } from "../oauth";
import {
  createReceiptId,
  getDailyXBotTipTotal,
  getDefaultChainId,
  getDefaultTokenAddress,
} from "../teepBalance";
import {
  buildXDirectCreatorContentId,
  buildXPostContentId,
  getOnchainTeepBalance,
  getOnchainXTippingReadiness,
  relayXTip,
  XTipConfirmationPendingError,
  XTipRevertedError,
  type XTipSubmission,
} from "../xTippingRouter";
import { amountToRaw, classifyIgnoredMention, formatUsdcRaw, parseTipCommand } from "./parseTipCommand";
import {
  buildBalanceReply,
  buildAlreadyProcessedReply,
  buildClaimableReply,
  buildConnectReply,
  buildFailureReply,
  buildHelpReply,
  buildInvalidCommandReply,
  buildInsufficientBalanceReply,
  buildSuccessReply,
  buildSubmittedReply,
  buildUncertainSubmissionReply,
} from "./replies";
import type { ProcessPostResult, TipIntent, XIncomingPost, XTipKind } from "./types";
import { publishDashboardUpdate } from "../dashboardUpdates";
import { invalidateDisplayUsdcBalances } from "../balanceSnapshots";
import { requeueOfferEvaluationsForContent } from "../creatorOffers";
import { sanitizeOperationalError } from "../serviceHealth";

const MIN_TIP_RAW = BigInt(process.env.X_BOT_MIN_TIP_RAW || "10000");
const PROCESSING_STALE_MS = Number(process.env.X_BOT_PROCESSING_STALE_MS || "300000");
const BOT_USER_ID = process.env.X_BOT_USER_ID || "";
const oauthService = new XOAuthService();

type SenderAccount = {
  userAddress: string;
  xUsername: string;
};

type RecipientAccount = {
  userAddress: string | null;
  xUserId: string;
  xUsername: string;
};

type PreparedTip = {
  intent: TipIntent;
  amountRaw: bigint;
  recipient: RecipientAccount;
  receiptId: string;
  tipId: string;
  sourceTweetId: string;
  tipKind: XTipKind;
  contentId: Hex;
  contextTweetId: string;
  contextAuthorId: string;
  contextAuthorUsername: string;
  contextAuthorName?: string | null;
  contextAuthorProfileImageUrl?: string | null;
};

async function persistXTipRecord(params: {
  tip: PreparedTip;
  sender: SenderAccount;
  tokenAddress: string;
  submission: XTipSubmission;
  status: "submitted" | "completed" | "failed";
  lastError?: string;
}) {
  const now = nowMs();
  await getDb().transaction(async (txDb) => {
    await txDb.prepare(
      `INSERT INTO tip_metadata (content_id, author_handle, tweet_id, kind)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(content_id) DO UPDATE SET
         author_handle = excluded.author_handle,
         tweet_id = excluded.tweet_id,
         kind = excluded.kind`
    ).run(
      params.tip.contentId,
      params.tip.tipKind === "direct_creator_tip" ? params.tip.recipient.xUsername : params.tip.contextAuthorUsername,
      params.tip.tipKind === "direct_creator_tip" ? null : params.tip.contextTweetId,
      params.tip.tipKind,
    );
    await txDb.prepare(
      `INSERT INTO x_bot_tips (
        id, sender_address, recipient_address, recipient_x_user_id, recipient_x_username,
        token_address, amount_raw, source_tweet_id, receipt_id, tx_hash, status, created_at,
        tip_kind, content_id, context_tweet_id, context_author_id, context_author_username,
        context_author_name, context_author_profile_image_url, updated_at, confirmed_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_tweet_id) DO UPDATE SET
        recipient_address = excluded.recipient_address,
        tx_hash = excluded.tx_hash,
        status = CASE
          WHEN x_bot_tips.status IN ('completed', 'failed') AND excluded.status = 'submitted'
            THEN x_bot_tips.status
          ELSE excluded.status
        END,
        tip_kind = excluded.tip_kind,
        content_id = excluded.content_id,
        context_tweet_id = excluded.context_tweet_id,
        context_author_id = excluded.context_author_id,
        context_author_username = excluded.context_author_username,
        context_author_name = excluded.context_author_name,
        context_author_profile_image_url = excluded.context_author_profile_image_url,
        updated_at = excluded.updated_at,
        confirmed_at = COALESCE(x_bot_tips.confirmed_at, excluded.confirmed_at),
        last_error = CASE
          WHEN x_bot_tips.status IN ('completed', 'failed') AND excluded.status = 'submitted'
            THEN x_bot_tips.last_error
          ELSE excluded.last_error
        END`
    ).run(
      params.tip.tipId,
      params.sender.userAddress,
      params.submission.claimWallet,
      params.tip.recipient.xUserId,
      params.tip.recipient.xUsername,
      params.tokenAddress,
      params.tip.amountRaw.toString(),
      params.tip.sourceTweetId,
      params.tip.receiptId,
      params.submission.txHash,
      params.status,
      now,
      params.tip.tipKind,
      params.tip.contentId,
      params.tip.contextTweetId,
      params.tip.contextAuthorId,
      params.tip.contextAuthorUsername,
      params.tip.contextAuthorName ?? null,
      params.tip.contextAuthorProfileImageUrl ?? null,
      now,
      params.status === "completed" ? now : null,
      params.lastError ?? null,
    );
  });
}

function dbBool(value: unknown) {
  return value === true || value === 1;
}

function nowMs() {
  return Date.now();
}

function normalizeHandle(handle?: string) {
  return handle?.replace(/^@/, "").toLowerCase();
}

async function ensureVerifiedClaimFromLinkedXAccount(params: {
  xUserId: string;
  xUsername: string;
  displayName?: string | null;
  profileImageUrl?: string | null;
  userAddress: string;
}) {
  const db = getDb();
  const ownerAddress = params.userAddress.toLowerCase();
  const existingClaim = await db
    .prepare(`SELECT owner_address FROM verified_claims WHERE author_id = ? ORDER BY verified_at DESC LIMIT 1`)
    .get(params.xUserId) as { owner_address: string } | undefined;

  if (existingClaim && existingClaim.owner_address.toLowerCase() !== ownerAddress) {
    return;
  }

  await db
    .prepare(
      `INSERT INTO verified_claims (author_id, username, display_name, owner_address, profile_image_url)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(author_id, owner_address) DO UPDATE SET
         username = excluded.username,
         display_name = COALESCE(excluded.display_name, verified_claims.display_name),
         profile_image_url = COALESCE(excluded.profile_image_url, verified_claims.profile_image_url),
         verified_at = now()`
    )
    .run(
      params.xUserId,
      params.xUsername,
      params.displayName ?? null,
      ownerAddress,
      params.profileImageUrl ?? null
    );
}

async function markProcessed(
  tweetId: string,
  authorXUserId: string,
  status: string,
  reason?: string,
  receiptId?: string,
  replyText?: string
) {
  const db = getDb();
  const now = nowMs();
  const replyStatus = replyText ? "pending" : "not_required";
  await db.prepare(
    `INSERT INTO processed_x_posts (
       tweet_id, author_x_user_id, status, reason, receipt_id,
       reply_text, reply_status, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tweet_id) DO UPDATE SET
       status = excluded.status,
       reason = excluded.reason,
       receipt_id = COALESCE(excluded.receipt_id, processed_x_posts.receipt_id),
       reply_text = COALESCE(excluded.reply_text, processed_x_posts.reply_text),
       reply_status = CASE
         WHEN processed_x_posts.reply_tweet_id IS NOT NULL THEN 'delivered'
         WHEN excluded.reply_text IS NOT NULL THEN 'pending'
         ELSE processed_x_posts.reply_status
       END,
       updated_at = excluded.updated_at`
  ).run(
    tweetId,
    authorXUserId,
    status,
    reason ?? null,
    receiptId ?? null,
    replyText ?? null,
    replyStatus,
    now,
    now
  );
}

type ProcessedPostRow = {
  status: string;
  reason: string | null;
  receipt_id: string | null;
  reply_text: string | null;
  reply_status: string;
  reply_tweet_id: string | null;
  updated_at: number | string;
};

async function claimPostForProcessing(tweetId: string, authorXUserId: string) {
  const db = getDb();
  const now = nowMs();
  const inserted = await db.prepare(
    `INSERT INTO processed_x_posts (
       tweet_id, author_x_user_id, status, reply_status, created_at, updated_at
     )
     VALUES (?, ?, 'processing', 'not_required', ?, ?)
     ON CONFLICT(tweet_id) DO NOTHING
     RETURNING tweet_id`
  ).get<{ tweet_id: string }>(tweetId, authorXUserId, now, now);
  if (inserted) return { claimed: true as const };

  let existing = await db.prepare(
    `SELECT status, reason, receipt_id, reply_text, reply_status, reply_tweet_id, updated_at
     FROM processed_x_posts WHERE tweet_id = ?`
  ).get<ProcessedPostRow>(tweetId);
  if (!existing) return { claimed: false as const, existing: undefined };

  const isStaleProcessing =
    existing.status === "processing" && now - Number(existing.updated_at) > PROCESSING_STALE_MS;
  if (isStaleProcessing) {
    const reclaimed = await db.prepare(
      `UPDATE processed_x_posts
       SET author_x_user_id = ?, status = 'processing', reason = NULL, updated_at = ?
       WHERE tweet_id = ? AND status = 'processing' AND updated_at = ?
       RETURNING tweet_id`
    ).get<{ tweet_id: string }>(authorXUserId, now, tweetId, existing.updated_at);
    if (reclaimed) return { claimed: true as const };
    existing = await db.prepare(
      `SELECT status, reason, receipt_id, reply_text, reply_status, reply_tweet_id, updated_at
       FROM processed_x_posts WHERE tweet_id = ?`
    ).get<ProcessedPostRow>(tweetId);
  }

  return { claimed: false as const, existing };
}

async function ensurePendingReply(tweetId: string, replyText: string) {
  await getDb().prepare(
    `UPDATE processed_x_posts
     SET reply_text = COALESCE(reply_text, ?),
         reply_status = CASE WHEN reply_tweet_id IS NULL THEN 'pending' ELSE 'delivered' END,
         updated_at = ?
     WHERE tweet_id = ?`
  ).run(replyText, nowMs(), tweetId);
}

export async function recordXReplyDelivery(params: {
  tweetId: string;
  replyTweetId?: string;
  error?: string;
}) {
  const delivered = Boolean(params.replyTweetId);
  if (delivered) {
    await getDb().prepare(
      `UPDATE processed_x_posts
       SET reply_status = 'delivered', reply_tweet_id = ?, reply_error = NULL,
           reply_attempts = reply_attempts + 1, replied_at = ?, updated_at = ?
       WHERE tweet_id = ?`
    ).run(params.replyTweetId, nowMs(), nowMs(), params.tweetId);
    return;
  }

  await getDb().prepare(
    `UPDATE processed_x_posts
     SET reply_status = CASE WHEN reply_tweet_id IS NULL THEN 'failed' ELSE 'delivered' END,
         reply_error = CASE WHEN reply_tweet_id IS NULL THEN ? ELSE reply_error END,
         reply_attempts = reply_attempts + 1, updated_at = ?
     WHERE tweet_id = ?`
  ).run((params.error || "Unknown X reply failure").slice(0, 1000), nowMs(), params.tweetId);
}

async function resolveSender(authorId: string): Promise<SenderAccount | null> {
  const db = getDb();
  const claim = await db
    .prepare(
      `SELECT owner_address, username FROM verified_claims
       WHERE author_id = ? ORDER BY verified_at DESC LIMIT 1`
    )
    .get(authorId) as { owner_address: string; username: string } | undefined;
  if (claim) return { userAddress: claim.owner_address.toLowerCase(), xUsername: claim.username };

  const row = await db
    .prepare(`SELECT user_address, x_username FROM x_accounts WHERE x_user_id = ?`)
    .get(authorId) as { user_address: string; x_username: string } | undefined;
  if (!row) return null;
  return { userAddress: row.user_address.toLowerCase(), xUsername: row.x_username };
}

async function resolveRecipient(intent: TipIntent, post: XIncomingPost): Promise<RecipientAccount | null> {
  const db = getDb();

  if (intent.recipientXHandle) {
    const handle = normalizeHandle(intent.recipientXHandle);
    const claim = await db
      .prepare(
        `SELECT author_id, username, owner_address FROM verified_claims
         WHERE LOWER(username) = ? ORDER BY verified_at DESC LIMIT 1`
      )
      .get(handle) as { author_id: string; username: string; owner_address: string } | undefined;
    if (claim) {
      return {
        userAddress: claim.owner_address.toLowerCase(),
        xUserId: claim.author_id,
        xUsername: claim.username,
      };
    }

    try {
      const profile = await oauthService.getUserByUsername(handle || "");
      const linked = await db
        .prepare(`SELECT user_address FROM x_accounts WHERE x_user_id = ?`)
        .get(profile.id) as { user_address: string } | undefined;
      if (linked?.user_address) {
        await ensureVerifiedClaimFromLinkedXAccount({
          xUserId: profile.id,
          xUsername: profile.username,
          displayName: profile.name,
          profileImageUrl: profile.profile_image_url ?? null,
          userAddress: linked.user_address,
        });
      }
      return {
        userAddress: linked?.user_address?.toLowerCase() ?? null,
        xUserId: profile.id,
        xUsername: profile.username,
      };
    } catch {
      return null;
    }
  }

  if (post.parentAuthorId && post.parentAuthorUsername) {
    const claim = await db
      .prepare(`SELECT author_id, username, owner_address FROM verified_claims WHERE author_id = ? LIMIT 1`)
      .get(post.parentAuthorId) as { author_id: string; username: string; owner_address: string } | undefined;
    const linked = claim
      ? undefined
      : (await db
          .prepare(`SELECT user_address, x_username FROM x_accounts WHERE x_user_id = ?`)
          .get(post.parentAuthorId) as { user_address: string; x_username: string } | undefined);
    if (!claim && linked?.user_address) {
      await ensureVerifiedClaimFromLinkedXAccount({
        xUserId: post.parentAuthorId,
        xUsername: linked.x_username ?? post.parentAuthorUsername,
        userAddress: linked.user_address,
      });
    }
    return {
      userAddress: claim?.owner_address?.toLowerCase() ?? linked?.user_address?.toLowerCase() ?? null,
      xUserId: post.parentAuthorId,
      xUsername: claim?.username ?? linked?.x_username ?? post.parentAuthorUsername,
    };
  }

  return null;
}

async function getTippingPermissions(userAddress: string) {
  const db = getDb();
  const tokenAddress = getDefaultTokenAddress();
  const row = await db
    .prepare(
      `SELECT enabled, max_per_tip_raw, max_daily_raw, token_address FROM x_tipping_permissions WHERE user_address = ?`
    )
    .get(userAddress.toLowerCase()) as
    | { enabled: boolean | number; max_per_tip_raw: string; max_daily_raw: string; token_address: string }
    | undefined;

  return {
    enabled: dbBool(row?.enabled),
    maxPerTipRaw: BigInt(row?.max_per_tip_raw || process.env.X_BOT_MAX_PER_TIP_RAW || "10000000"),
    maxDailyRaw: BigInt(row?.max_daily_raw || process.env.X_BOT_MAX_DAILY_RAW || "50000000"),
    tokenAddress: (row?.token_address || tokenAddress).toLowerCase(),
  };
}

async function validateBatch(params: {
  senderAddress: string;
  amountsRaw: bigint[];
  tokenAddress: string;
}) {
  const permissions = await getTippingPermissions(params.senderAddress);
  if (!permissions.enabled) {
    return {
      ok: false as const,
      code: "X_TIPPING_DISABLED",
      reason: "X tip commands are paused for this account. Open Teep settings to enable them.",
    };
  }

  for (const amountRaw of params.amountsRaw) {
    if (amountRaw < MIN_TIP_RAW) {
      return {
        ok: false as const,
        code: "BELOW_MINIMUM",
        reason: `Minimum tip is ${formatUsdcRaw(MIN_TIP_RAW)} USD.`,
      };
    }
    if (amountRaw > permissions.maxPerTipRaw) {
      return {
        ok: false as const,
        code: "MAX_PER_TIP",
        reason: `This is above your Max per tip on X (${formatUsdcRaw(permissions.maxPerTipRaw)} USD). Open Teep settings to raise the limit.`,
      };
    }
  }

  const totalRaw = params.amountsRaw.reduce((sum, amountRaw) => sum + amountRaw, 0n);
  const chainId = getDefaultChainId();
  const dailyTotal = await getDailyXBotTipTotal(params.senderAddress, params.tokenAddress, chainId);
  if (dailyTotal + totalRaw > permissions.maxDailyRaw) {
    return {
      ok: false as const,
      code: "DAILY_LIMIT",
      reason: `This would pass your Daily tip limit on X (${formatUsdcRaw(permissions.maxDailyRaw)} USD). Open Teep settings to raise the limit.`,
    };
  }

  try {
    const onchain = await getOnchainXTippingReadiness({ senderAddress: params.senderAddress, totalRaw });
    if (!onchain.ok) return onchain;
  } catch (error) {
    console.error(`[XBot] Arc readiness unavailable: ${sanitizeOperationalError(error)}`);
    return {
      ok: false as const,
      code: "ARC_RPC_UNAVAILABLE",
      reason: "Arc is temporarily unavailable. No tip was submitted; try again later.",
    };
  }

  return { ok: true as const };
}

function sourceTweetIdFor(postId: string, index: number, count: number) {
  return count === 1 ? postId : `${postId}:${index + 1}`;
}

function getTipContext(params: {
  intent: TipIntent;
  post: XIncomingPost;
  recipient: RecipientAccount;
  sender: SenderAccount;
}): Omit<PreparedTip, "intent" | "amountRaw" | "recipient" | "receiptId" | "tipId" | "sourceTweetId"> | null {
  if (params.intent.targetType === "post") {
    if (!params.post.parentTweetId || !params.post.parentAuthorId || !params.post.parentAuthorUsername) {
      return null;
    }
    return {
      tipKind: "post_tip",
      contentId: buildXPostContentId(params.post.parentAuthorUsername, params.post.parentTweetId),
      contextTweetId: params.post.parentTweetId,
      contextAuthorId: params.post.parentAuthorId,
      contextAuthorUsername: params.post.parentAuthorUsername,
      contextAuthorName: params.post.parentAuthorName ?? null,
      contextAuthorProfileImageUrl: params.post.parentAuthorProfileImageUrl ?? null,
    };
  }

  return {
    tipKind: "direct_creator_tip",
    contentId: buildXDirectCreatorContentId(params.recipient.xUserId),
    contextTweetId: params.post.id,
    contextAuthorId: params.post.authorId,
    contextAuthorUsername: params.post.authorUsername || params.sender.xUsername,
    contextAuthorName: params.post.authorName ?? null,
    contextAuthorProfileImageUrl: params.post.authorProfileImageUrl ?? null,
  };
}

function firstIntentContext(post: XIncomingPost, intent?: TipIntent) {
  const isPostTip = intent?.targetType === "post";
  return {
    tweetId: post.id,
    recipientHandle: intent?.recipientXHandle || post.parentAuthorUsername,
    amount: intent?.amount,
    intent: "x-tip" as const,
    tipKind: isPostTip ? "post_tip" as const : "direct_creator_tip" as const,
    targetTweetId: isPostTip ? post.parentTweetId : post.id,
    targetHandle: isPostTip ? post.parentAuthorUsername : post.authorUsername,
  };
}

export async function processIncomingPost(post: XIncomingPost): Promise<ProcessPostResult> {
  if (BOT_USER_ID && post.authorId === BOT_USER_ID) {
    await markProcessed(post.id, post.authorId, "ignored", "BOT_SELF_POST");
    return { tweetId: post.id, status: "ignored", code: "BOT_SELF_POST" };
  }

  const claim = await claimPostForProcessing(post.id, post.authorId);
  if (!claim.claimed) {
    const existing = claim.existing;
    const needsReply = Boolean(existing && !existing.reply_tweet_id && existing.reply_status !== "delivered");
    const replyText = needsReply
      ? existing?.reply_text || buildAlreadyProcessedReply({
          status: existing?.status || "unknown",
          reason: existing?.reason,
          receiptId: existing?.receipt_id,
        })
      : undefined;
    if (replyText && existing && !existing.reply_text) {
      await ensurePendingReply(post.id, replyText);
    }
    return {
      tweetId: post.id,
      status: "ignored",
      code: "ALREADY_PROCESSED",
      replyText,
      receiptId: existing?.receipt_id || undefined,
      originalStatus: existing?.status,
      originalReason: existing?.reason || undefined,
      replyDeliveryStatus: existing?.reply_status,
    };
  }

  const command = parseTipCommand(post.text);
  if (!command) {
    const ignoredReason = classifyIgnoredMention(post.text) || "NO_COMMAND";
    await markProcessed(post.id, post.authorId, "ignored", ignoredReason);
    return { tweetId: post.id, status: "ignored", code: ignoredReason };
  }

  if (command.type === "HELP") {
    const replyText = buildHelpReply();
    await markProcessed(post.id, post.authorId, "completed", "HELP", undefined, replyText);
    return { tweetId: post.id, status: "completed", replyText };
  }

  if (command.type === "INVALID_COMMAND") {
    const replyText = buildInvalidCommandReply(command.reason);
    await markProcessed(post.id, post.authorId, "failed", command.reason, undefined, replyText);
    return { tweetId: post.id, status: "failed", code: command.reason, replyText };
  }

  if (command.type === "BALANCE") {
    const sender = await resolveSender(post.authorId);
    if (!sender) {
      const replyText = buildConnectReply(post.authorUsername, { tweetId: post.id, intent: "x-balance" });
      await markProcessed(post.id, post.authorId, "failed", "SENDER_NOT_REGISTERED", undefined, replyText);
      return { tweetId: post.id, status: "failed", code: "SENDER_NOT_REGISTERED", replyText };
    }
    let balance: bigint;
    try {
      balance = await getOnchainTeepBalance(sender.userAddress);
    } catch (error) {
      console.error(`[XBot] Balance RPC unavailable for tweet ${post.id}: ${sanitizeOperationalError(error)}`);
      const replyText = buildFailureReply("Arc is temporarily unavailable. Try checking your balance again later.");
      await markProcessed(post.id, post.authorId, "failed", "ARC_RPC_UNAVAILABLE", undefined, replyText);
      return { tweetId: post.id, status: "failed", code: "ARC_RPC_UNAVAILABLE", replyText };
    }
    const replyText = buildBalanceReply(sender.xUsername, balance);
    await markProcessed(post.id, post.authorId, "completed", "BALANCE", undefined, replyText);
    return { tweetId: post.id, status: "completed", replyText };
  }

  const sender = await resolveSender(post.authorId);
  if (!sender) {
    const replyText = buildConnectReply(post.authorUsername, firstIntentContext(post, command.tips[0]));
    await markProcessed(post.id, post.authorId, "failed", "SENDER_NOT_REGISTERED", undefined, replyText);
    return { tweetId: post.id, status: "failed", code: "SENDER_NOT_REGISTERED", replyText };
  }
  if (command.tips.length > 1) {
    const replyText = buildFailureReply("Send one X tip command at a time.");
    await markProcessed(post.id, post.authorId, "failed", "BATCH_NOT_SUPPORTED", undefined, replyText);
    return { tweetId: post.id, status: "failed", code: "BATCH_NOT_SUPPORTED", replyText };
  }

  const tokenAddress = getDefaultTokenAddress();
  const chainId = getDefaultChainId();
  const amountsRaw: bigint[] = [];
  for (const intent of command.tips) {
    try {
      amountsRaw.push(amountToRaw(intent.amount));
    } catch {
      const replyText = buildFailureReply("Invalid tip amount.");
      await markProcessed(post.id, post.authorId, "failed", "INVALID_AMOUNT", undefined, replyText);
      return { tweetId: post.id, status: "failed", code: "INVALID_AMOUNT", replyText };
    }
  }

  const validation = await validateBatch({ senderAddress: sender.userAddress, amountsRaw, tokenAddress });
  if (!validation.ok) {
    const replyText =
      validation.code === "INSUFFICIENT_BALANCE"
        ? buildInsufficientBalanceReply(sender.xUsername, firstIntentContext(post, command.tips[0]))
        : buildFailureReply(validation.reason);
    await markProcessed(post.id, post.authorId, "failed", validation.code, undefined, replyText);
    return { tweetId: post.id, status: "failed", code: validation.code, replyText };
  }

  const prepared: PreparedTip[] = [];
  for (let index = 0; index < command.tips.length; index += 1) {
    const intent = command.tips[index];
    if (intent.targetType === "post" && (!post.parentTweetId || !post.parentAuthorId || !post.parentAuthorUsername)) {
      const replyText = buildFailureReply("Reply to the post you want to tip, then use @teepagent tip this post $2.");
      await markProcessed(post.id, post.authorId, "failed", "MISSING_POST_CONTEXT", undefined, replyText);
      return { tweetId: post.id, status: "failed", code: "MISSING_POST_CONTEXT", replyText };
    }

    const recipient = await resolveRecipient(intent, post);
    if (!recipient) {
      const replyText = buildFailureReply("I couldn't find that creator on X.");
      await markProcessed(post.id, post.authorId, "failed", "RECIPIENT_NOT_FOUND", undefined, replyText);
      return { tweetId: post.id, status: "failed", code: "RECIPIENT_NOT_FOUND", replyText };
    }
    if (recipient.userAddress && recipient.userAddress === sender.userAddress) {
      const replyText = buildFailureReply("You can't tip yourself.");
      await markProcessed(post.id, post.authorId, "failed", "SELF_TIP", undefined, replyText);
      return { tweetId: post.id, status: "failed", code: "SELF_TIP", replyText };
    }

    const context = getTipContext({ intent, post, recipient, sender });
    if (!context) {
      const replyText = buildFailureReply("I couldn't identify the post to tip.");
      await markProcessed(post.id, post.authorId, "failed", "MISSING_POST_CONTEXT", undefined, replyText);
      return { tweetId: post.id, status: "failed", code: "MISSING_POST_CONTEXT", replyText };
    }

    prepared.push({
      intent,
      amountRaw: amountsRaw[index],
      recipient,
      receiptId: createReceiptId(),
      tipId: crypto.randomUUID(),
      sourceTweetId: sourceTweetIdFor(post.id, index, command.tips.length),
      ...context,
    });
  }

  const tip = prepared[0];
  let confirmedSubmission: XTipSubmission | undefined;
  try {
    const submission = await relayXTip({
      senderAddress: sender.userAddress,
      recipientXUserId: tip.recipient.xUserId,
      commandTweetId: tip.sourceTweetId,
      contentId: tip.contentId,
      amountRaw: tip.amountRaw,
    }, {
      onSubmitted: (submitted) => persistXTipRecord({
        tip,
        sender,
        tokenAddress,
        submission: submitted,
        status: "submitted",
      }),
    });
    confirmedSubmission = submission;

    await persistXTipRecord({ tip, sender, tokenAddress, submission, status: "completed" });
    await requeueOfferEvaluationsForContent(tip.contentId).catch((error) => {
      console.error("[Creator offers] Could not requeue X tip evaluation:", error);
    });

    invalidateDisplayUsdcBalances([sender.userAddress, submission.claimWallet]);
    await publishDashboardUpdate({
      reason: "x_tip_confirmed",
      addresses: [sender.userAddress, tip.recipient.userAddress],
      authorIds: [tip.recipient.xUserId],
    }).catch((error) => console.error("[Dashboard live] Could not publish X tip update:", error));

    const replyText = tip.recipient.userAddress
      ? buildSuccessReply({
          senderHandle: sender.xUsername,
          recipientHandle: tip.recipient.xUsername,
          amountRaw: tip.amountRaw,
          receiptId: tip.receiptId,
        })
      : buildClaimableReply({
          senderHandle: sender.xUsername,
          recipientHandle: tip.recipient.xUsername,
          amountRaw: tip.amountRaw,
          receiptId: tip.receiptId,
        });
    await markProcessed(
      post.id,
      post.authorId,
      "completed",
      tip.recipient.userAddress ? undefined : "CLAIMABLE",
      tip.receiptId,
      replyText
    );
    return { tweetId: post.id, status: "completed", replyText, receiptId: tip.receiptId, txHash: submission.txHash };
  } catch (err: unknown) {
    if (err instanceof XTipConfirmationPendingError) {
      const submission = err.submission;
      const operationalError = sanitizeOperationalError(err.causeValue);
      await persistXTipRecord({
        tip,
        sender,
        tokenAddress,
        submission,
        status: "submitted",
        lastError: operationalError,
      }).catch((persistError) => {
        console.error(`[XBot] Could not persist submitted tip ${post.id} (${submission.txHash}): ${sanitizeOperationalError(persistError)}`);
      });
      const replyText = buildSubmittedReply({
        recipientHandle: tip.recipient.xUsername,
        amountRaw: tip.amountRaw,
        receiptId: tip.receiptId,
      });
      await markProcessed(post.id, post.authorId, "submitted", "CONFIRMATION_PENDING", tip.receiptId, replyText);
      console.warn(`[XBot] Tip ${post.id} submitted as ${submission.txHash}; confirmation workflow pending: ${operationalError}`);
      return {
        tweetId: post.id,
        status: "submitted",
        code: "CONFIRMATION_PENDING",
        replyText,
        receiptId: tip.receiptId,
        txHash: submission.txHash,
      };
    }

    if (confirmedSubmission) {
      const operationalError = sanitizeOperationalError(err);
      await persistXTipRecord({
        tip,
        sender,
        tokenAddress,
        submission: confirmedSubmission,
        status: "completed",
      });
      const replyText = tip.recipient.userAddress
        ? buildSuccessReply({
            senderHandle: sender.xUsername,
            recipientHandle: tip.recipient.xUsername,
            amountRaw: tip.amountRaw,
            receiptId: tip.receiptId,
          })
        : buildClaimableReply({
            senderHandle: sender.xUsername,
            recipientHandle: tip.recipient.xUsername,
            amountRaw: tip.amountRaw,
            receiptId: tip.receiptId,
          });
      await markProcessed(
        post.id,
        post.authorId,
        "completed",
        tip.recipient.userAddress ? undefined : "CLAIMABLE",
        tip.receiptId,
        replyText
      );
      console.warn(`[XBot] Tip ${post.id} confirmed as ${confirmedSubmission.txHash}; recovered after post-confirmation error: ${operationalError}`);
      return { tweetId: post.id, status: "completed", replyText, receiptId: tip.receiptId, txHash: confirmedSubmission.txHash };
    }

    if (err instanceof XTipRevertedError) {
      await persistXTipRecord({
        tip,
        sender,
        tokenAddress,
        submission: err.submission,
        status: "failed",
        lastError: "Transaction reverted",
      });
      const replyText = buildFailureReply("Arc rejected the transaction, so the tip was not transferred.");
      await markProcessed(post.id, post.authorId, "failed", "X_TIP_REVERTED", tip.receiptId, replyText);
      console.warn(`[XBot] Tip ${post.id} reverted as ${err.submission.txHash}`);
      return { tweetId: post.id, status: "failed", code: "X_TIP_REVERTED", replyText, receiptId: tip.receiptId, txHash: err.submission.txHash };
    }

    const message = err instanceof Error ? err.message : "UNKNOWN";
    const safeError = sanitizeOperationalError(err);
    const replyText = message === "INSUFFICIENT_BALANCE"
      ? buildInsufficientBalanceReply(sender.xUsername, firstIntentContext(post, command.tips[0]))
      : buildUncertainSubmissionReply();
    await markProcessed(post.id, post.authorId, "failed", message, undefined, replyText);
    console.error(`[XBot] Tip submission failed before a transaction hash was available for ${post.id}: ${safeError}`);
    return { tweetId: post.id, status: "failed", code: message, replyText };
  }
}

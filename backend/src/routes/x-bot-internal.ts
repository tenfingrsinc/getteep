import { Router, Request, Response } from "express";
import crypto from "crypto";
import { processIncomingPost, recordXReplyDelivery } from "../services/xBot/processPost";
import type { XIncomingPost } from "../services/xBot/types";
import { claimPendingOfferXNotification, recordOfferXNotificationResult } from "../services/creatorOffers";

const router = Router();

function requireAgentToken(req: Request, res: Response): boolean {
  const expected = process.env.X_AGENT_TOKEN;
  if (!expected) {
    console.warn(`[XBot] Rejected ${req.path}: X agent is not configured`);
    res.status(503).json({ error: "X agent not configured" });
    return false;
  }
  const provided = req.header("x-agent-token");
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided || "");
  if (
    !provided ||
    expectedBuffer.length !== providedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    console.warn(`[XBot] Rejected ${req.path}: invalid agent token`);
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function isIncomingPost(value: unknown): value is XIncomingPost {
  if (!value || typeof value !== "object") return false;
  const post = value as Record<string, unknown>;
  return (
    typeof post.id === "string" &&
    typeof post.text === "string" &&
    typeof post.authorId === "string" &&
    /^[0-9]+$/.test(post.authorId)
  );
}

/**
 * POST /internal/x-bot/process-post
 * Called by the x-agent worker after it receives a mention.
 */
router.post("/process-post", async (req: Request, res: Response) => {
  if (!requireAgentToken(req, res)) return;
  if (!isIncomingPost(req.body)) {
    res.status(400).json({ error: "Invalid post payload" });
    return;
  }

  try {
    console.log(`[XBot] Received post ${req.body.id} from X agent`);
    const result = await processIncomingPost(req.body);
    console.log(`[XBot] Processed post ${req.body.id}: ${result.status}${result.code ? ` (${result.code})` : ""}`);
    res.json(result);
  } catch (err: unknown) {
    console.error("[XBot] process-post failed:", err);
    res.status(500).json({ error: "Failed to process post" });
  }
});

/**
 * POST /internal/x-bot/reply-result
 * Persists whether the user-facing X reply was delivered so backend
 * idempotency never silently discards an undelivered outcome.
 */
router.post("/reply-result", async (req: Request, res: Response) => {
  if (!requireAgentToken(req, res)) return;
  const tweetId = typeof req.body?.tweetId === "string" ? req.body.tweetId : "";
  const replyTweetId = typeof req.body?.replyTweetId === "string" ? req.body.replyTweetId : undefined;
  const error = typeof req.body?.error === "string" ? req.body.error : undefined;
  if (!/^\d+$/.test(tweetId) || (replyTweetId && !/^\d+$/.test(replyTweetId)) || (!replyTweetId && !error)) {
    res.status(400).json({ error: "Invalid reply result payload" });
    return;
  }

  try {
    await recordXReplyDelivery({ tweetId, replyTweetId, error });
    res.json({ ok: true });
  } catch (err: unknown) {
    console.error("[XBot] reply-result failed:", err);
    res.status(500).json({ error: "Failed to record reply result" });
  }
});

router.post("/offer-replies/claim", async (req: Request, res: Response) => {
  if (!requireAgentToken(req, res)) return;
  try {
    res.json({ notification: await claimPendingOfferXNotification() || null });
  } catch (err: unknown) {
    console.error("[XBot] offer reply claim failed:", err);
    res.status(500).json({ error: "Failed to claim offer reply" });
  }
});

router.post("/offer-replies/result", async (req: Request, res: Response) => {
  if (!requireAgentToken(req, res)) return;
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  const replyTweetId = typeof req.body?.replyTweetId === "string" ? req.body.replyTweetId : undefined;
  const error = typeof req.body?.error === "string" ? req.body.error : undefined;
  if (!/^[0-9a-f-]{36}$/i.test(id) || (replyTweetId && !/^\d+$/.test(replyTweetId)) || (!replyTweetId && !error)) {
    res.status(400).json({ error: "Invalid offer reply result payload" });
    return;
  }
  try {
    await recordOfferXNotificationResult({ id, replyTweetId, error });
    res.json({ ok: true });
  } catch (err: unknown) {
    console.error("[XBot] offer reply result failed:", err);
    res.status(500).json({ error: "Failed to record offer reply result" });
  }
});

export default router;

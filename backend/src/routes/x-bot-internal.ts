import { Router, Request, Response } from "express";
import crypto from "crypto";
import { processIncomingPost } from "../services/xBot/processPost";
import type { XIncomingPost } from "../services/xBot/types";

const router = Router();

function requireAgentToken(req: Request, res: Response): boolean {
  const expected = process.env.X_AGENT_TOKEN;
  if (!expected) {
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
    const result = await processIncomingPost(req.body);
    res.json(result);
  } catch (err: unknown) {
    console.error("[XBot] process-post failed:", err);
    res.status(500).json({ error: "Failed to process post" });
  }
});

export default router;

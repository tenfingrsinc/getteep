import { config } from "../config";
import type { ProcessPostResult, XIncomingPost } from "../parser/commandTypes";

export async function processPostOnBackend(post: XIncomingPost): Promise<ProcessPostResult> {
  const response = await fetch(`${config.backendUrl}/internal/x-bot/process-post`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agent-token": config.agentToken,
    },
    body: JSON.stringify(post),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Backend process-post failed: HTTP ${response.status} ${body.slice(0, 300)}`);
  }

  return (await response.json()) as ProcessPostResult;
}

export async function reportReplyResult(params: {
  tweetId: string;
  replyTweetId?: string;
  error?: string;
}): Promise<void> {
  const response = await fetch(`${config.backendUrl}/internal/x-bot/reply-result`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agent-token": config.agentToken,
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Backend reply-result failed: HTTP ${response.status} ${body.slice(0, 300)}`);
  }
}

export async function claimPendingOfferReply(): Promise<{
  id: string;
  sourceTweetId: string;
  replyText: string;
} | null> {
  const response = await fetch(`${config.backendUrl}/internal/x-bot/offer-replies/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-token": config.agentToken },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Backend offer-reply claim failed: HTTP ${response.status}`);
  const payload = await response.json() as { notification?: { id: string; sourceTweetId: string; replyText: string } | null };
  return payload.notification || null;
}

export async function reportOfferReplyResult(params: { id: string; replyTweetId?: string; error?: string }) {
  const response = await fetch(`${config.backendUrl}/internal/x-bot/offer-replies/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-token": config.agentToken },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Backend offer-reply result failed: HTTP ${response.status}`);
}

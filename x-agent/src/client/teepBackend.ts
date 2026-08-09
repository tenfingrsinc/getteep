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

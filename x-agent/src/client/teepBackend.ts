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

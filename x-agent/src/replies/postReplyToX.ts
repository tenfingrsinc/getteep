import { config } from "../config";

export async function postReplyToX(inReplyToTweetId: string, text: string): Promise<string> {
  if (text.length > 280) {
    throw new Error(`X reply text is ${text.length} characters; maximum is 280.`);
  }

  const response = await fetch("https://api.x.com/2/tweets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.botAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      reply: { in_reply_to_tweet_id: inReplyToTweetId },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`X create tweet failed: HTTP ${response.status} ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as { data?: { id?: string } };
  const replyId = data.data?.id;
  if (!replyId) throw new Error("X create tweet returned no id");
  return replyId;
}

import { assertConfig, config } from "./config";
import { processPostOnBackend } from "./client/teepBackend";
import { pollMentions, type PollingState } from "./listeners/xPollingListener";
import { startFilteredStream } from "./listeners/xStreamListener";
import { parseTipCommand } from "./parser/parseTipCommand";
import { postReplyToX } from "./replies/postReplyToX";

const processedLocally = new Set<string>();

async function handlePost(post: Awaited<ReturnType<typeof pollMentions>>["posts"][number]) {
  if (processedLocally.has(post.id)) return;
  processedLocally.add(post.id);

  const command = parseTipCommand(post.text);
  if (!command) return;

  console.log(`[x-agent] Processing tweet ${post.id} from @${post.authorUsername || post.authorId}`);

  const result = await processPostOnBackend(post);
  if (!result.replyText) {
    console.log(`[x-agent] Tweet ${post.id}: ${result.status}${result.code ? ` (${result.code})` : ""}`);
    return;
  }

  try {
    const replyId = await postReplyToX(post.id, result.replyText);
    console.log(`[x-agent] Replied to ${post.id} with ${replyId}`);
  } catch (err: unknown) {
    console.error(`[x-agent] Reply failed for ${post.id}:`, err instanceof Error ? err.message : err);
  }
}

async function runPollingLoop() {
  let state: PollingState = {};
  console.log(`[x-agent] Polling @${config.botUsername} mentions every ${config.pollIntervalMs}ms`);

  for (;;) {
    try {
      const { posts, state: nextState } = await pollMentions(state);
      state = nextState;
      for (const post of posts) {
        await handlePost(post);
      }
    } catch (err: unknown) {
      console.error("[x-agent] Poll cycle failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

async function main() {
  assertConfig();
  console.log(`[x-agent] Teep X agent starting (backend: ${config.backendUrl})`);

  if (config.useFilteredStream) {
    await startFilteredStream(async (post) => {
      await handlePost(post as Parameters<typeof handlePost>[0]);
    });
    return;
  }

  await runPollingLoop();
}

main().catch((err) => {
  console.error("[x-agent] Fatal:", err);
  process.exit(1);
});

import { assertConfig, config } from "./config";
import {
  claimPendingOfferReply,
  processPostOnBackend,
  reportOfferReplyResult,
  reportReplyResult,
} from "./client/teepBackend";
import { pollMentions, validateBotIdentity, type PollingState } from "./listeners/xPollingListener";
import { loadPollingState, savePollingState } from "./listeners/xPollingState";
import { startFilteredStream } from "./listeners/xStreamListener";
import { parseTipCommand } from "./parser/parseTipCommand";
import { postReplyToX } from "./replies/postReplyToX";

const processedLocally = new Set<string>();

function rememberProcessed(tweetId: string) {
  processedLocally.add(tweetId);
  if (processedLocally.size <= 10_000) return;
  const oldest = processedLocally.values().next().value as string | undefined;
  if (oldest) processedLocally.delete(oldest);
}

async function handlePost(post: Awaited<ReturnType<typeof pollMentions>>["posts"][number]) {
  if (processedLocally.has(post.id)) {
    console.log(`[x-agent] Tweet ${post.id}: ignored (ALREADY_SEEN_LOCALLY)`);
    return;
  }

  console.log(`[x-agent] Received mention ${post.id} from @${post.authorUsername || post.authorId}`);

  const command = parseTipCommand(post.text);
  if (!command) {
    rememberProcessed(post.id);
    console.warn(`[x-agent] Tweet ${post.id}: ignored (COMMAND_NOT_RECOGNIZED; expected @${config.botUsername})`);
    return;
  }

  console.log(`[x-agent] Processing tweet ${post.id} from @${post.authorUsername || post.authorId}`);

  const result = await processPostOnBackend(post);
  console.log(
    `[x-agent] Backend outcome for ${post.id}: ${result.status}` +
    `${result.code ? ` (${result.code})` : ""}` +
    `${result.txHash ? ` ${result.txHash}` : ""}`
  );
  if (!result.replyText) {
    rememberProcessed(post.id);
    console.log(`[x-agent] Tweet ${post.id}: ${result.status}${result.code ? ` (${result.code})` : ""}`);
    return;
  }

  let replyId: string;
  try {
    replyId = await postReplyToX(post.id, result.replyText);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await reportReplyResultWithRetry({ tweetId: post.id, error: message }).catch((reportError: unknown) => {
      console.error(
        `[x-agent] Could not record reply failure for ${post.id}:`,
        reportError instanceof Error ? reportError.message : reportError
      );
    });
    console.error(`[x-agent] Reply failed for ${post.id}:`, message);
    return;
  }

  await reportReplyResultWithRetry({ tweetId: post.id, replyTweetId: replyId }).catch((reportError: unknown) => {
    console.error(
      `[x-agent] Reply ${replyId} was sent but its delivery receipt could not be stored for ${post.id}:`,
      reportError instanceof Error ? reportError.message : reportError
    );
  });
  rememberProcessed(post.id);
  console.log(`[x-agent] Replied to ${post.id} with ${replyId}`);
}

async function reportReplyResultWithRetry(params: {
  tweetId: string;
  replyTweetId?: string;
  error?: string;
}) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await reportReplyResult(params);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function runPollingLoop() {
  let state: PollingState = await loadPollingState();
  let pollCount = 0;
  console.log(
    `[x-agent] Polling @${config.botUsername} via mentions + recent search every ${config.pollIntervalMs}ms` +
    ` (cursor state: ${config.pollStatePath})`
  );

  for (;;) {
    try {
      const { posts, state: nextState, sourceCounts, sourceErrors } = await pollMentions(state);
      pollCount += 1;
      if (posts.length > 0 || pollCount === 1 || pollCount % 10 === 0) {
        console.log(`[x-agent] Poll ${pollCount}: mentions=${sourceCounts.mentions} search=${sourceCounts.search} merged=${posts.length}`);
      }
      for (const sourceError of sourceErrors) console.warn(`[x-agent] Poll source degraded: ${sourceError}`);
      for (const post of posts) {
        await handlePost(post);
      }
      await deliverPendingOfferReplies();
      state = nextState;
      await savePollingState(state).catch((error: unknown) => {
        console.warn(
          `[x-agent] Could not persist poll cursors to ${config.pollStatePath}:`,
          error instanceof Error ? error.message : error
        );
      });
    } catch (err: unknown) {
      console.error("[x-agent] Poll cycle failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

async function deliverPendingOfferReplies() {
  for (let delivered = 0; delivered < 5; delivered += 1) {
    const notification = await claimPendingOfferReply();
    if (!notification) return;
    try {
      const replyTweetId = await postReplyToX(notification.sourceTweetId, notification.replyText);
      await reportOfferReplyResult({ id: notification.id, replyTweetId });
      console.log(`[x-agent] Replied to ${notification.sourceTweetId} with creator offer ${replyTweetId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await reportOfferReplyResult({ id: notification.id, error: message }).catch(() => undefined);
      console.error(`[x-agent] Creator offer reply failed for ${notification.sourceTweetId}:`, message);
      return;
    }
  }
}

async function runOfferReplyLoop() {
  for (;;) {
    try {
      await deliverPendingOfferReplies();
    } catch (error) {
      console.error("[x-agent] Creator offer reply loop failed:", error instanceof Error ? error.message : error);
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

async function main() {
  console.log("[x-agent] Worker process started; validating configuration");
  assertConfig();
  await validateBotIdentity();
  console.log(`[x-agent] Verified X identity @${config.botUsername} (${config.botUserId})`);
  console.log(`[x-agent] Teep X agent starting (backend: ${config.backendUrl})`);

  if (config.useFilteredStream) {
    void runOfferReplyLoop();
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

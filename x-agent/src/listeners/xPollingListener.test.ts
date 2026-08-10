import assert from "node:assert/strict";
import test from "node:test";
import type { XIncomingPost } from "../parser/commandTypes";
import { mergePostsById, overlapSinceId, pollingSinceId, pollMentions, validateBotIdentity } from "./xPollingListener";

const X_EPOCH_MS = 1_288_834_974_657n;

function snowflake(timestampMs: number, sequence = 0n) {
  return (((BigInt(timestampMs) - X_EPOCH_MS) << 22n) + sequence).toString();
}

function post(id: string, username?: string): XIncomingPost {
  return { id, text: `@teepagent tip @creator $1`, authorId: `author-${id}`, authorUsername: username };
}

function postsResponse(posts: Array<{ id: string; authorId: string; username: string }>) {
  return {
    data: posts.map((item) => ({ id: item.id, text: "@teepagent tip @creator $1", author_id: item.authorId })),
    includes: { users: posts.map((item) => ({ id: item.authorId, username: item.username })) },
    meta: { result_count: posts.length },
  };
}

test("overlap cursor rewinds a Snowflake by the configured time window", () => {
  const timestamp = Date.UTC(2026, 7, 10, 12, 0, 0);
  const cursor = overlapSinceId(snowflake(timestamp, 321n), 600_000);
  assert.ok(cursor);
  const cursorTimestamp = Number((BigInt(cursor) >> 22n) + X_EPOCH_MS);
  assert.equal(cursorTimestamp, timestamp - 600_000);
});

test("a new source cursor starts from the bounded bootstrap lookback", () => {
  const now = Date.UTC(2026, 7, 10, 12, 0, 0);
  const cursor = pollingSinceId(undefined, 600_000, 600_000, now);
  const cursorTimestamp = Number((BigInt(cursor) >> 22n) + X_EPOCH_MS);
  assert.equal(cursorTimestamp, now - 600_000);
});

test("merges both sources by tweet id and retains richer context", () => {
  const first = post("100", "sender");
  const duplicateWithContext = { ...post("100"), parentTweetId: "90", parentAuthorUsername: "creator" };
  const merged = mergePostsById([post("300")], [duplicateWithContext, post("200"), first]);
  assert.deepEqual(merged.map((item) => item.id), ["100", "200", "300"]);
  assert.equal(merged[0].authorUsername, "sender");
  assert.equal(merged[0].parentTweetId, "90");
});

test("polls mentions and recent search independently, then deduplicates", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/mentions?")) {
      return new Response(JSON.stringify(postsResponse([
        { id: "100", authorId: "a1", username: "one" },
        { id: "200", authorId: "a2", username: "two" },
      ])), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/search/recent?")) {
      return new Response(JSON.stringify(postsResponse([
        { id: "200", authorId: "a2", username: "two" },
        { id: "300", authorId: "a3", username: "three" },
      ])), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const result = await pollMentions({});
    assert.deepEqual(result.posts.map((item) => item.id), ["100", "200", "300"]);
    assert.deepEqual(result.sourceCounts, { mentions: 2, search: 2 });
    assert.equal(result.state.mentionsLastSeenId, "200");
    assert.equal(result.state.searchLastSeenId, "300");
    assert.deepEqual(result.sourceErrors, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("continues with search when the mentions endpoint returns embedded errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/mentions?")) {
      return new Response(JSON.stringify({ errors: [{ detail: "Could not find user" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/search/recent?")) {
      return new Response(JSON.stringify(postsResponse([{ id: "400", authorId: "a4", username: "four" }])), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const result = await pollMentions({ mentionsLastSeenId: "350", searchLastSeenId: "350" });
    assert.deepEqual(result.posts.map((item) => item.id), ["400"]);
    assert.equal(result.state.mentionsLastSeenId, "350");
    assert.equal(result.state.searchLastSeenId, "400");
    assert.equal(result.sourceErrors.length, 1);
    assert.match(result.sourceErrors[0], /Could not find user/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("startup identity validation rejects a mismatched bot id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: { id: "different-id", username: "teepagent" },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(validateBotIdentity(), /X_BOT_USER_ID does not match/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import { config } from "../config";
import type { XIncomingPost } from "../parser/commandTypes";

const X_SNOWFLAKE_EPOCH_MS = 1_288_834_974_657n;

type RawTweet = {
  id: string;
  text: string;
  author_id: string;
  conversation_id?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
};

type RawUser = { id: string; username: string; name?: string; profile_image_url?: string };
type XApiError = { title?: string; detail?: string; type?: string; value?: string };

type PostsResponse = {
  data?: RawTweet[];
  includes?: { users?: RawUser[]; tweets?: RawTweet[] };
  meta?: { newest_id?: string; oldest_id?: string; result_count?: number; next_token?: string };
  errors?: XApiError[];
};

type UserLookupResponse = {
  data?: { id?: string; username?: string };
  errors?: XApiError[];
};

export type PollingState = {
  mentionsLastSeenId?: string;
  searchLastSeenId?: string;
};

export type PollSourceCounts = {
  mentions: number;
  search: number;
};

async function xFetch(path: string): Promise<Response> {
  const hosts = ["api.x.com", "api.twitter.com"];
  let lastError = "unknown";
  for (const host of hosts) {
    try {
      const response = await fetch(`https://${host}${path}`, {
        headers: { Authorization: `Bearer ${config.bearerToken}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return response;
      lastError = `${host}: HTTP ${response.status}`;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`X API request failed (${lastError})`);
}

function summarizeErrors(errors: XApiError[]) {
  return errors
    .slice(0, 3)
    .map((error) => error.detail || error.title || error.type || "Unknown X API error")
    .join("; ")
    .slice(0, 800);
}

function validatePostsPayload(payload: PostsResponse, source: string) {
  if (!payload.errors?.length) return;
  const summary = summarizeErrors(payload.errors);
  if (!Array.isArray(payload.data)) throw new Error(`X ${source} returned no posts (${summary})`);
  console.warn(`[x-agent] X ${source} returned partial errors: ${summary}`);
}

function usersById(includes?: { users?: RawUser[] }) {
  const map = new Map<string, RawUser>();
  for (const user of includes?.users || []) map.set(user.id, user);
  return map;
}

function tweetsById(includes?: { tweets?: RawTweet[] }) {
  const map = new Map<string, RawTweet>();
  for (const tweet of includes?.tweets || []) map.set(tweet.id, tweet);
  return map;
}

function toIncomingPost(tweet: RawTweet, users: Map<string, RawUser>, refTweets: Map<string, RawTweet>): XIncomingPost {
  const author = users.get(tweet.author_id);
  const replyRef = tweet.referenced_tweets?.find((ref) => ref.type === "replied_to");
  const parent = replyRef ? refTweets.get(replyRef.id) : undefined;
  const parentAuthor = parent ? users.get(parent.author_id) : undefined;

  return {
    id: tweet.id,
    text: tweet.text,
    authorId: tweet.author_id,
    authorUsername: author?.username,
    authorName: author?.name,
    authorProfileImageUrl: author?.profile_image_url,
    conversationId: tweet.conversation_id,
    parentTweetId: parent?.id,
    parentAuthorId: parent?.author_id,
    parentAuthorUsername: parentAuthor?.username,
    parentAuthorName: parentAuthor?.name,
    parentAuthorProfileImageUrl: parentAuthor?.profile_image_url,
  };
}

function postsFromPayload(payload: PostsResponse) {
  const users = usersById(payload.includes);
  const refTweets = tweetsById(payload.includes);
  return (payload.data || []).map((tweet) => toIncomingPost(tweet, users, refTweets));
}

export function overlapSinceId(lastSeenId?: string, overlapMs = config.pollOverlapMs): string | undefined {
  if (!lastSeenId) return undefined;
  try {
    const lastSeenTimestamp = (BigInt(lastSeenId) >> 22n) + X_SNOWFLAKE_EPOCH_MS;
    const overlapTimestamp = lastSeenTimestamp - BigInt(Math.max(0, overlapMs));
    const boundedTimestamp = overlapTimestamp > X_SNOWFLAKE_EPOCH_MS ? overlapTimestamp : X_SNOWFLAKE_EPOCH_MS;
    return ((boundedTimestamp - X_SNOWFLAKE_EPOCH_MS) << 22n).toString();
  } catch {
    return lastSeenId;
  }
}

function snowflakeAtTimestamp(timestampMs: number): string {
  const boundedTimestamp = BigInt(Math.max(timestampMs, Number(X_SNOWFLAKE_EPOCH_MS)));
  return ((boundedTimestamp - X_SNOWFLAKE_EPOCH_MS) << 22n).toString();
}

export function pollingSinceId(
  lastSeenId?: string,
  overlapMs = config.pollOverlapMs,
  bootstrapLookbackMs = config.pollBootstrapLookbackMs,
  nowMs = Date.now()
): string {
  return overlapSinceId(lastSeenId, overlapMs) || snowflakeAtTimestamp(nowMs - Math.max(0, bootstrapLookbackMs));
}

export function newestPostId(posts: XIncomingPost[], previous?: string): string | undefined {
  let newest = previous;
  for (const post of posts) {
    if (!newest || BigInt(post.id) > BigInt(newest)) newest = post.id;
  }
  return newest;
}

export function mergePostsById(...sources: XIncomingPost[][]): XIncomingPost[] {
  const merged = new Map<string, XIncomingPost>();
  for (const posts of sources) {
    for (const post of posts) {
      const existing = merged.get(post.id);
      merged.set(post.id, existing ? {
        ...existing,
        ...post,
        authorUsername: post.authorUsername || existing.authorUsername,
        authorName: post.authorName || existing.authorName,
        authorProfileImageUrl: post.authorProfileImageUrl || existing.authorProfileImageUrl,
        parentTweetId: post.parentTweetId || existing.parentTweetId,
        parentAuthorId: post.parentAuthorId || existing.parentAuthorId,
        parentAuthorUsername: post.parentAuthorUsername || existing.parentAuthorUsername,
        parentAuthorName: post.parentAuthorName || existing.parentAuthorName,
        parentAuthorProfileImageUrl: post.parentAuthorProfileImageUrl || existing.parentAuthorProfileImageUrl,
      } : post);
    }
  }
  return [...merged.values()].sort((a, b) => BigInt(a.id) > BigInt(b.id) ? 1 : BigInt(a.id) < BigInt(b.id) ? -1 : 0);
}

function commonPostParams(maxResults: number) {
  return new URLSearchParams({
    max_results: String(Math.min(Math.max(maxResults, 10), 100)),
    "tweet.fields": "author_id,conversation_id,referenced_tweets",
    expansions: "author_id,referenced_tweets.id,referenced_tweets.id.author_id",
    "user.fields": "username,name,profile_image_url",
  });
}

export async function validateBotIdentity(): Promise<void> {
  const response = await xFetch(`/2/users/by/username/${encodeURIComponent(config.botUsername)}?user.fields=username`);
  const payload = await response.json() as UserLookupResponse;
  if (payload.errors?.length || !payload.data?.id) {
    throw new Error(`Could not resolve @${config.botUsername} (${summarizeErrors(payload.errors || []) || "missing user data"})`);
  }
  if (payload.data.id !== config.botUserId) {
    throw new Error(`X_BOT_USER_ID does not match @${config.botUsername}: configured ${config.botUserId}, X returned ${payload.data.id}`);
  }
}

export async function fetchRecentMentions(sinceId?: string): Promise<XIncomingPost[]> {
  const params = commonPostParams(config.mentionsPageSize);
  if (sinceId) params.set("since_id", sinceId);
  const response = await xFetch(`/2/users/${config.botUserId}/mentions?${params.toString()}`);
  const payload = await response.json() as PostsResponse;
  validatePostsPayload(payload, "mentions timeline");
  return postsFromPayload(payload);
}

export async function fetchRecentSearchMatches(sinceId?: string): Promise<XIncomingPost[]> {
  const params = commonPostParams(config.searchPageSize);
  params.set("query", `@${config.botUsername} -from:${config.botUsername}`);
  if (sinceId) params.set("since_id", sinceId);
  const response = await xFetch(`/2/tweets/search/recent?${params.toString()}`);
  const payload = await response.json() as PostsResponse;
  validatePostsPayload(payload, "recent search");
  return postsFromPayload(payload);
}

export async function pollMentions(state: PollingState): Promise<{
  posts: XIncomingPost[];
  state: PollingState;
  sourceCounts: PollSourceCounts;
  sourceErrors: string[];
}> {
  const [mentionsResult, searchResult] = await Promise.allSettled([
    fetchRecentMentions(pollingSinceId(state.mentionsLastSeenId)),
    fetchRecentSearchMatches(pollingSinceId(state.searchLastSeenId)),
  ]);

  const sourceErrors: string[] = [];
  const mentions = mentionsResult.status === "fulfilled" ? mentionsResult.value : [];
  const search = searchResult.status === "fulfilled" ? searchResult.value : [];
  if (mentionsResult.status === "rejected") {
    sourceErrors.push(`mentions: ${mentionsResult.reason instanceof Error ? mentionsResult.reason.message : String(mentionsResult.reason)}`);
  }
  if (searchResult.status === "rejected") {
    sourceErrors.push(`search: ${searchResult.reason instanceof Error ? searchResult.reason.message : String(searchResult.reason)}`);
  }
  if (sourceErrors.length === 2) throw new Error(sourceErrors.join(" | "));

  return {
    posts: mergePostsById(mentions, search),
    state: {
      mentionsLastSeenId: mentionsResult.status === "fulfilled"
        ? newestPostId(mentions, state.mentionsLastSeenId)
        : state.mentionsLastSeenId,
      searchLastSeenId: searchResult.status === "fulfilled"
        ? newestPostId(search, state.searchLastSeenId)
        : state.searchLastSeenId,
    },
    sourceCounts: { mentions: mentions.length, search: search.length },
    sourceErrors,
  };
}

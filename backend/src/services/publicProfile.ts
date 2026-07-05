import { getDb } from "../db/database";
import { resolveAddressIdentities, type AddressDisplayIdentity } from "./identity";
import { getUserSettings } from "./userSettings";

export type PublicProfilePost = {
  contentId: string;
  total: string;
  count: number;
  tweetId: string | null;
  authorHandle: string | null;
};

export type PublicProfileSupporter = {
  address: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  isPrivate: boolean;
  total: string;
};

export type PublicProfileRecentTip = {
  address: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  isPrivate: boolean;
  amount: string;
  timestamp: number;
  txHash: string;
  tweetId: string | null;
  authorHandle: string | null;
};

export type PublicCreatorProfile = {
  username: string;
  displayName: string | null;
  profileImageUrl: string | null;
  authorId: string;
  totalReceived: string;
  tipCount: number;
  supporterCount: number;
  topPosts: PublicProfilePost[];
  privacy: {
    hideSupporterNamesPublicly: boolean;
    hideGrowthActivity: boolean;
  };
  topSupporters: PublicProfileSupporter[];
  recentTips: PublicProfileRecentTip[];
};

type CreatorClaim = {
  author_id: string;
  username: string;
  display_name: string | null;
  profile_image_url: string | null;
  owner_address: string;
};

function creatorTipPredicate(alias = "t"): string {
  return `(${alias}.author_id = ? OR LOWER(COALESCE(m.author_handle, '')) = LOWER(?))`;
}

export async function getPublicCreatorProfileByUsername(usernameParam: string): Promise<PublicCreatorProfile | null> {
  const username = usernameParam.replace(/^@/, "").toLowerCase();
  const db = getDb();

  const claim = await db
    .prepare(
      "SELECT author_id, username, display_name, profile_image_url, owner_address FROM verified_claims WHERE LOWER(username) = ?",
    )
    .get(username) as CreatorClaim | undefined;

  if (!claim) return null;

  const total = await db
    .prepare(
      `SELECT COALESCE(SUM(CAST(t.amount AS NUMERIC)), 0) as total, COUNT(*) as count
       FROM tips t
       LEFT JOIN tip_metadata m ON t.content_id = m.content_id
       WHERE ${creatorTipPredicate("t")}`,
    )
    .get(claim.author_id, claim.username) as { total: number; count: number } | undefined;

  const topPosts = await db
    .prepare(
      `SELECT t.content_id, SUM(CAST(t.amount AS NUMERIC)) as total, COUNT(*) as count,
              MAX(m.tweet_id) as tweet_id, MAX(m.author_handle) as author_handle
       FROM tips t
       LEFT JOIN tip_metadata m ON t.content_id = m.content_id
       WHERE ${creatorTipPredicate("t")}
       GROUP BY t.content_id
       ORDER BY total DESC
       LIMIT 10`,
    )
    .all(claim.author_id, claim.username) as Array<{
    content_id: string;
    total: string;
    count: number;
    tweet_id: string | null;
    author_handle: string | null;
  }>;

  const topSupporters = await db
    .prepare(
      `SELECT t.from_address, SUM(CAST(t.amount AS NUMERIC)) as total
       FROM tips t
       LEFT JOIN tip_metadata m ON t.content_id = m.content_id
       WHERE ${creatorTipPredicate("t")}
       GROUP BY t.from_address
       ORDER BY total DESC
       LIMIT 10`,
    )
    .all(claim.author_id, claim.username) as Array<{ from_address: string; total: string }>;

  const recentTips = await db
    .prepare(
      `SELECT t.from_address, t.amount, t.timestamp, t.tx_hash,
              m.tweet_id, m.author_handle
       FROM tips t
       LEFT JOIN tip_metadata m ON t.content_id = m.content_id
       WHERE ${creatorTipPredicate("t")}
       ORDER BY t.timestamp DESC
       LIMIT 12`,
    )
    .all(claim.author_id, claim.username) as Array<{
    from_address: string;
    amount: string | number;
    timestamp: number;
    tx_hash: string;
    tweet_id: string | null;
    author_handle: string | null;
  }>;

  const supporterCount = await db
    .prepare(
      `SELECT COUNT(DISTINCT LOWER(t.from_address)) as count
       FROM tips t
       LEFT JOIN tip_metadata m ON t.content_id = m.content_id
       WHERE ${creatorTipPredicate("t")}`,
    )
    .get(claim.author_id, claim.username) as { count: number } | undefined;

  const creatorSettings = await getUserSettings(claim.owner_address);
  const hideSupporterNames = creatorSettings.privacy.hideSupporterNamesPublicly;
  const supporterIdentities: Map<string, AddressDisplayIdentity> = hideSupporterNames
    ? new Map()
    : await resolveAddressIdentities([
        ...topSupporters.map((supporter) => supporter.from_address),
        ...recentTips.map((tip) => tip.from_address),
      ]);

  return {
    username: claim.username,
    displayName: claim.display_name,
    profileImageUrl: claim.profile_image_url,
    authorId: claim.author_id,
    totalReceived: total?.total?.toString() || "0",
    tipCount: Number(total?.count || 0),
    supporterCount: Number(supporterCount?.count || 0),
    topPosts: topPosts.map((post) => ({
      contentId: post.content_id,
      total: (Number(post.total) / 1e6).toString(),
      count: Number(post.count),
      tweetId: post.tweet_id,
      authorHandle: post.author_handle,
    })),
    privacy: {
      hideSupporterNamesPublicly: hideSupporterNames,
      hideGrowthActivity: creatorSettings.privacy.hideGrowthActivity,
    },
    topSupporters: topSupporters.map((supporter, index) => ({
      address: hideSupporterNames ? null : supporter.from_address,
      displayName: hideSupporterNames
        ? `Private supporter ${index + 1}`
        : supporterIdentities.get(supporter.from_address.toLowerCase())?.displayName || null,
      profileImageUrl: hideSupporterNames
        ? null
        : supporterIdentities.get(supporter.from_address.toLowerCase())?.profileImageUrl || null,
      isPrivate: hideSupporterNames,
      total: (Number(supporter.total) / 1e6).toString(),
    })),
    recentTips: recentTips.map((tip, index) => {
      const identity = hideSupporterNames ? null : supporterIdentities.get(tip.from_address.toLowerCase());
      return {
        address: hideSupporterNames ? null : tip.from_address,
        displayName: hideSupporterNames ? `Private supporter ${index + 1}` : identity?.displayName || null,
        profileImageUrl: hideSupporterNames ? null : identity?.profileImageUrl || null,
        isPrivate: hideSupporterNames,
        amount: (Number(tip.amount) / 1e6).toString(),
        timestamp: tip.timestamp,
        txHash: tip.tx_hash,
        tweetId: tip.tweet_id,
        authorHandle: tip.author_handle,
      };
    }),
  };
}

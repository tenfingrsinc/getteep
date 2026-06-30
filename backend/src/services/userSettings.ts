import { one, run } from "../db/database";
import { isAddress, normalizeHandle } from "../utils/security";

export type UserSettings = {
  address: string;
  username: string | null;
  socialXHandle: string | null;
  creatorIdentity: {
    authorId: string;
    username: string;
    displayName: string | null;
    profileImageUrl: string | null;
  } | null;
  defaultTipAmount: string;
  receipts: {
    shareLinksEnabled: boolean;
    shareAmountEnabled: boolean;
    postAwareCopyEnabled: boolean;
  };
  notifications: {
    creatorClaimed: boolean;
    lowBalance: boolean;
    receiptReady: boolean;
    newTip: boolean;
    repeatSupporter: boolean;
    claimWalletActivity: boolean;
    withdrawalCompleted: boolean;
    growTipsStatus: boolean;
  };
  privacy: {
    hideAddress: boolean;
    privateActivity: boolean;
    requireVerification: boolean;
    hideSupporterNamesPublicly: boolean;
    hideGrowthActivity: boolean;
  };
  payout: {
    defaultDestination: string | null;
    confirmationPreference: "email" | "wallet" | "both";
    notifications: boolean;
  };
  growTips: {
    defaultStrategyId: string | null;
    riskVisibilityLevel: "minimal" | "standard" | "detailed";
    maturityExitReminders: boolean;
  };
  engagement: {
    defaultThankYouMessage: string;
    autoSuggestXThankYou: boolean;
    repeatSupporterReminders: boolean;
  };
  updatedAt: string | null;
};

function normalizeChoice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function normalizePreferredUsername(value?: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(normalized)) return null;
  if (/^_+$/.test(normalized)) return null;
  return normalized;
}

function isGeneratedMetricLikeUsername(username?: string | null): boolean {
  return /^teep_(bright|steady|kind|early|social|solid|prime|spark)_\d{4}(?:_\d+)?$/.test(username || "");
}

async function usernameOwner(username: string): Promise<string | null> {
  const row = await one<{ address: string }>("SELECT address FROM user_settings WHERE username = ? LIMIT 1", [username]);
  return row?.address?.toLowerCase() || null;
}

function usernameCandidate(base: string, attempt: number): string {
  if (attempt === 0) return base;
  const suffix = `_${attempt + 1}`;
  return `${base.slice(0, 24 - suffix.length)}${suffix}`;
}

async function claimPreferredUsername(address: string, preferredUsername?: string | null): Promise<string | null> {
  const normalized = normalizePreferredUsername(preferredUsername);
  if (!normalized) return null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const username = usernameCandidate(normalized, attempt);
    const owner = await usernameOwner(username);
    if (!owner || owner === address) return username;
  }
  return null;
}

async function ensureUserSettingsRow(address: string, preferredUsername?: string | null): Promise<any> {
  const normalized = address.toLowerCase();
  const existing = await one<any>("SELECT *, updated_at as \"updatedAt\" FROM user_settings WHERE address = ? LIMIT 1", [normalized]);
  const claimedUsername = await claimPreferredUsername(normalized, preferredUsername);

  if (existing) {
    if (claimedUsername && (!existing.username || isGeneratedMetricLikeUsername(existing.username))) {
      await run("UPDATE user_settings SET username = ?, updated_at = now() WHERE address = ?", [claimedUsername, normalized]);
      return one<any>("SELECT *, updated_at as \"updatedAt\" FROM user_settings WHERE address = ? LIMIT 1", [normalized]);
    }
    return existing;
  }

  if (claimedUsername) {
    await run(
      "INSERT INTO user_settings (address, username, updated_at) VALUES (?, ?, now()) ON CONFLICT (address) DO NOTHING",
      [normalized, claimedUsername]
    );
  } else {
    await run(
      "INSERT INTO user_settings (address, updated_at) VALUES (?, now()) ON CONFLICT (address) DO NOTHING",
      [normalized]
    );
  }
  return one<any>("SELECT *, updated_at as \"updatedAt\" FROM user_settings WHERE address = ? LIMIT 1", [normalized]);
}

async function creatorIdentityForAddress(address: string): Promise<UserSettings["creatorIdentity"]> {
  const claim = await one<{
    author_id: string;
    username: string;
    display_name: string | null;
    profile_image_url: string | null;
  }>(
    `SELECT author_id, username, display_name, profile_image_url
     FROM verified_claims
     WHERE owner_address = ?
     ORDER BY verified_at DESC
     LIMIT 1`,
    [address.toLowerCase()]
  );
  if (!claim) return null;
  return {
    authorId: claim.author_id,
    username: claim.username,
    displayName: claim.display_name,
    profileImageUrl: claim.profile_image_url,
  };
}

function enabled(value: unknown, fallback = true) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return fallback;
}

export async function settingsRowToResponse(address: string, row?: any): Promise<UserSettings> {
  const normalized = address.toLowerCase();
  return {
    address: normalized,
    username: row?.username ?? null,
    socialXHandle: row?.social_x_handle ?? null,
    creatorIdentity: await creatorIdentityForAddress(normalized),
    defaultTipAmount: row?.default_tip_amount ?? "5.00",
    receipts: {
      shareLinksEnabled: true,
      shareAmountEnabled: enabled(row?.receipt_share_amount_enabled),
      postAwareCopyEnabled: true,
    },
    notifications: {
      creatorClaimed: enabled(row?.notify_creator_claimed),
      lowBalance: enabled(row?.notify_low_balance),
      receiptReady: enabled(row?.notify_receipt_ready, false),
      newTip: enabled(row?.notify_new_tip),
      repeatSupporter: enabled(row?.notify_repeat_supporter),
      claimWalletActivity: enabled(row?.notify_claim_wallet_activity),
      withdrawalCompleted: enabled(row?.notify_withdrawal_completed),
      growTipsStatus: enabled(row?.notify_grow_tips_status),
    },
    privacy: {
      hideAddress: enabled(row?.privacy_hide_address),
      privateActivity: enabled(row?.privacy_private_activity),
      requireVerification: enabled(row?.privacy_require_verification),
      hideSupporterNamesPublicly: enabled(row?.privacy_hide_supporter_names_publicly, false),
      hideGrowthActivity: enabled(row?.privacy_hide_growth_activity, false),
    },
    payout: {
      defaultDestination: row?.payout_default_destination ?? null,
      confirmationPreference: normalizeChoice(row?.payout_confirmation_preference, ["email", "wallet", "both"] as const, "email"),
      notifications: enabled(row?.payout_notifications),
    },
    growTips: {
      defaultStrategyId: row?.grow_default_strategy_id ?? null,
      riskVisibilityLevel: normalizeChoice(row?.grow_risk_visibility_level, ["minimal", "standard", "detailed"] as const, "standard"),
      maturityExitReminders: enabled(row?.grow_maturity_exit_reminders),
    },
    engagement: {
      defaultThankYouMessage: row?.engagement_default_thank_you_message || "Thank you for supporting my work on Teep.",
      autoSuggestXThankYou: enabled(row?.engagement_auto_suggest_x_thank_you),
      repeatSupporterReminders: enabled(row?.engagement_repeat_supporter_reminders),
    },
    updatedAt: row?.updatedAt ?? row?.updated_at ?? null,
  };
}

export async function getUserSettings(address: string, preferredUsername?: string | null): Promise<UserSettings> {
  const normalized = address.toLowerCase();
  const row = await ensureUserSettingsRow(normalized, preferredUsername);
  return settingsRowToResponse(normalized, row);
}

export async function resolveTipperIdentifier(identifier: string): Promise<string | null> {
  const raw = identifier.trim();
  if (isAddress(raw)) return raw.toLowerCase();

  const handle = normalizeHandle(raw);
  if (!handle) return null;

  const row = await one<{ address: string }>(
    `SELECT address
     FROM user_settings
     WHERE LOWER(username) = ? OR LOWER(social_x_handle) = ?
     ORDER BY updated_at DESC
     LIMIT 1`,
    [handle, handle]
  );

  return row?.address?.toLowerCase() || null;
}

export async function publicIdentity(address: string) {
  const settings = await getUserSettings(address);
  const label = settings.socialXHandle
    ? `@${settings.socialXHandle.replace(/^@/, "")}`
    : settings.username
      ? `@${settings.username.replace(/^@/, "")}`
      : "Teep supporter";
  return {
    label,
    socialXHandle: settings.socialXHandle,
    address: settings.privacy.hideAddress ? null : address,
  };
}

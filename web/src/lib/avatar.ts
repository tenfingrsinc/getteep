import { API_BASE } from "../config";
import type { SyntheticEvent } from "react";

const AVATAR_CACHE_VERSION = "2";

function normalizeHandle(value?: string | null): string | null {
  const normalized = value?.trim().replace(/^@/, "").toLowerCase();
  if (!normalized || !/^[a-z0-9_]{1,15}$/.test(normalized)) return null;
  return normalized;
}

export function localInitialsAvatar(seed?: string | null): string {
  const label = (seed || "T").replace(/^@/, "").replace(/[^a-z0-9_]/gi, "").slice(0, 2).toUpperCase() || "T";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" rx="80" fill="#21143a"/><circle cx="80" cy="80" r="74" fill="none" stroke="#6d28d9" stroke-width="8"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="#f6f0ff" font-family="Inter, Arial, sans-serif" font-size="52" font-weight="800">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function xAvatarUrl(handle?: string | null): string | null {
  const normalized = normalizeHandle(handle);
  if (!normalized) return null;
  return `${API_BASE}/api/v1/avatar/x/${encodeURIComponent(normalized)}?v=${AVATAR_CACHE_VERSION}`;
}

function proxiedAvatarUrl(url?: string | null, seed?: string | null): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const hostname = parsed.hostname.toLowerCase();
  if (!["pbs.twimg.com", "abs.twimg.com"].includes(hostname)) return null;
  const params = new URLSearchParams({ src: parsed.toString(), v: AVATAR_CACHE_VERSION });
  if (seed) params.set("seed", seed);
  return `${API_BASE}/api/v1/avatar?${params.toString()}`;
}

export function creatorAvatarUrl(params: { username?: string | null; authorId?: string | null; seed?: string | null; profileImageUrl?: string | null }): string {
  const seed = params.seed || params.username || params.authorId || "creator";
  return proxiedAvatarUrl(params.profileImageUrl, seed) || xAvatarUrl(params.username) || localInitialsAvatar(seed);
}

export function avatarErrorFallback(event: SyntheticEvent<HTMLImageElement>, seed?: string | null): void {
  event.currentTarget.src = localInitialsAvatar(seed);
}

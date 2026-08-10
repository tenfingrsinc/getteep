import crypto, { type JsonWebKey as NodeJsonWebKey, type KeyObject } from "crypto";
import jwt, { JsonWebTokenError, TokenExpiredError, type JwtHeader, type JwtPayload } from "jsonwebtoken";
import { isAddress } from "../utils/security";

const PRIVY_API_URL = "https://api.privy.io";
const PRIVY_AUTH_URL = "https://auth.privy.io";
const PRIVY_REQUEST_TIMEOUT_MS = Math.max(1_000, Number(process.env.PRIVY_REQUEST_TIMEOUT_MS || 5_000));
const PRIVY_JWKS_CACHE_TTL_MS = Math.max(60_000, Number(process.env.PRIVY_JWKS_CACHE_TTL_MS || 15 * 60_000));
const PRIVY_OWNERSHIP_CACHE_TTL_MS = Math.max(
  5_000,
  Math.min(5 * 60_000, Number(process.env.PRIVY_OWNERSHIP_CACHE_TTL_MS || 60_000))
);
const MAX_ACCESS_TOKEN_LENGTH = 12_000;

type PrivyAccessClaims = {
  userId: string;
  sessionId: string;
  appId: string;
  expiration: number;
};

type PrivyLinkedAccount = {
  type?: unknown;
  address?: unknown;
};

type PrivyUser = {
  id?: unknown;
  linked_accounts?: unknown;
};

type PrivyJwk = NodeJsonWebKey & {
  kid?: string;
  alg?: string;
  use?: string;
};

type JwksCache = {
  expiresAt: number;
  keys: Map<string, KeyObject>;
};

export class PrivyAuthError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

let jwksCache: JwksCache | null = null;
const ownershipCache = new Map<string, number>();

function getPrivyConfig() {
  const appId = (process.env.PRIVY_APP_ID || process.env.VITE_PRIVY_APP_ID || "").trim();
  const appSecret = (process.env.PRIVY_APP_SECRET || "").trim();
  if (!appId) {
    throw new PrivyAuthError(503, "PRIVY_AUTH_NOT_CONFIGURED", "Account verification is temporarily unavailable.");
  }
  return { appId, appSecret };
}

function privyHeaders(appId: string, appSecret: string) {
  return {
    Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`,
    "privy-app-id": appId,
    "Content-Type": "application/json",
  };
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRIVY_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function configuredVerificationKey(): KeyObject | null {
  const value = (process.env.PRIVY_JWT_VERIFICATION_KEY || process.env.PRIVY_VERIFICATION_KEY || "").trim();
  if (!value) return null;
  try {
    const normalized = value.replace(/\\n/g, "\n");
    if (normalized.startsWith("{")) {
      return crypto.createPublicKey({ key: JSON.parse(normalized) as NodeJsonWebKey, format: "jwk" });
    }
    return crypto.createPublicKey(normalized);
  } catch {
    throw new PrivyAuthError(503, "PRIVY_AUTH_MISCONFIGURED", "Account verification is temporarily unavailable.");
  }
}

async function refreshJwks(appId: string): Promise<JwksCache> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${PRIVY_AUTH_URL}/api/v1/apps/${encodeURIComponent(appId)}/jwks.json`, {
      headers: { Accept: "application/json", "privy-app-id": appId },
    });
  } catch {
    throw new PrivyAuthError(503, "PRIVY_AUTH_UNAVAILABLE", "Account verification is temporarily unavailable.");
  }
  if (!response.ok) {
    throw new PrivyAuthError(503, "PRIVY_AUTH_UNAVAILABLE", "Account verification is temporarily unavailable.");
  }

  const payload = await response.json().catch(() => null) as { keys?: unknown } | null;
  if (!payload || !Array.isArray(payload.keys) || payload.keys.length === 0 || payload.keys.length > 20) {
    throw new PrivyAuthError(503, "PRIVY_AUTH_UNAVAILABLE", "Account verification is temporarily unavailable.");
  }

  const keys = new Map<string, KeyObject>();
  for (const candidate of payload.keys as PrivyJwk[]) {
    if (
      !candidate ||
      typeof candidate.kid !== "string" ||
      candidate.kid.length > 256 ||
      candidate.kty !== "EC" ||
      candidate.crv !== "P-256" ||
      (candidate.alg && candidate.alg !== "ES256") ||
      (candidate.use && candidate.use !== "sig")
    ) continue;
    try {
      keys.set(candidate.kid, crypto.createPublicKey({ key: candidate, format: "jwk" }));
    } catch {
      // Ignore malformed keys; a valid matching key is still required below.
    }
  }
  if (keys.size === 0) {
    throw new PrivyAuthError(503, "PRIVY_AUTH_UNAVAILABLE", "Account verification is temporarily unavailable.");
  }
  jwksCache = { expiresAt: Date.now() + PRIVY_JWKS_CACHE_TTL_MS, keys };
  return jwksCache;
}

async function verificationKey(header: JwtHeader, appId: string): Promise<KeyObject> {
  const configured = configuredVerificationKey();
  if (configured) return configured;
  if (typeof header.kid !== "string" || !header.kid || header.kid.length > 256) {
    throw new PrivyAuthError(401, "INVALID_PRIVY_TOKEN", "Your Teep session is invalid. Sign in again.");
  }

  let cache = jwksCache;
  if (!cache || cache.expiresAt <= Date.now()) cache = await refreshJwks(appId);
  let key = cache.keys.get(header.kid);
  if (!key) {
    cache = await refreshJwks(appId);
    key = cache.keys.get(header.kid);
  }
  if (!key) throw new PrivyAuthError(401, "INVALID_PRIVY_TOKEN", "Your Teep session is invalid. Sign in again.");
  return key;
}

function decodeTokenHeader(token: string): JwtHeader {
  const decoded = jwt.decode(token, { complete: true });
  if (
    !decoded ||
    typeof decoded !== "object" ||
    !decoded.header ||
    decoded.header.alg !== "ES256" ||
    (decoded.header.typ !== undefined && decoded.header.typ !== "JWT")
  ) {
    throw new PrivyAuthError(401, "INVALID_PRIVY_TOKEN", "Your Teep session is invalid. Sign in again.");
  }
  return decoded.header;
}

function invalidTokenReason(error: unknown) {
  if (error instanceof TokenExpiredError) return "expired";
  if (error instanceof JsonWebTokenError) {
    if (error.message.startsWith("jwt audience invalid")) return "audience_mismatch";
    if (error.message.startsWith("jwt issuer invalid")) return "issuer_mismatch";
    if (error.message === "invalid signature") return "signature_invalid";
    return "jwt_invalid";
  }
  return "claims_invalid";
}

export function bearerToken(authorization: unknown): string {
  if (typeof authorization !== "string") return "";
  const match = authorization.match(/^Bearer ([^\s]+)$/);
  return match?.[1] || "";
}

export async function verifyPrivyAccessToken(token: string): Promise<PrivyAccessClaims> {
  if (!token || token.length > MAX_ACCESS_TOKEN_LENGTH) {
    throw new PrivyAuthError(401, "PRIVY_SESSION_REQUIRED", "Sign in to your Teep account to continue.");
  }
  const { appId } = getPrivyConfig();
  const header = decodeTokenHeader(token);
  const key = await verificationKey(header, appId);

  let payload: JwtPayload;
  try {
    const verified = jwt.verify(token, key, {
      algorithms: ["ES256"],
      audience: appId,
      issuer: "privy.io",
      clockTolerance: 5,
    });
    if (typeof verified === "string") throw new Error("Unexpected token payload");
    payload = verified;
  } catch (error) {
    console.warn(`[Privy auth] Access token rejected (${invalidTokenReason(error)}).`);
    throw new PrivyAuthError(401, "INVALID_PRIVY_TOKEN", "Your Teep session expired. Sign in again.");
  }

  const userId = typeof payload.sub === "string" ? payload.sub : "";
  const sessionId = typeof payload.sid === "string" ? payload.sid : "";
  if (!/^did:privy:[a-zA-Z0-9_-]+$/.test(userId) || !sessionId || sessionId.length > 256 || !payload.exp) {
    console.warn("[Privy auth] Access token rejected (required_claims_invalid).");
    throw new PrivyAuthError(401, "INVALID_PRIVY_TOKEN", "Your Teep session is invalid. Sign in again.");
  }
  return { userId, sessionId, appId, expiration: payload.exp };
}

async function getPrivyUser(userId: string): Promise<PrivyUser> {
  const { appId, appSecret } = getPrivyConfig();
  if (!appSecret) {
    throw new PrivyAuthError(503, "PRIVY_AUTH_NOT_CONFIGURED", "Account verification is temporarily unavailable.");
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(`${PRIVY_API_URL}/v1/users/${encodeURIComponent(userId)}`, {
      headers: privyHeaders(appId, appSecret),
    });
  } catch {
    throw new PrivyAuthError(503, "PRIVY_AUTH_UNAVAILABLE", "Account verification is temporarily unavailable.");
  }
  if (response.status === 404) {
    throw new PrivyAuthError(401, "PRIVY_USER_NOT_FOUND", "Your Teep account could not be verified. Sign in again.");
  }
  if (!response.ok) {
    throw new PrivyAuthError(503, "PRIVY_AUTH_UNAVAILABLE", "Account verification is temporarily unavailable.");
  }
  return await response.json() as PrivyUser;
}

export async function verifyPrivyUserOwnsAddress(userId: string, address: string) {
  if (!/^did:privy:[a-zA-Z0-9_-]+$/.test(userId) || !isAddress(address)) {
    throw new PrivyAuthError(403, "WALLET_NOT_LINKED", "This wallet is not linked to your Teep account.");
  }
  const normalizedAddress = address.toLowerCase();
  const cacheKey = `${userId}:${normalizedAddress}`;
  if ((ownershipCache.get(cacheKey) || 0) > Date.now()) return;

  const payload = await getPrivyUser(userId);
  const accounts = Array.isArray(payload.linked_accounts) ? payload.linked_accounts as PrivyLinkedAccount[] : [];
  const ownsAddress = accounts.some((account) =>
    (account.type === "wallet" || account.type === "smart_wallet") &&
    typeof account.address === "string" &&
    isAddress(account.address) &&
    account.address.toLowerCase() === normalizedAddress
  );
  if (!ownsAddress) {
    throw new PrivyAuthError(403, "WALLET_NOT_LINKED", "This wallet is not linked to your Teep account.");
  }

  if (ownershipCache.size >= 5_000) {
    const now = Date.now();
    for (const [key, expiresAt] of ownershipCache) {
      if (expiresAt <= now) ownershipCache.delete(key);
    }
    if (ownershipCache.size >= 5_000) ownershipCache.delete(ownershipCache.keys().next().value as string);
  }
  ownershipCache.set(cacheKey, Date.now() + PRIVY_OWNERSHIP_CACHE_TTL_MS);
}

export async function authorizePrivyWallet(authorization: unknown, address: string) {
  if (!isAddress(address)) {
    throw new PrivyAuthError(400, "INVALID_ADDRESS", "Invalid account address.");
  }
  const claims = await verifyPrivyAccessToken(bearerToken(authorization));
  await verifyPrivyUserOwnsAddress(claims.userId, address);
  return claims;
}

export async function deletePrivyUser(userId: string) {
  if (!/^did:privy:[a-zA-Z0-9_-]+$/.test(userId)) {
    throw Object.assign(new Error("Invalid Privy user id"), { status: 400 });
  }
  const { appId, appSecret } = getPrivyConfig();
  if (!appSecret) throw Object.assign(new Error("Privy account deletion is not configured."), { status: 501 });
  const response = await fetchWithTimeout(`${PRIVY_API_URL}/v1/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: privyHeaders(appId, appSecret),
  });
  if (response.ok || response.status === 404) return;
  const payload = await response.json().catch(() => null) as { message?: string; error?: string } | null;
  throw Object.assign(new Error(payload?.message || payload?.error || "Privy account deletion failed"), { status: response.status });
}

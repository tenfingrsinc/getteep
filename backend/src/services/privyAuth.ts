import type * as PrivyNodeSdk from "@privy-io/node";
import { isAddress } from "../utils/security";

const PRIVY_API_URL = "https://api.privy.io";
const PRIVY_REQUEST_TIMEOUT_MS = Math.max(1_000, Number(process.env.PRIVY_REQUEST_TIMEOUT_MS || 5_000));
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

type PrivySdk = typeof PrivyNodeSdk;
type PrivyClientInstance = InstanceType<PrivySdk["PrivyClient"]>;

// The Privy SDK currently publishes a CommonJS entry that requires its
// ESM-only jose dependency. Node 18 cannot execute that combination. Keeping
// the import native selects Privy's ESM entry and works on both Node 18 and 22.
// Function receives only this fixed, developer-controlled package name.
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<PrivySdk>;
let privySdkPromise: Promise<PrivySdk> | null = null;

function getPrivySdk() {
  privySdkPromise ??= nativeImport("@privy-io/node");
  return privySdkPromise;
}

export class PrivyAuthError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

let cachedClient: { fingerprint: string; client: PrivyClientInstance } | null = null;
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

async function getPrivyClient() {
  const { appId, appSecret } = getPrivyConfig();
  if (!appSecret) {
    throw new PrivyAuthError(503, "PRIVY_AUTH_NOT_CONFIGURED", "Offers authentication is not configured on the server.");
  }
  const verificationKey = (process.env.PRIVY_JWT_VERIFICATION_KEY || process.env.PRIVY_VERIFICATION_KEY || "")
    .trim()
    .replace(/\\n/g, "\n");
  const fingerprint = `${appId}:${appSecret}:${verificationKey}`;
  if (cachedClient?.fingerprint === fingerprint) return cachedClient.client;

  const { PrivyClient } = await getPrivySdk();
  const client = new PrivyClient({
    appId,
    appSecret,
    apiUrl: PRIVY_API_URL,
    jwtVerificationKey: verificationKey || undefined,
    timeout: PRIVY_REQUEST_TIMEOUT_MS,
    maxRetries: 1,
  });
  cachedClient = { fingerprint, client };
  return client;
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

export function bearerToken(authorization: unknown): string {
  if (typeof authorization !== "string") return "";
  const match = authorization.match(/^Bearer ([^\s]+)$/);
  return match?.[1] || "";
}

export async function verifyPrivyAccessToken(token: string): Promise<PrivyAccessClaims> {
  if (!token || token.length > MAX_ACCESS_TOKEN_LENGTH) {
    throw new PrivyAuthError(401, "PRIVY_SESSION_REQUIRED", "Sign in to your Teep account to continue.");
  }
  let verified;
  try {
    const client = await getPrivyClient();
    verified = await client.utils().auth().verifyAccessToken(token);
  } catch (error) {
    const { InvalidAuthTokenError } = await getPrivySdk().catch(() => ({ InvalidAuthTokenError: null }));
    if (!InvalidAuthTokenError || !(error instanceof InvalidAuthTokenError)) {
      throw new PrivyAuthError(503, "PRIVY_AUTH_UNAVAILABLE", "Account verification is temporarily unavailable.");
    }
    throw new PrivyAuthError(401, "INVALID_PRIVY_TOKEN", "Your Teep session expired. Sign in again.");
  }

  const { user_id: userId, session_id: sessionId, app_id: appId, expiration } = verified;
  if (!/^did:privy:[a-zA-Z0-9_-]+$/.test(userId) || !sessionId || sessionId.length > 256 || !expiration) {
    throw new PrivyAuthError(401, "INVALID_PRIVY_TOKEN", "Your Teep session is invalid. Sign in again.");
  }
  return { userId, sessionId, appId, expiration };
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

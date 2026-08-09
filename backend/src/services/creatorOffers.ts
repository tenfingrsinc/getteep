import crypto from "crypto";
import { getDb, one, query, run } from "../db/database";
import { isAddress } from "../utils/security";
import { createNotification } from "./notifications";
import { publishDashboardUpdate } from "./dashboardUpdates";

const USDC_SCALE = 1_000_000n;
const OFFER_WORKER_INTERVAL_MS = Math.max(500, Number(process.env.OFFER_WORKER_INTERVAL_MS || 2_000));
const OFFER_EVALUATION_STALE_MS = Math.max(30_000, Number(process.env.OFFER_EVALUATION_STALE_MS || 5 * 60_000));
const OFFER_MAX_CODES_PER_IMPORT = Math.max(1, Math.min(5_000, Number(process.env.OFFER_MAX_CODES_PER_IMPORT || 1_000)));
const OFFER_READ_SESSION_TTL_MS = Math.max(60_000, Number(process.env.OFFER_READ_SESSION_TTL_MS || 15 * 60_000));
const WEB_APP_URL = (process.env.WEB_APP_URL || "https://getteep.xyz").replace(/\/$/, "");
const X_REPLY_MAX_CHARACTERS = 280;

export const OFFER_TYPES = ["ACCESS", "CODE", "LINK", "CUSTOM"] as const;
export const CONDITION_TYPES = [
  "SINGLE_TIP_MINIMUM",
  "CUMULATIVE_TIPS_MINIMUM",
  "SPECIFIC_X_POST_MINIMUM",
] as const;
export const FULFILLMENT_TYPES = [
  "PROTECTED_LINK",
  "SHARED_CODE",
  "UNIQUE_CODE",
  "INSTRUCTIONS",
  "CUSTOM",
] as const;

type OfferType = (typeof OFFER_TYPES)[number];
type ConditionType = (typeof CONDITION_TYPES)[number];
type FulfillmentType = (typeof FULFILLMENT_TYPES)[number];

type CreatorIdentity = {
  authorId: string;
  ownerAddress: string;
  username: string;
};

type ConditionConfig = {
  amountRaw: string;
  currency: "USDC";
  postId?: string;
};

type OfferRow = {
  id: string;
  creatorAuthorId: string;
  creatorOwnerAddress: string;
  creatorUsername: string;
  name: string;
  description: string;
  offerType: OfferType;
  status: string;
  visibility: string;
  conditionType: ConditionType;
  conditionConfigJson: string;
  maxClaims: number | null;
  claimsReserved: number | string;
  claimsCompleted: number | string;
  onePerSupporter: boolean;
  startsAt: number | string;
  endsAt: number | string | null;
  claimWindowSeconds: number | string | null;
  version: number | string;
  createdAt: number | string;
  updatedAt: number | string;
  fulfillmentType?: FulfillmentType;
  generatedByTeep?: boolean;
  availableCodes?: number | string;
};

type OfferInput = {
  name?: unknown;
  description?: unknown;
  offerType?: unknown;
  visibility?: unknown;
  conditionType?: unknown;
  thresholdUsd?: unknown;
  postId?: unknown;
  maxClaims?: unknown;
  onePerSupporter?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  claimWindowSeconds?: unknown;
  fulfillment?: unknown;
};

type FulfillmentInput = {
  type?: unknown;
  protectedUrl?: unknown;
  sharedCode?: unknown;
  instructions?: unknown;
  generatedByTeep?: unknown;
};

export class CreatorOfferError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

type OfferReadScope = "creator" | "supporter";

export function createOfferReadSession(address: string, scope: OfferReadScope) {
  if (!isAddress(address)) throw new CreatorOfferError(400, "INVALID_ADDRESS", "Invalid account address.");
  const expiresAt = Date.now() + OFFER_READ_SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ address: address.toLowerCase(), scope, expiresAt })).toString("base64url");
  const signature = crypto.createHmac("sha256", encryptionKey()).update(payload).digest("base64url");
  return { token: `${payload}.${signature}`, expiresAt };
}

export function verifyOfferReadSession(token: string, address: string, scope: OfferReadScope) {
  if (!token || !isAddress(address)) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = crypto.createHmac("sha256", encryptionKey()).update(payload).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { address?: string; scope?: string; expiresAt?: number };
    return decoded.address === address.toLowerCase() && decoded.scope === scope && Number(decoded.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

function normalizedEnum<T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  const normalized = String(value || "").trim().toUpperCase();
  if (!allowed.includes(normalized)) throw new CreatorOfferError(400, "INVALID_OFFER", `Choose a valid ${label}.`);
  return normalized as T[number];
}

function textField(value: unknown, label: string, max: number, required = true) {
  const clean = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (required && !clean) throw new CreatorOfferError(400, "INVALID_OFFER", `${label} is required.`);
  if (clean.length > max) throw new CreatorOfferError(400, "INVALID_OFFER", `${label} must be ${max} characters or fewer.`);
  return clean;
}

function multilineField(value: unknown, label: string, max: number) {
  const clean = String(value ?? "").replace(/\u0000/g, "").trim();
  if (clean.length > max) throw new CreatorOfferError(400, "INVALID_OFFER", `${label} must be ${max} characters or fewer.`);
  return clean;
}

function timestampField(value: unknown, label: string, fallback?: number): number | null {
  if (value === undefined || value === null || value === "") return fallback ?? null;
  const parsed = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) throw new CreatorOfferError(400, "INVALID_OFFER", `${label} is invalid.`);
  return Math.trunc(parsed);
}

function integerField(value: unknown, label: string, nullable = false): number | null {
  if ((value === undefined || value === null || value === "") && nullable) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new CreatorOfferError(400, "INVALID_OFFER", `${label} must be a positive whole number.`);
  return parsed;
}

export function amountToRaw(value: unknown): string {
  const raw = String(value ?? "").trim().replace(/^\$/, "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(raw)) {
    throw new CreatorOfferError(400, "INVALID_OFFER", "Unlock amount must be a valid USDC amount.");
  }
  const [whole, fraction = ""] = raw.split(".");
  const amount = BigInt(whole) * USDC_SCALE + BigInt(fraction.padEnd(6, "0"));
  if (amount < 10_000n) throw new CreatorOfferError(400, "INVALID_OFFER", "Unlock amount must be at least $0.01.");
  return amount.toString();
}

export function amountFromRaw(value: string) {
  const raw = BigInt(value || "0");
  const whole = raw / USDC_SCALE;
  const cents = ((raw % USDC_SCALE) / 10_000n).toString().padStart(2, "0");
  return `${whole}.${cents}`;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function fitXReplyWithUrl(prefix: string, label: string, suffix: string) {
  const available = X_REPLY_MAX_CHARACTERS - prefix.length - suffix.length;
  if (available < 1) return `${prefix}${suffix}`;
  if (label.length <= available) return `${prefix}${label}${suffix}`;
  const ellipsis = available > 1 ? "…" : "";
  let fitted = "";
  for (const character of label) {
    if (`${fitted}${character}${ellipsis}`.length > available) break;
    fitted += character;
  }
  return `${prefix}${fitted}${ellipsis}${suffix}`;
}

export function buildOfferXNotificationReply(
  offers: Array<{ offerName: string; creatorUsername: string; claimToken: string }>,
  webAppUrl = WEB_APP_URL
) {
  const baseUrl = webAppUrl.replace(/\/$/, "");
  if (offers.length !== 1) {
    const url = `${baseUrl}/dashboard/offers`;
    const prefix = `Your tip unlocked ${offers.length} creator offers.\n\nView them: `;
    if (prefix.length + url.length > X_REPLY_MAX_CHARACTERS) {
      throw new CreatorOfferError(500, "OFFER_REPLY_URL_TOO_LONG", "The configured web URL is too long for an X reply.");
    }
    return `${prefix}${url}`;
  }
  const offer = offers[0];
  const claimUrl = `${baseUrl}/offers/claim/${offer.claimToken}`;
  const prefix = "You also unlocked ";
  const suffix = ` from @${offer.creatorUsername}.\n\nClaim: ${claimUrl}`;
  if (prefix.length + suffix.length > X_REPLY_MAX_CHARACTERS) {
    const fallback = `Creator offer unlocked.\n\nClaim: ${claimUrl}`;
    if (fallback.length > X_REPLY_MAX_CHARACTERS) {
      throw new CreatorOfferError(500, "OFFER_REPLY_URL_TOO_LONG", "The configured claim URL is too long for an X reply.");
    }
    return fallback;
  }
  return fitXReplyWithUrl(prefix, offer.offerName, suffix);
}

function encryptionKey() {
  const secret = process.env.CREATOR_OFFERS_ENCRYPTION_KEY?.trim();
  if (!secret) throw new CreatorOfferError(503, "OFFER_ENCRYPTION_NOT_CONFIGURED", "Secure offer fulfillment is not configured yet.");
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

function encryptSecret(value: string | null) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptSecret(value: string | null | undefined) {
  if (!value) return null;
  const [version, ivValue, tagValue, encryptedValue] = value.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) throw new Error("Invalid encrypted offer value");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
}

export function safeDestination(value: unknown) {
  const raw = multilineField(value, "Destination URL", 2048);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CreatorOfferError(400, "INVALID_DESTINATION", "Enter a valid destination URL.");
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new CreatorOfferError(400, "INVALID_DESTINATION", "Offer destinations must use a normal HTTP or HTTPS URL.");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".local")) {
    throw new CreatorOfferError(400, "INVALID_DESTINATION", "Local or private destinations cannot be used for public offers.");
  }
  return url.toString();
}

function validateFulfillment(input: unknown) {
  const source = (input && typeof input === "object" ? input : {}) as FulfillmentInput;
  const type = normalizedEnum(source.type, FULFILLMENT_TYPES, "fulfillment type") as FulfillmentType;
  const protectedUrl = safeDestination(source.protectedUrl);
  const sharedCode = multilineField(source.sharedCode, "Shared code", 500);
  const instructions = multilineField(source.instructions, "Instructions", 4_000);
  if (type === "PROTECTED_LINK" && !protectedUrl) throw new CreatorOfferError(400, "INVALID_OFFER", "Add the private destination supporters will unlock.");
  if (type === "SHARED_CODE" && !sharedCode) throw new CreatorOfferError(400, "INVALID_OFFER", "Add the code supporters will unlock.");
  if (type === "INSTRUCTIONS" && !instructions) throw new CreatorOfferError(400, "INVALID_OFFER", "Add the instructions supporters will unlock.");
  if (type === "CUSTOM" && !protectedUrl && !sharedCode && !instructions) {
    throw new CreatorOfferError(400, "INVALID_OFFER", "Add at least one link, code, or instruction.");
  }
  return {
    type,
    protectedUrl,
    sharedCode,
    instructions,
    generatedByTeep: source.generatedByTeep === true,
  };
}

function validateOfferInput(input: OfferInput, now = Date.now(), allowMissingFulfillment = false) {
  const offerType = normalizedEnum(input.offerType, OFFER_TYPES, "offer type") as OfferType;
  const conditionType = normalizedEnum(input.conditionType, CONDITION_TYPES, "unlock condition") as ConditionType;
  const visibility = String(input.visibility || "PUBLIC").toUpperCase() === "HIDDEN" ? "HIDDEN" : "PUBLIC";
  const startsAt = timestampField(input.startsAt, "Start time", now) as number;
  const endsAt = timestampField(input.endsAt, "End time");
  if (endsAt !== null && endsAt <= startsAt) throw new CreatorOfferError(400, "INVALID_OFFER", "End time must be after the start time.");
  const amountRaw = amountToRaw(input.thresholdUsd);
  const postId = conditionType === "SPECIFIC_X_POST_MINIMUM"
    ? textField(input.postId, "X post ID", 32)
    : undefined;
  if (postId && !/^\d+$/.test(postId)) throw new CreatorOfferError(400, "INVALID_OFFER", "Enter the numeric X post ID.");
  const fulfillment = allowMissingFulfillment && input.fulfillment === undefined
    ? null
    : validateFulfillment(input.fulfillment);
  return {
    name: textField(input.name, "Offer name", 100),
    description: textField(input.description, "Short description", 280),
    offerType,
    visibility,
    conditionType,
    conditionConfig: { amountRaw, currency: "USDC" as const, ...(postId ? { postId } : {}) },
    maxClaims: integerField(input.maxClaims, "Maximum claims", true),
    onePerSupporter: input.onePerSupporter !== false,
    startsAt,
    endsAt,
    claimWindowSeconds: integerField(input.claimWindowSeconds, "Claim window", true),
    fulfillment,
  };
}

export async function getCreatorIdentity(ownerAddress: string): Promise<CreatorIdentity | null> {
  if (!isAddress(ownerAddress)) return null;
  const row = await one<{ authorId: string; ownerAddress: string; username: string }>(
    `SELECT author_id as "authorId", LOWER(owner_address) as "ownerAddress", username
     FROM verified_claims
     WHERE LOWER(owner_address) = ?
     ORDER BY verified_at DESC LIMIT 1`,
    [ownerAddress.toLowerCase()]
  );
  return row || null;
}

async function requireCreator(ownerAddress: string) {
  const identity = await getCreatorIdentity(ownerAddress);
  if (!identity) throw new CreatorOfferError(403, "CREATOR_NOT_VERIFIED", "Connect and verify your creator account first.");
  return identity;
}

async function refreshOfferStatuses() {
  const now = Date.now();
  await run(
    `UPDATE creator_offers SET status = 'ACTIVE', activated_at = COALESCE(activated_at, ?), updated_at = ?
     WHERE status = 'SCHEDULED' AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)`,
    [now, now, now, now]
  );
  await run(
    `UPDATE creator_offers SET status = 'ENDED', updated_at = ?
     WHERE status IN ('ACTIVE', 'SCHEDULED', 'PAUSED') AND ends_at IS NOT NULL AND ends_at <= ?`,
    [now, now]
  );
  await run(
    `UPDATE creator_offers SET status = 'CLAIMED_OUT', updated_at = ?
     WHERE status = 'ACTIVE' AND max_claims IS NOT NULL AND claims_reserved >= max_claims`,
    [now]
  );
}

function serializeOffer(row: OfferRow) {
  const config = parseJson<ConditionConfig>(row.conditionConfigJson, { amountRaw: "0", currency: "USDC" });
  const maxClaims = row.maxClaims == null ? null : Number(row.maxClaims);
  const reserved = Number(row.claimsReserved || 0);
  return {
    id: row.id,
    creator: {
      authorId: row.creatorAuthorId,
      ownerAddress: row.creatorOwnerAddress,
      username: row.creatorUsername,
    },
    name: row.name,
    description: row.description,
    offerType: row.offerType,
    status: row.status,
    visibility: row.visibility,
    condition: {
      type: row.conditionType,
      thresholdUsd: amountFromRaw(config.amountRaw),
      amountRaw: config.amountRaw,
      currency: config.currency,
      postId: config.postId || null,
    },
    inventory: {
      maximum: maxClaims,
      reserved,
      claimed: Number(row.claimsCompleted || 0),
      remaining: maxClaims == null ? null : Math.max(0, maxClaims - reserved),
      availableCodes: row.availableCodes == null ? null : Number(row.availableCodes),
    },
    onePerSupporter: row.onePerSupporter,
    startsAt: Number(row.startsAt),
    endsAt: row.endsAt == null ? null : Number(row.endsAt),
    claimWindowSeconds: row.claimWindowSeconds == null ? null : Number(row.claimWindowSeconds),
    fulfillmentType: row.fulfillmentType || null,
    generatedByTeep: Boolean(row.generatedByTeep),
    version: Number(row.version),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

const OFFER_SELECT = `
  SELECT o.id, o.creator_author_id as "creatorAuthorId", o.creator_owner_address as "creatorOwnerAddress",
         o.creator_username as "creatorUsername", o.name, o.description, o.offer_type as "offerType",
         o.status, o.visibility, o.condition_type as "conditionType", o.condition_config_json as "conditionConfigJson",
         o.max_claims as "maxClaims", o.claims_reserved as "claimsReserved", o.claims_completed as "claimsCompleted",
         o.one_per_supporter as "onePerSupporter", o.starts_at as "startsAt", o.ends_at as "endsAt",
         o.claim_window_seconds as "claimWindowSeconds", o.version, o.created_at as "createdAt", o.updated_at as "updatedAt",
         f.fulfillment_type as "fulfillmentType", f.generated_by_teep as "generatedByTeep",
         (SELECT COUNT(*) FROM offer_codes c WHERE c.offer_id = o.id AND c.status = 'AVAILABLE') as "availableCodes"
  FROM creator_offers o
  LEFT JOIN offer_fulfillment_configs f ON f.offer_id = o.id`;

export async function listCreatorOffers(ownerAddress: string) {
  await refreshOfferStatuses();
  const identity = await requireCreator(ownerAddress);
  const rows = await query<OfferRow>(
    `${OFFER_SELECT} WHERE o.creator_owner_address = ? ORDER BY o.created_at DESC`,
    [identity.ownerAddress]
  );
  return { creator: identity, offers: rows.map(serializeOffer) };
}

export async function listPublicOffers(username: string) {
  await refreshOfferStatuses();
  const clean = username.replace(/^@/, "").trim().toLowerCase();
  const rows = await query<OfferRow>(
    `${OFFER_SELECT}
     WHERE LOWER(o.creator_username) = ? AND o.visibility = 'PUBLIC' AND o.status = 'ACTIVE'
     ORDER BY o.starts_at, o.created_at`,
    [clean]
  );
  return rows.map((row) => {
    const offer = serializeOffer(row);
    return {
      id: offer.id,
      name: offer.name,
      description: offer.description,
      offerType: offer.offerType,
      status: offer.status,
      condition: offer.condition,
      inventory: {
        maximum: offer.inventory.maximum,
        remaining: offer.inventory.remaining,
      },
      startsAt: offer.startsAt,
      endsAt: offer.endsAt,
    };
  });
}

export async function createCreatorOffer(ownerAddress: string, rawInput: OfferInput) {
  const creator = await requireCreator(ownerAddress);
  const now = Date.now();
  const input = validateOfferInput(rawInput, now);
  if (!input.fulfillment) throw new CreatorOfferError(400, "INVALID_OFFER", "Choose how supporters receive this offer.");
  if (input.startsAt < now - 60_000) throw new CreatorOfferError(400, "INVALID_OFFER", "A new offer cannot start in the past.");
  const fulfillment = input.fulfillment;
  const id = crypto.randomUUID();
  await getDb().transaction(async (db) => {
    await db.prepare(
      `INSERT INTO creator_offers (
         id, creator_author_id, creator_owner_address, creator_username, name, description,
         offer_type, status, visibility, condition_type, condition_config_json, max_claims,
         one_per_supporter, starts_at, ends_at, claim_window_seconds, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, creator.authorId, creator.ownerAddress, creator.username.toLowerCase(), input.name, input.description,
      input.offerType, input.visibility, input.conditionType, JSON.stringify(input.conditionConfig), input.maxClaims,
      input.onePerSupporter, input.startsAt, input.endsAt, input.claimWindowSeconds, now, now
    );
    await db.prepare(
      `INSERT INTO offer_fulfillment_configs (
         offer_id, fulfillment_type, protected_url_ciphertext, shared_code_ciphertext,
         instructions_ciphertext, generated_by_teep, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      fulfillment.type,
      encryptSecret(fulfillment.protectedUrl),
      encryptSecret(fulfillment.sharedCode),
      encryptSecret(fulfillment.instructions),
      fulfillment.generatedByTeep,
      now,
      now
    );
    await db.prepare(
      `INSERT INTO offer_events (offer_id, event_type, actor_type, actor_id, metadata_json, created_at)
       VALUES (?, 'OFFER_CREATED', 'CREATOR', ?, ?, ?)`
    ).run(id, creator.ownerAddress, JSON.stringify({ version: 1 }), now);
  })();
  return getCreatorOffer(ownerAddress, id);
}

export async function getCreatorOffer(ownerAddress: string, offerId: string) {
  const identity = await requireCreator(ownerAddress);
  await refreshOfferStatuses();
  const row = await one<OfferRow>(
    `${OFFER_SELECT} WHERE o.id = ? AND o.creator_owner_address = ?`,
    [offerId, identity.ownerAddress]
  );
  if (!row) throw new CreatorOfferError(404, "OFFER_NOT_FOUND", "Offer not found.");
  const analytics = await one<{
    qualifyingSupporters: string; qualifyingTips: string; totalRaw: string; averageRaw: string;
  }>(
    `SELECT COUNT(DISTINCT e.supporter_address) as "qualifyingSupporters",
            COUNT(*) as "qualifyingTips", COALESCE(SUM(CAST(t.amount AS NUMERIC)), 0) as "totalRaw",
            COALESCE(AVG(CAST(t.amount AS NUMERIC)), 0) as "averageRaw"
     FROM offer_entitlements e JOIN tips t ON t.id = e.qualifying_tip_id WHERE e.offer_id = ?`,
    [offerId]
  );
  return {
    offer: serializeOffer(row),
    analytics: {
      qualifyingSupporters: Number(analytics?.qualifyingSupporters || 0),
      qualifyingTips: Number(analytics?.qualifyingTips || 0),
      totalQualifyingUsd: amountFromRaw(String(analytics?.totalRaw || "0").split(".")[0] || "0"),
      averageQualifyingUsd: amountFromRaw(String(analytics?.averageRaw || "0").split(".")[0] || "0"),
    },
  };
}

export async function updateCreatorOffer(ownerAddress: string, offerId: string, rawInput: OfferInput) {
  const creator = await requireCreator(ownerAddress);
  const current = await one<{ status: string; claimsReserved: number | string; maxClaims: number | null; endsAt: number | string | null }>(
    `SELECT status, claims_reserved as "claimsReserved", max_claims as "maxClaims", ends_at as "endsAt"
     FROM creator_offers WHERE id = ? AND creator_owner_address = ?`,
    [offerId, creator.ownerAddress]
  );
  if (!current) throw new CreatorOfferError(404, "OFFER_NOT_FOUND", "Offer not found.");
  if (["ARCHIVED", "ENDED", "CLAIMED_OUT"].includes(current.status)) {
    throw new CreatorOfferError(409, "OFFER_LOCKED", "Completed or archived offers cannot be changed.");
  }
  const input = validateOfferInput(rawInput, Date.now(), true);
  const reserved = Number(current.claimsReserved || 0);
  if (input.maxClaims !== null && input.maxClaims < reserved) {
    throw new CreatorOfferError(409, "INVALID_INVENTORY", "Maximum claims cannot be lower than already reserved claims.");
  }
  const termsLocked = reserved > 0 && current.status !== "DRAFT";
  if (termsLocked && current.maxClaims === null && input.maxClaims !== null) {
    throw new CreatorOfferError(409, "OFFER_TERMS_LOCKED", "An unlimited offer cannot become limited after supporters qualify.");
  }
  if (termsLocked && current.maxClaims !== null && input.maxClaims !== null && input.maxClaims < current.maxClaims) {
    throw new CreatorOfferError(409, "OFFER_TERMS_LOCKED", "You can increase availability after supporters qualify, but not reduce it.");
  }
  if (termsLocked && current.endsAt !== null && input.endsAt !== null && input.endsAt < Number(current.endsAt)) {
    throw new CreatorOfferError(409, "OFFER_TERMS_LOCKED", "You can extend the end date after supporters qualify, but not shorten it.");
  }
  if (termsLocked && input.fulfillment) {
    throw new CreatorOfferError(409, "OFFER_TERMS_LOCKED", "Private delivery details are locked after the first supporter qualifies.");
  }
  const now = Date.now();
  await getDb().transaction(async (db) => {
    if (termsLocked) {
      await db.prepare(
        `UPDATE creator_offers SET name = ?, description = ?, visibility = ?, max_claims = ?, ends_at = ?,
           version = version + 1, updated_at = ? WHERE id = ? AND creator_owner_address = ?`
      ).run(input.name, input.description, input.visibility, input.maxClaims, input.endsAt, now, offerId, creator.ownerAddress);
    } else {
      await db.prepare(
        `UPDATE creator_offers SET name = ?, description = ?, offer_type = ?, visibility = ?, condition_type = ?,
           condition_config_json = ?, max_claims = ?, one_per_supporter = ?, starts_at = ?, ends_at = ?,
           claim_window_seconds = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND creator_owner_address = ?`
      ).run(
        input.name, input.description, input.offerType, input.visibility, input.conditionType,
        JSON.stringify(input.conditionConfig), input.maxClaims, input.onePerSupporter, input.startsAt,
        input.endsAt, input.claimWindowSeconds, now, offerId, creator.ownerAddress
      );
    }
    if (input.fulfillment) {
      await db.prepare(
        `UPDATE offer_fulfillment_configs SET fulfillment_type = ?, protected_url_ciphertext = ?,
           shared_code_ciphertext = ?, instructions_ciphertext = ?, generated_by_teep = ?,
           version = version + 1, updated_at = ? WHERE offer_id = ?`
      ).run(
        input.fulfillment.type, encryptSecret(input.fulfillment.protectedUrl), encryptSecret(input.fulfillment.sharedCode),
        encryptSecret(input.fulfillment.instructions), input.fulfillment.generatedByTeep, now, offerId
      );
    }
    await db.prepare(
      `INSERT INTO offer_events (offer_id, event_type, actor_type, actor_id, metadata_json, created_at)
       VALUES (?, 'OFFER_UPDATED', 'CREATOR', ?, NULL, ?)`
    ).run(offerId, creator.ownerAddress, now);
  })();
  return getCreatorOffer(ownerAddress, offerId);
}

export async function changeOfferStatus(ownerAddress: string, offerId: string, action: "activate" | "pause" | "archive") {
  const creator = await requireCreator(ownerAddress);
  const now = Date.now();
  await getDb().transaction(async (db) => {
    const row = await db.prepare(
      `SELECT o.status, o.starts_at as "startsAt", o.ends_at as "endsAt", f.fulfillment_type as "fulfillmentType",
              (SELECT COUNT(*) FROM offer_codes c WHERE c.offer_id = o.id AND c.status = 'AVAILABLE') as "availableCodes"
       FROM creator_offers o JOIN offer_fulfillment_configs f ON f.offer_id = o.id
       WHERE o.id = ? AND o.creator_owner_address = ? FOR UPDATE`
    ).get<{ status: string; startsAt: number | string; endsAt: number | string | null; fulfillmentType: string; availableCodes: string }>(offerId, creator.ownerAddress);
    if (!row) throw new CreatorOfferError(404, "OFFER_NOT_FOUND", "Offer not found.");
    let status: string;
    if (action === "activate") {
      if (!["DRAFT", "PAUSED", "SCHEDULED"].includes(row.status)) throw new CreatorOfferError(409, "INVALID_STATUS", "This offer cannot be activated.");
      if (row.endsAt !== null && Number(row.endsAt) <= now) throw new CreatorOfferError(409, "OFFER_ENDED", "Choose a future end time before activating.");
      if (row.fulfillmentType === "UNIQUE_CODE" && Number(row.availableCodes || 0) === 0) {
        throw new CreatorOfferError(409, "NO_CODE_INVENTORY", "Add at least one unique code before activating this offer.");
      }
      status = Number(row.startsAt) > now ? "SCHEDULED" : "ACTIVE";
    } else if (action === "pause") {
      if (!["ACTIVE", "SCHEDULED"].includes(row.status)) throw new CreatorOfferError(409, "INVALID_STATUS", "Only an active or scheduled offer can be paused.");
      status = "PAUSED";
    } else {
      status = "ARCHIVED";
    }
    await db.prepare(
      `UPDATE creator_offers SET status = ?, activated_at = CASE WHEN ? = 'ACTIVE' THEN COALESCE(activated_at, ?) ELSE activated_at END,
         archived_at = CASE WHEN ? = 'ARCHIVED' THEN ? ELSE archived_at END, updated_at = ?
       WHERE id = ? AND creator_owner_address = ?`
    ).run(status, status, now, status, now, now, offerId, creator.ownerAddress);
    await db.prepare(
      `INSERT INTO offer_events (offer_id, event_type, actor_type, actor_id, metadata_json, created_at)
       VALUES (?, ?, 'CREATOR', ?, NULL, ?)`
    ).run(offerId, `OFFER_${status}`, creator.ownerAddress, now);
  })();
  await publishDashboardUpdate({ reason: "creator_offer_updated", addresses: [creator.ownerAddress], authorIds: [creator.authorId] }).catch(() => undefined);
  return getCreatorOffer(ownerAddress, offerId);
}

function normalizeCodes(values: unknown) {
  const rawValues = Array.isArray(values) ? values : String(values ?? "").split(/[\r\n,]+/);
  const unique = new Map<string, string>();
  for (const value of rawValues) {
    const code = multilineField(value, "Code", 500);
    if (!code) continue;
    const hash = crypto.createHash("sha256").update(code, "utf8").digest("hex");
    if (!unique.has(hash)) unique.set(hash, code);
  }
  if (!unique.size) throw new CreatorOfferError(400, "NO_CODES", "Add at least one code.");
  if (unique.size > OFFER_MAX_CODES_PER_IMPORT) throw new CreatorOfferError(413, "TOO_MANY_CODES", `Add at most ${OFFER_MAX_CODES_PER_IMPORT} codes at once.`);
  return unique;
}

export async function addOfferCodes(ownerAddress: string, offerId: string, values: unknown) {
  const creator = await requireCreator(ownerAddress);
  const offer = await one<{ id: string; fulfillmentType: string }>(
    `SELECT o.id, f.fulfillment_type as "fulfillmentType" FROM creator_offers o
     JOIN offer_fulfillment_configs f ON f.offer_id = o.id
     WHERE o.id = ? AND o.creator_owner_address = ?`,
    [offerId, creator.ownerAddress]
  );
  if (!offer) throw new CreatorOfferError(404, "OFFER_NOT_FOUND", "Offer not found.");
  if (offer.fulfillmentType !== "UNIQUE_CODE") throw new CreatorOfferError(409, "WRONG_FULFILLMENT", "This offer does not use unique codes.");
  const codes = normalizeCodes(values);
  const now = Date.now();
  let added = 0;
  await getDb().transaction(async (db) => {
    for (const [hash, code] of codes) {
      const result = await db.prepare(
        `INSERT INTO offer_codes (id, offer_id, code_ciphertext, code_hash, status, created_at)
         VALUES (?, ?, ?, ?, 'AVAILABLE', ?)
         ON CONFLICT(offer_id, code_hash) DO NOTHING`
      ).run(crypto.randomUUID(), offerId, encryptSecret(code), hash, now);
      added += result.changes;
    }
    await db.prepare(
      `INSERT INTO offer_events (offer_id, event_type, actor_type, actor_id, metadata_json, created_at)
       VALUES (?, 'CODE_IMPORTED', 'CREATOR', ?, ?, ?)`
    ).run(offerId, creator.ownerAddress, JSON.stringify({ added, submitted: codes.size }), now);
  })();
  return { added, duplicates: codes.size - added };
}

export async function generateOfferCodes(ownerAddress: string, offerId: string, countValue: unknown) {
  const count = integerField(countValue, "Number of codes") as number;
  if (count > OFFER_MAX_CODES_PER_IMPORT) {
    throw new CreatorOfferError(413, "TOO_MANY_CODES", `Generate at most ${OFFER_MAX_CODES_PER_IMPORT} codes at once.`);
  }
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const codes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = crypto.randomBytes(8);
    let value = "";
    for (const byte of bytes) value += alphabet[byte % alphabet.length];
    codes.push(`TEEP-${value.slice(0, 4)}-${value.slice(4)}`);
  }
  return addOfferCodes(ownerAddress, offerId, codes);
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function exportOfferCodes(ownerAddress: string, offerId: string) {
  const creator = await requireCreator(ownerAddress);
  const offer = await one<{ name: string }>(
    "SELECT name FROM creator_offers WHERE id = ? AND creator_owner_address = ?",
    [offerId, creator.ownerAddress]
  );
  if (!offer) throw new CreatorOfferError(404, "OFFER_NOT_FOUND", "Offer not found.");
  const rows = await query<{ codeCiphertext: string; status: string; reservedAt: number | string | null; claimedAt: number | string | null }>(
    `SELECT code_ciphertext as "codeCiphertext", status, reserved_at as "reservedAt", claimed_at as "claimedAt"
     FROM offer_codes WHERE offer_id = ? ORDER BY created_at, id`,
    [offerId]
  );
  const lines = ["code,status,reserved_at,claimed_at"];
  for (const row of rows) {
    lines.push([
      csvCell(decryptSecret(row.codeCiphertext) || ""),
      csvCell(row.status),
      csvCell(row.reservedAt == null ? "" : new Date(Number(row.reservedAt)).toISOString()),
      csvCell(row.claimedAt == null ? "" : new Date(Number(row.claimedAt)).toISOString()),
    ].join(","));
  }
  const filename = `${offer.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "teep-offer"}-codes.csv`;
  return { filename, csv: `${lines.join("\r\n")}\r\n` };
}

async function claimEvaluationJob() {
  const now = Date.now();
  return one<{ tipId: string }>(
    `WITH candidate AS (
       SELECT tip_id FROM offer_tip_evaluations
       WHERE ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
          OR (status = 'processing' AND updated_at < ?))
       ORDER BY tip_id FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE offer_tip_evaluations e
     SET status = 'processing', attempts = attempts + 1, updated_at = ?
     FROM candidate c WHERE e.tip_id = c.tip_id
     RETURNING e.tip_id as "tipId"`,
    [now, now - OFFER_EVALUATION_STALE_MS, now]
  );
}

async function reserveEntitlement(offerId: string, tip: {
  id: string; authorId: string; fromAddress: string; amount: string; timestamp: number | string;
}) {
  const claimToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(claimToken).digest("hex");
  const entitlementId = crypto.randomUUID();
  const now = Date.now();
  return getDb().transaction(async (db) => {
    const offer = await db.prepare(
      `SELECT o.*, f.fulfillment_type FROM creator_offers o
       JOIN offer_fulfillment_configs f ON f.offer_id = o.id
       WHERE o.id = ? FOR UPDATE`
    ).get<any>(offerId);
    if (!offer || offer.status !== "ACTIVE") return null;
    if (offer.max_claims !== null && Number(offer.claims_reserved) >= Number(offer.max_claims)) {
      await db.prepare("UPDATE creator_offers SET status = 'CLAIMED_OUT', updated_at = ? WHERE id = ?").run(now, offerId);
      return null;
    }
    const qualificationKey = offer.one_per_supporter
      ? `${offerId}:supporter:${tip.fromAddress.toLowerCase()}`
      : `${offerId}:tip:${tip.id}`;
    let codeId: string | null = null;
    if (offer.fulfillment_type === "UNIQUE_CODE") {
      const code = await db.prepare(
        `SELECT id FROM offer_codes WHERE offer_id = ? AND status = 'AVAILABLE'
         ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1`
      ).get<{ id: string }>(offerId);
      if (!code) {
        await db.prepare("UPDATE creator_offers SET status = 'CLAIMED_OUT', updated_at = ? WHERE id = ?").run(now, offerId);
        return null;
      }
      codeId = code.id;
    }
    const condition = parseJson<ConditionConfig>(offer.condition_config_json, { amountRaw: "0", currency: "USDC" });
    const expiresAt = offer.claim_window_seconds == null ? null : now + Number(offer.claim_window_seconds) * 1000;
    const snapshot = JSON.stringify({
      name: offer.name,
      description: offer.description,
      offerType: offer.offer_type,
      fulfillmentType: offer.fulfillment_type,
      conditionType: offer.condition_type,
      thresholdUsd: amountFromRaw(condition.amountRaw),
      creatorUsername: offer.creator_username,
      version: Number(offer.version),
    });
    const inserted = await db.prepare(
      `INSERT INTO offer_entitlements (
         id, offer_id, creator_author_id, supporter_address, qualifying_tip_id, qualification_key,
         status, offer_version, offer_snapshot_json, claim_token_hash, claim_token_ciphertext, qualified_at, reserved_at,
         expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'RESERVED_UNCLAIMED', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(qualification_key) DO NOTHING RETURNING id`
    ).get<{ id: string }>(
      entitlementId, offerId, tip.authorId, tip.fromAddress.toLowerCase(), tip.id, qualificationKey,
      Number(offer.version), snapshot, tokenHash, encryptSecret(claimToken), now, now, expiresAt, now, now
    );
    if (!inserted) return null;
    if (codeId) {
      await db.prepare(
        `UPDATE offer_codes SET status = 'RESERVED', reserved_entitlement_id = ?, reserved_at = ?
         WHERE id = ? AND status = 'AVAILABLE'`
      ).run(entitlementId, now, codeId);
    }
    await db.prepare(
      `UPDATE creator_offers SET claims_reserved = claims_reserved + 1,
         status = CASE WHEN max_claims IS NOT NULL AND claims_reserved + 1 >= max_claims THEN 'CLAIMED_OUT' ELSE status END,
         updated_at = ? WHERE id = ?`
    ).run(now, offerId);
    await db.prepare(
      `INSERT INTO offer_events (offer_id, event_type, actor_type, actor_id, metadata_json, created_at)
       VALUES (?, 'ENTITLEMENT_RESERVED', 'SUPPORTER', ?, ?, ?)`
    ).run(offerId, tip.fromAddress.toLowerCase(), JSON.stringify({ entitlementId, qualifyingTipId: tip.id }), now);
    return {
      entitlementId,
      claimToken,
      offerName: offer.name as string,
      creatorUsername: offer.creator_username as string,
      creatorOwnerAddress: offer.creator_owner_address as string,
      supporterAddress: tip.fromAddress.toLowerCase(),
    };
  })();
}

async function evaluateTip(tipId: string) {
  const tip = await one<{
    id: string; contentId: string; authorId: string; fromAddress: string; amount: string; txHash: string; timestamp: number | string;
  }>(
    `SELECT id::text, content_id as "contentId", author_id as "authorId", LOWER(from_address) as "fromAddress",
            amount, LOWER(tx_hash) as "txHash", timestamp FROM tips WHERE id = ?`,
    [tipId]
  );
  if (!tip) return;
  await refreshOfferStatuses();
  const tipAt = Number(tip.timestamp) < 10_000_000_000 ? Number(tip.timestamp) * 1000 : Number(tip.timestamp);
  const offers = await query<OfferRow>(
    `${OFFER_SELECT}
     WHERE o.creator_author_id = ? AND o.status = 'ACTIVE' AND o.starts_at <= ?
       AND (o.ends_at IS NULL OR o.ends_at > ?)
     ORDER BY o.created_at`,
    [tip.authorId, tipAt, tipAt]
  );
  if (!offers.length) return;
  const metadata = await one<{ tweetId: string | null }>(
    `SELECT tweet_id as "tweetId" FROM tip_metadata WHERE content_id = ? LIMIT 1`,
    [tip.contentId]
  );
  let cumulativeRaw: bigint | null = null;
  const created: Array<NonNullable<Awaited<ReturnType<typeof reserveEntitlement>>>> = [];
  for (const offer of offers) {
    const condition = parseJson<ConditionConfig>(offer.conditionConfigJson, { amountRaw: "0", currency: "USDC" });
    const threshold = BigInt(condition.amountRaw);
    let qualifies = false;
    if (offer.conditionType === "SINGLE_TIP_MINIMUM") qualifies = BigInt(tip.amount) >= threshold;
    if (offer.conditionType === "SPECIFIC_X_POST_MINIMUM") {
      qualifies = BigInt(tip.amount) >= threshold && Boolean(condition.postId && metadata?.tweetId === condition.postId);
    }
    if (offer.conditionType === "CUMULATIVE_TIPS_MINIMUM") {
      if (cumulativeRaw === null) {
        const total = await one<{ total: string }>(
          `SELECT COALESCE(SUM(CAST(amount AS NUMERIC)), 0) as total FROM tips
           WHERE author_id = ? AND LOWER(from_address) = ? AND timestamp <= ?`,
          [tip.authorId, tip.fromAddress, tip.timestamp]
        );
        cumulativeRaw = BigInt(String(total?.total || "0").split(".")[0] || "0");
      }
      qualifies = cumulativeRaw >= threshold;
    }
    if (!qualifies) continue;
    const entitlement = await reserveEntitlement(offer.id, tip);
    if (entitlement) created.push(entitlement);
  }

  for (const entitlement of created) {
    await createNotification({
      userAddress: entitlement.supporterAddress,
      type: "offer_unlocked",
      title: "You unlocked a creator offer",
      body: `${entitlement.offerName} from @${entitlement.creatorUsername} is ready to claim.`,
      metadata: {
        messageKey: `offer:${entitlement.entitlementId}`,
        entitlementId: entitlement.entitlementId,
        creatorUsername: entitlement.creatorUsername,
        claimUrl: `${WEB_APP_URL}/offers/claim/${entitlement.claimToken}`,
      },
    });
    await publishDashboardUpdate({
      reason: "creator_offer_unlocked",
      addresses: [entitlement.supporterAddress, entitlement.creatorOwnerAddress],
      authorIds: [tip.authorId],
    }).catch(() => undefined);
  }

  if (created.length) {
    const xTip = await one<{ sourceTweetId: string }>(
      `SELECT source_tweet_id as "sourceTweetId" FROM x_bot_tips
       WHERE LOWER(tx_hash) = ? AND status = 'completed' LIMIT 1`,
      [tip.txHash]
    );
    if (xTip?.sourceTweetId && /^\d+$/.test(xTip.sourceTweetId)) {
      const replyText = buildOfferXNotificationReply(created);
      const now = Date.now();
      await run(
        `INSERT INTO offer_x_notifications (id, source_tweet_id, reply_text, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?) ON CONFLICT(source_tweet_id) DO NOTHING`,
        [crypto.randomUUID(), xTip.sourceTweetId, replyText, now, now]
      );
    }
  }
}

async function completeEvaluation(tipId: string, error?: unknown) {
  const now = Date.now();
  if (!error) {
    await run(
      `UPDATE offer_tip_evaluations SET status = 'completed', last_error = NULL, updated_at = ? WHERE tip_id = ?`,
      [now, tipId]
    );
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  const row = await one<{ attempts: number | string }>("SELECT attempts FROM offer_tip_evaluations WHERE tip_id = ?", [tipId]);
  const attempts = Number(row?.attempts || 1);
  const delay = Math.min(60 * 60_000, 2 ** Math.min(attempts, 10) * 1_000);
  await run(
    `UPDATE offer_tip_evaluations SET status = 'failed', last_error = ?, next_attempt_at = ?, updated_at = ? WHERE tip_id = ?`,
    [message.slice(0, 1000), now + delay, now, tipId]
  );
}

export async function enqueueOfferEvaluation(tipId: string | number, db = getDb()) {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO offer_tip_evaluations (tip_id, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, 'pending', 0, 0, ?, ?) ON CONFLICT(tip_id) DO NOTHING`
  ).run(String(tipId), now, now);
}

export async function requeueOfferEvaluationsForContent(contentId: string) {
  const now = Date.now();
  await run(
    `UPDATE offer_tip_evaluations e SET status = 'pending', next_attempt_at = 0, last_error = NULL, updated_at = ?
     FROM tips t WHERE e.tip_id = t.id AND LOWER(t.content_id) = LOWER(?)`,
    [now, contentId]
  );
}

async function reconcileMissingEvaluations() {
  const now = Date.now();
  await run(
    `INSERT INTO offer_tip_evaluations (tip_id, status, attempts, next_attempt_at, created_at, updated_at)
     SELECT t.id, 'pending', 0, 0, ?, ? FROM tips t
     LEFT JOIN offer_tip_evaluations e ON e.tip_id = t.id WHERE e.tip_id IS NULL
     ON CONFLICT(tip_id) DO NOTHING`,
    [now, now]
  );
}

export class CreatorOfferWorker {
  private running = false;
  private lastReconcileAt = 0;

  start() {
    this.running = true;
    void this.loop();
    console.log(`[Creator offers] Evaluator running every ${OFFER_WORKER_INTERVAL_MS}ms`);
  }

  stop() {
    this.running = false;
  }

  private async loop() {
    while (this.running) {
      try {
        if (Date.now() - this.lastReconcileAt > 60_000) {
          await reconcileMissingEvaluations();
          this.lastReconcileAt = Date.now();
        }
        const job = await claimEvaluationJob();
        if (job) {
          try {
            await evaluateTip(job.tipId);
            await completeEvaluation(job.tipId);
          } catch (error) {
            await completeEvaluation(job.tipId, error);
            console.error(`[Creator offers] Tip ${job.tipId} evaluation failed:`, error);
          }
          continue;
        }
      } catch (error) {
        console.error("[Creator offers] Worker loop failed:", error);
      }
      await new Promise((resolve) => setTimeout(resolve, OFFER_WORKER_INTERVAL_MS));
    }
  }
}

export async function claimPendingOfferXNotification() {
  const now = Date.now();
  return one<{ id: string; sourceTweetId: string; replyText: string }>(
    `WITH candidate AS (
       SELECT id FROM offer_x_notifications
       WHERE ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
          OR (status = 'sending' AND lease_until < ?))
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE offer_x_notifications n
     SET status = 'sending', attempts = attempts + 1, lease_until = ?, updated_at = ?
     FROM candidate c WHERE n.id = c.id
     RETURNING n.id, n.source_tweet_id as "sourceTweetId", n.reply_text as "replyText"`,
    [now, now, now + 60_000, now]
  );
}

export async function recordOfferXNotificationResult(params: { id: string; replyTweetId?: string; error?: string }) {
  const now = Date.now();
  if (params.replyTweetId) {
    await run(
      `UPDATE offer_x_notifications SET status = 'delivered', reply_tweet_id = ?, last_error = NULL,
         lease_until = NULL, updated_at = ? WHERE id = ?`,
      [params.replyTweetId, now, params.id]
    );
    return;
  }
  const row = await one<{ attempts: number | string }>("SELECT attempts FROM offer_x_notifications WHERE id = ?", [params.id]);
  const attempts = Number(row?.attempts || 1);
  const delay = Math.min(60 * 60_000, 2 ** Math.min(attempts, 10) * 1_000);
  await run(
    `UPDATE offer_x_notifications SET status = 'failed', last_error = ?, next_attempt_at = ?,
       lease_until = NULL, updated_at = ? WHERE id = ?`,
    [(params.error || "Unknown X reply failure").slice(0, 1000), now + delay, now, params.id]
  );
}

export async function listSupporterEntitlements(supporterAddress: string, includeClaimUrls = false) {
  if (!isAddress(supporterAddress)) throw new CreatorOfferError(400, "INVALID_ADDRESS", "Invalid supporter address.");
  const now = Date.now();
  await run(
    `UPDATE offer_entitlements SET status = 'EXPIRED', updated_at = ?
     WHERE supporter_address = ? AND status = 'RESERVED_UNCLAIMED' AND expires_at IS NOT NULL AND expires_at <= ?`,
    [now, supporterAddress.toLowerCase(), now]
  );
  const rows = await query<any>(
    `SELECT e.id, e.status, e.offer_snapshot_json as "offerSnapshotJson",
            e.claim_token_ciphertext as "claimTokenCiphertext", e.qualified_at as "qualifiedAt",
            e.expires_at as "expiresAt", e.claimed_at as "claimedAt", o.creator_username as "creatorUsername"
     FROM offer_entitlements e JOIN creator_offers o ON o.id = e.offer_id
     WHERE e.supporter_address = ? ORDER BY e.qualified_at DESC`,
    [supporterAddress.toLowerCase()]
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    offer: parseJson(row.offerSnapshotJson, {}),
    creatorUsername: row.creatorUsername,
    claimUrl: includeClaimUrls && ["RESERVED_UNCLAIMED", "CLAIMED"].includes(row.status) && row.claimTokenCiphertext
      ? `${WEB_APP_URL}/offers/claim/${decryptSecret(row.claimTokenCiphertext)}`
      : null,
    qualifiedAt: Number(row.qualifiedAt),
    expiresAt: row.expiresAt == null ? null : Number(row.expiresAt),
    claimedAt: row.claimedAt == null ? null : Number(row.claimedAt),
  }));
}

export async function getClaimPreview(token: string) {
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const row = await one<any>(
    `SELECT e.status, e.offer_snapshot_json as "offerSnapshotJson", e.expires_at as "expiresAt",
            o.creator_username as "creatorUsername"
     FROM offer_entitlements e JOIN creator_offers o ON o.id = e.offer_id
     WHERE e.claim_token_hash = ?`,
    [hash]
  );
  if (!row) throw new CreatorOfferError(404, "CLAIM_NOT_FOUND", "This claim link is invalid or unavailable.");
  return {
    status: row.status,
    offer: parseJson(row.offerSnapshotJson, {}),
    creatorUsername: row.creatorUsername,
    expiresAt: row.expiresAt == null ? null : Number(row.expiresAt),
  };
}

export async function claimOffer(token: string, supporterAddress: string) {
  if (!isAddress(supporterAddress)) throw new CreatorOfferError(400, "INVALID_ADDRESS", "Invalid supporter address.");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  const result = await getDb().transaction(async (db) => {
    const row = await db.prepare(
      `SELECT e.*, f.fulfillment_type, f.protected_url_ciphertext, f.shared_code_ciphertext,
              f.instructions_ciphertext, c.id as code_id, c.code_ciphertext
       FROM offer_entitlements e
       JOIN offer_fulfillment_configs f ON f.offer_id = e.offer_id
       LEFT JOIN offer_codes c ON c.reserved_entitlement_id = e.id
       WHERE e.claim_token_hash = ? FOR UPDATE OF e`
    ).get<any>(hash);
    if (!row) throw new CreatorOfferError(404, "CLAIM_NOT_FOUND", "This claim link is invalid or unavailable.");
    if (row.supporter_address.toLowerCase() !== supporterAddress.toLowerCase()) {
      throw new CreatorOfferError(403, "CLAIM_FORBIDDEN", "This offer belongs to a different Teep account.");
    }
    const fulfillment = {
      type: row.fulfillment_type as FulfillmentType,
      protectedUrl: decryptSecret(row.protected_url_ciphertext),
      sharedCode: decryptSecret(row.shared_code_ciphertext),
      uniqueCode: decryptSecret(row.code_ciphertext),
      instructions: decryptSecret(row.instructions_ciphertext),
    };
    if (row.status === "CLAIMED") {
      return {
        claimId: null,
        entitlementId: row.id as string,
        fulfillment,
        claimedAt: Number(row.claimed_at || now),
        supporterAddress: supporterAddress.toLowerCase(),
        alreadyClaimed: true,
      };
    }
    if (row.status !== "RESERVED_UNCLAIMED") throw new CreatorOfferError(409, "CLAIM_UNAVAILABLE", "This offer is no longer claimable.");
    if (row.expires_at !== null && Number(row.expires_at) <= now) {
      await db.prepare("UPDATE offer_entitlements SET status = 'EXPIRED', updated_at = ? WHERE id = ?").run(now, row.id);
      throw new CreatorOfferError(410, "CLAIM_EXPIRED", "This claim window has ended.");
    }
    const claimId = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO offer_claims (id, entitlement_id, offer_id, supporter_address, fulfillment_type, assigned_code_id, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(claimId, row.id, row.offer_id, supporterAddress.toLowerCase(), row.fulfillment_type, row.code_id || null, now);
    await db.prepare("UPDATE offer_entitlements SET status = 'CLAIMED', claimed_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, row.id);
    if (row.code_id) {
      await db.prepare("UPDATE offer_codes SET status = 'CLAIMED', claimed_at = ? WHERE id = ?").run(now, row.code_id);
    }
    await db.prepare("UPDATE creator_offers SET claims_completed = claims_completed + 1, updated_at = ? WHERE id = ?")
      .run(now, row.offer_id);
    await db.prepare(
      `INSERT INTO offer_events (offer_id, event_type, actor_type, actor_id, metadata_json, created_at)
       VALUES (?, 'CLAIM_COMPLETED', 'SUPPORTER', ?, ?, ?)`
    ).run(row.offer_id, supporterAddress.toLowerCase(), JSON.stringify({ entitlementId: row.id, claimId }), now);
    return {
      claimId,
      entitlementId: row.id as string,
      fulfillment,
      claimedAt: now,
      supporterAddress: supporterAddress.toLowerCase(),
      alreadyClaimed: false,
    };
  })();
  await publishDashboardUpdate({ reason: "creator_offer_claimed", addresses: [result.supporterAddress] }).catch(() => undefined);
  return result;
}

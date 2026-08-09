import crypto from "crypto";
import { isAddress, isUnsignedIntegerString } from "../utils/security";

type CrossmintKind = "onramp" | "offramp";

export type CrossmintSessionStatus =
  | "created"
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type VerifiedCrossmintWebhook = {
  eventId: string;
  timestamp: number;
};

export type CrossmintWebhookEvent = {
  eventId: string;
  eventType: string;
  sessionId: string | null;
  providerOrderId: string | null;
  providerStatus: string | null;
  status: CrossmintSessionStatus;
  payload: Record<string, unknown>;
};

type CrossmintConfig = {
  environment: "staging" | "production";
  apiBaseUrl: string;
  apiKey: string;
  apiKeyHeader: string;
  onrampPath: string;
  offrampPath: string;
  orderStatusPathTemplate: string;
  chain: string;
  asset: string;
  fiatCurrency: string;
  successCallbackUrl: string | null;
  failureCallbackUrl: string | null;
  requestTimeoutMs: number;
};

export type CrossmintOrderResult = {
  providerOrderId: string | null;
  redirectUrl: string | null;
  clientSecret: string | null;
  depositAddress: string | null;
  status: string | null;
  raw: unknown;
};

export class CrossmintConfigError extends Error {
  statusCode = 503;
  code = "CROSSMINT_NOT_CONFIGURED";
}

export class CrossmintProviderError extends Error {
  statusCode: number;
  code = "CROSSMINT_PROVIDER_ERROR";
  details?: unknown;

  constructor(message: string, statusCode: number, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanEnv(value?: string): string {
  return (value || "").trim();
}

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function safeCrossmintUrl(value: string | null, config: CrossmintConfig): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const apiHost = new URL(config.apiBaseUrl).hostname.toLowerCase();
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== apiHost && !host.endsWith(".crossmint.com") && host !== "crossmint.com")) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function boolEnv(key: string): boolean {
  return process.env[key] === "true";
}

function configuredCallbackUrl(key: "CROSSMINT_SUCCESS_CALLBACK_URL" | "CROSSMINT_FAILURE_CALLBACK_URL"): string | null {
  const value = cleanEnv(process.env[key]);
  if (!value) return null;
  const webAppUrl = cleanEnv(process.env.WEB_APP_URL);
  if (!webAppUrl) throw new CrossmintConfigError(`${key} requires WEB_APP_URL.`);
  try {
    const callback = new URL(value);
    const webApp = new URL(webAppUrl);
    const localDevelopment = process.env.NODE_ENV !== "production" && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(callback.hostname);
    if ((callback.protocol !== "https:" && !(localDevelopment && callback.protocol === "http:")) || callback.origin !== webApp.origin) {
      throw new Error("origin mismatch");
    }
    return callback.toString();
  } catch {
    throw new CrossmintConfigError(`${key} must be a valid URL on the configured WEB_APP_URL origin.`);
  }
}

function addCheckoutCallbacks(payload: Record<string, unknown>, config: CrossmintConfig): Record<string, unknown> {
  return {
    ...payload,
    ...(config.successCallbackUrl ? { successCallbackURL: config.successCallbackUrl } : {}),
    ...(config.failureCallbackUrl ? { failureCallbackURL: config.failureCallbackUrl } : {}),
  };
}

export function isCrossmintEnabled(kind: CrossmintKind): boolean {
  if (kind === "onramp") return boolEnv("CROSSMINT_ENABLE_ONRAMP");
  return boolEnv("CROSSMINT_ENABLE_OFFRAMP");
}

export function getCrossmintPublicStatus() {
  const environment = cleanEnv(process.env.CROSSMINT_ENV || "staging");
  const successCallbackUrl = cleanEnv(process.env.CROSSMINT_SUCCESS_CALLBACK_URL);
  const failureCallbackUrl = cleanEnv(process.env.CROSSMINT_FAILURE_CALLBACK_URL);
  return {
    environment,
    onrampEnabled: isCrossmintEnabled("onramp"),
    offrampEnabled: isCrossmintEnabled("offramp"),
    productionAllowed: boolEnv("CROSSMINT_ALLOW_PRODUCTION"),
    webhookConfigured: cleanEnv(process.env.CROSSMINT_WEBHOOK_SIGNING_SECRET).startsWith("whsec_"),
    callbacksConfigured: Boolean(successCallbackUrl && failureCallbackUrl),
    statusReconciliationConfigured: Boolean(
      boolEnv("CROSSMINT_ENABLE_RECONCILIATION") &&
      (cleanEnv(process.env.CROSSMINT_ORDER_STATUS_PATH_TEMPLATE) ||
        cleanEnv(process.env.CROSSMINT_ONRAMP_ORDER_STATUS_PATH_TEMPLATE) ||
        cleanEnv(process.env.CROSSMINT_OFFRAMP_ORDER_STATUS_PATH_TEMPLATE))
    ),
  };
}

export function normalizeCrossmintStatus(value: unknown, eventType = ""): CrossmintSessionStatus {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  const type = eventType.trim().toLowerCase();
  const text = `${status} ${type}`;
  if (/(cancelled|canceled)/.test(text)) return "cancelled";
  if (/expired/.test(text)) return "expired";
  if (/(failed|failure|declined|rejected|error)/.test(text)) return "failed";
  if (/payment\.succeeded/.test(type) || /delivery\.initiated/.test(type)) return "processing";
  if (/(delivery|payout)\.(completed|succeeded)/.test(type) || /^(fulfilled|complete|completed|success|succeeded)$/.test(status)) {
    return "completed";
  }
  if (/(processing|in[_ -]?progress|delivery\.initiated|payment\.succeeded|submitted|confirming|pending)/.test(text)) {
    return "processing";
  }
  return "pending";
}

export function verifyCrossmintWebhook(rawBody: Buffer, headers: {
  id?: string;
  timestamp?: string;
  signature?: string;
}, nowSeconds = Math.floor(Date.now() / 1000)): VerifiedCrossmintWebhook {
  const secret = cleanEnv(process.env.CROSSMINT_WEBHOOK_SIGNING_SECRET);
  if (!secret) throw new CrossmintConfigError("CROSSMINT_WEBHOOK_SIGNING_SECRET is required.");
  if (!secret.startsWith("whsec_")) throw new CrossmintConfigError("Crossmint webhook signing secret must start with whsec_.");

  const eventId = cleanEnv(headers.id);
  const timestampText = cleanEnv(headers.timestamp);
  const signatureHeader = cleanEnv(headers.signature);
  const timestamp = Number(timestampText);
  const tolerance = Number(process.env.CROSSMINT_WEBHOOK_TOLERANCE_SECONDS || "300");
  if (!eventId || !/^\d+$/.test(timestampText) || !signatureHeader) {
    throw new CrossmintProviderError("Missing Crossmint webhook signature headers.", 400);
  }
  const allowedSkew = Number.isFinite(tolerance) && tolerance >= 30 ? tolerance : 300;
  if (Math.abs(nowSeconds - timestamp) > allowedSkew) {
    throw new CrossmintProviderError("Crossmint webhook timestamp is outside the allowed window.", 400);
  }

  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  if (!key.length) throw new CrossmintConfigError("Crossmint webhook signing secret is invalid.");
  const signedContent = `${eventId}.${timestampText}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", key).update(signedContent).digest();
  const matches = signatureHeader.split(/\s+/).some((entry) => {
    const [version, encoded] = entry.split(",", 2);
    if (version !== "v1" || !encoded) return false;
    try {
      const actual = Buffer.from(encoded, "base64");
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  });
  if (!matches) throw new CrossmintProviderError("Invalid Crossmint webhook signature.", 400);
  return { eventId, timestamp };
}

export function parseCrossmintWebhook(payload: unknown, verified: VerifiedCrossmintWebhook): CrossmintWebhookEvent {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CrossmintProviderError("Crossmint webhook payload must be a JSON object.", 400);
  }
  const body = payload as Record<string, unknown>;
  const eventType = firstString(body, ["type", "eventType", "event.type"]) || "unknown";
  const providerOrderId = firstString(body, [
    "orderId", "order.id", "order.orderId", "data.orderId", "data.order.id", "data.order.orderId", "data.id", "resource.id",
  ]);
  const sessionId = firstString(body, [
    "sessionId", "metadata.sessionId", "order.metadata.sessionId", "data.sessionId", "data.metadata.sessionId", "data.order.metadata.sessionId",
  ]);
  const providerStatus = firstString(body, [
    "status", "order.status", "data.status", "data.order.status", "payment.status", "data.payment.status", "data.order.payment.status", "payout.status", "data.payout.status",
  ]);
  return {
    eventId: verified.eventId,
    eventType,
    sessionId,
    providerOrderId,
    providerStatus,
    status: normalizeCrossmintStatus(providerStatus, eventType),
    payload: body,
  };
}

function getCrossmintConfig(kind: CrossmintKind): CrossmintConfig {
  if (!isCrossmintEnabled(kind)) {
    throw new CrossmintConfigError(`Crossmint ${kind} is not enabled.`);
  }

  const environment = cleanEnv(process.env.CROSSMINT_ENV || "staging");
  if (environment !== "staging" && environment !== "production") {
    throw new CrossmintConfigError("CROSSMINT_ENV must be staging or production.");
  }
  if (environment === "production" && !boolEnv("CROSSMINT_ALLOW_PRODUCTION")) {
    throw new CrossmintConfigError("Crossmint production is blocked until CROSSMINT_ALLOW_PRODUCTION=true.");
  }

  const apiBaseUrl = cleanBaseUrl(
    cleanEnv(process.env.CROSSMINT_API_BASE_URL) ||
      (environment === "staging" ? "https://staging.crossmint.com" : "https://www.crossmint.com")
  );
  let apiUrl: URL;
  try {
    apiUrl = new URL(apiBaseUrl);
  } catch {
    throw new CrossmintConfigError("CROSSMINT_API_BASE_URL must be a valid HTTPS URL.");
  }
  if (apiUrl.protocol !== "https:") {
    throw new CrossmintConfigError("CROSSMINT_API_BASE_URL must use HTTPS.");
  }
  if (environment === "staging" && !/staging\.crossmint\.com$/i.test(apiUrl.hostname)) {
    throw new CrossmintConfigError("CROSSMINT_ENV=staging must use staging.crossmint.com.");
  }
  if (environment === "production" && !/^(www\.)?crossmint\.com$/i.test(apiUrl.hostname)) {
    throw new CrossmintConfigError("CROSSMINT_ENV=production must use an official crossmint.com API host.");
  }

  const apiKey = cleanEnv(process.env.CROSSMINT_SERVER_API_KEY);
  if (!apiKey) {
    throw new CrossmintConfigError("CROSSMINT_SERVER_API_KEY is required.");
  }

  const requestTimeoutMs = Number(process.env.CROSSMINT_REQUEST_TIMEOUT_MS || "15000");
  const successCallbackUrl = configuredCallbackUrl("CROSSMINT_SUCCESS_CALLBACK_URL");
  const failureCallbackUrl = configuredCallbackUrl("CROSSMINT_FAILURE_CALLBACK_URL");
  if (Boolean(successCallbackUrl) !== Boolean(failureCallbackUrl)) {
    throw new CrossmintConfigError("Configure both CROSSMINT_SUCCESS_CALLBACK_URL and CROSSMINT_FAILURE_CALLBACK_URL, or neither.");
  }
  return {
    environment,
    apiBaseUrl,
    apiKey,
    apiKeyHeader: cleanEnv(process.env.CROSSMINT_API_KEY_HEADER) || "X-API-KEY",
    onrampPath: cleanEnv(process.env.CROSSMINT_ONRAMP_CREATE_ORDER_PATH) || "/api/2022-06-09/orders",
    offrampPath: cleanEnv(process.env.CROSSMINT_OFFRAMP_CREATE_ORDER_PATH) || "/api/2022-06-09/offramps/orders",
    orderStatusPathTemplate: cleanEnv(
      kind === "onramp"
        ? process.env.CROSSMINT_ONRAMP_ORDER_STATUS_PATH_TEMPLATE || process.env.CROSSMINT_ORDER_STATUS_PATH_TEMPLATE
        : process.env.CROSSMINT_OFFRAMP_ORDER_STATUS_PATH_TEMPLATE || process.env.CROSSMINT_ORDER_STATUS_PATH_TEMPLATE
    ),
    chain: cleanEnv(process.env.CROSSMINT_CHAIN) || "base-sepolia",
    asset: cleanEnv(process.env.CROSSMINT_ASSET) || "usdc",
    fiatCurrency: cleanEnv(process.env.CROSSMINT_FIAT_CURRENCY) || "usd",
    successCallbackUrl,
    failureCallbackUrl,
    requestTimeoutMs: Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 15000,
  };
}

function rawUsdcToDecimal(amountRaw: bigint): string {
  const sign = amountRaw < 0n ? "-" : "";
  const raw = (amountRaw < 0n ? -amountRaw : amountRaw).toString().padStart(7, "0");
  const whole = raw.slice(0, -6) || "0";
  const fraction = raw.slice(-6).replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

function amountUsdToRaw(value: string): bigint | null {
  const trimmed = value.trim().replace(/^\$/, "");
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const cents = `${whole}${fraction.padEnd(2, "0")}`;
  if (!isUnsignedIntegerString(cents)) return null;
  return BigInt(cents) * 10_000n;
}

function tokenMap(params: Record<string, string | number | null | undefined>) {
  const entries = Object.entries(params).flatMap(([key, value]) => {
    const text = value == null ? "" : String(value);
    return [
      [`{{${key}}}`, text],
      [`${key.toUpperCase()}`, text],
    ] as Array<[string, string]>;
  });
  return entries;
}

function applyTokens(value: string, tokens: Array<[string, string]>): string {
  return tokens.reduce((next, [token, replacement]) => next.split(token).join(replacement), value);
}

function applyTemplateValue(value: unknown, tokens: Array<[string, string]>): unknown {
  if (typeof value === "string") return applyTokens(value, tokens);
  if (Array.isArray(value)) return value.map((item) => applyTemplateValue(item, tokens));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, applyTemplateValue(item, tokens)])
    );
  }
  return value;
}

function buildPayloadFromTemplate(template: string | undefined, tokens: Array<[string, string]>): Record<string, unknown> | null {
  if (!template?.trim()) return null;
  const parsed = JSON.parse(template);
  const hydrated = applyTemplateValue(parsed, tokens);
  if (!hydrated || typeof hydrated !== "object" || Array.isArray(hydrated)) {
    throw new CrossmintConfigError("Crossmint order body template must resolve to a JSON object.");
  }
  return hydrated as Record<string, unknown>;
}

export function normalizeOnrampAmountRaw(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  if (isUnsignedIntegerString(value)) {
    const amount = BigInt(value);
    return amount > 0n ? amount : null;
  }
  const amount = amountUsdToRaw(value);
  return amount && amount > 0n ? amount : null;
}

export function buildCrossmintOnrampPayload(params: {
  walletAddress: string;
  ownerAddress: string;
  amountRaw: bigint;
  email?: string | null;
  sessionId: string;
}) {
  const config = getCrossmintConfig("onramp");
  const amountUsd = rawUsdcToDecimal(params.amountRaw);
  const tokens = tokenMap({
    walletAddress: params.walletAddress,
    ownerAddress: params.ownerAddress,
    email: params.email || "",
    amountRaw: params.amountRaw.toString(),
    amountUsd,
    chain: config.chain,
    asset: config.asset,
    fiatCurrency: config.fiatCurrency,
    sessionId: params.sessionId,
    successCallbackUrl: config.successCallbackUrl || "",
    failureCallbackUrl: config.failureCallbackUrl || "",
  });
  const templated = buildPayloadFromTemplate(process.env.CROSSMINT_ONRAMP_ORDER_BODY_TEMPLATE, tokens);
  if (templated) return addCheckoutCallbacks(templated, config);

  return addCheckoutCallbacks({
    recipient: {
      walletAddress: params.walletAddress,
      ...(params.email ? { email: params.email } : {}),
    },
    payment: {
      method: "fiat",
      currency: config.fiatCurrency,
    },
    lineItems: [
      {
        tokenLocator: `${config.chain}:${config.asset}`,
        executionParameters: {
          mode: "exact-in",
          amount: amountUsd,
        },
      },
    ],
    metadata: {
      source: "teep",
      environment: config.environment,
      sessionId: params.sessionId,
      ownerAddress: params.ownerAddress,
    },
  }, config);
}

export function buildCrossmintOfframpPayload(params: {
  ownerAddress: string;
  claimWalletAddress: string;
  grossAmountRaw: bigint;
  netAmountRaw: bigint;
  feeAmountRaw: bigint;
  paymentMethodId?: string | null;
  email?: string | null;
  sessionId: string;
}) {
  const config = getCrossmintConfig("offramp");
  const netAmountUsd = rawUsdcToDecimal(params.netAmountRaw);
  const tokens = tokenMap({
    ownerAddress: params.ownerAddress,
    claimWalletAddress: params.claimWalletAddress,
    email: params.email || "",
    paymentMethodId: params.paymentMethodId || "",
    grossAmountRaw: params.grossAmountRaw.toString(),
    netAmountRaw: params.netAmountRaw.toString(),
    feeAmountRaw: params.feeAmountRaw.toString(),
    netAmountUsd,
    chain: config.chain,
    asset: config.asset,
    fiatCurrency: config.fiatCurrency,
    sessionId: params.sessionId,
    successCallbackUrl: config.successCallbackUrl || "",
    failureCallbackUrl: config.failureCallbackUrl || "",
  });
  const templated = buildPayloadFromTemplate(process.env.CROSSMINT_OFFRAMP_ORDER_BODY_TEMPLATE, tokens);
  if (!templated) {
    throw new CrossmintConfigError("CROSSMINT_OFFRAMP_ORDER_BODY_TEMPLATE is required for bank cash-out staging.");
  }
  return addCheckoutCallbacks(templated, config);
}

function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

async function requestCrossmint(config: CrossmintConfig, path: string, options: {
  method: "GET" | "POST";
  idempotencyKey?: string;
  body?: Record<string, unknown>;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const headers: Record<string, string> = {
    Accept: "application/json",
    [config.apiKeyHeader]: config.apiKey,
  };
  if (options.method !== "GET") headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  try {
    const response = await fetch(joinUrl(config.apiBaseUrl, path), {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text.slice(0, 240) };
      }
    }
    if (!response.ok) {
      throw new CrossmintProviderError("Crossmint provider request failed.", response.status, sanitizeProviderPayload(payload));
    }
    return payload;
  } catch (error: any) {
    if (error instanceof CrossmintProviderError) throw error;
    throw new CrossmintProviderError(error?.name === "AbortError" ? "Crossmint provider request timed out." : "Crossmint provider request failed.", 503);
  } finally {
    clearTimeout(timeout);
  }
}

function pathValue(value: unknown, path: string): unknown {
  return path.split(".").reduce((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, value);
}

function firstString(value: unknown, paths: string[]): string | null {
  for (const path of paths) {
    const found = pathValue(value, path);
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return null;
}

function firstAddress(value: unknown, paths: string[]): string | null {
  const found = firstString(value, paths);
  return found && isAddress(found) ? found.toLowerCase() : null;
}

export function normalizeCrossmintOrderResult(raw: unknown): CrossmintOrderResult {
  return {
    raw,
    providerOrderId: firstString(raw, [
      "id",
      "orderId",
      "order.id",
      "order.orderId",
      "data.id",
      "data.orderId",
    ]),
    redirectUrl: firstString(raw, [
      "redirectUrl",
      "checkoutUrl",
      "hostedCheckoutUrl",
      "paymentUrl",
      "url",
      "order.redirectUrl",
      "order.checkoutUrl",
      "order.hostedCheckoutUrl",
      "data.redirectUrl",
      "data.checkoutUrl",
    ]),
    clientSecret: firstString(raw, [
      "clientSecret",
      "client_secret",
      "order.clientSecret",
      "data.clientSecret",
    ]),
    depositAddress: firstAddress(raw, [
      "depositAddress",
      "deposit.address",
      "cryptoDepositAddress",
      "order.depositAddress",
      "order.deposit.address",
      "data.depositAddress",
      "data.deposit.address",
      "payment.depositAddress",
      "payment.deposit.address",
      "source.depositAddress",
      "source.deposit.address",
    ]),
    status: firstString(raw, ["status", "order.status", "data.status"]),
  };
}

export async function createCrossmintOrder(kind: CrossmintKind, payload: Record<string, unknown>, idempotencyKey: string) {
  const config = getCrossmintConfig(kind);
  const raw = await requestCrossmint(config, kind === "onramp" ? config.onrampPath : config.offrampPath, {
    method: "POST",
    idempotencyKey,
    body: payload,
  });
  const order = normalizeCrossmintOrderResult(raw);
  return { ...order, redirectUrl: safeCrossmintUrl(order.redirectUrl, config) };
}

export async function fetchCrossmintOrderStatus(kind: CrossmintKind, providerOrderId: string) {
  const config = getCrossmintConfig(kind);
  if (!config.orderStatusPathTemplate) {
    throw new CrossmintConfigError("CROSSMINT_ORDER_STATUS_PATH_TEMPLATE is not configured.");
  }
  const path = config.orderStatusPathTemplate.split("{orderId}").join(encodeURIComponent(providerOrderId));
  const raw = await requestCrossmint(config, path, { method: "GET" });
  const order = normalizeCrossmintOrderResult(raw);
  return { ...order, redirectUrl: safeCrossmintUrl(order.redirectUrl, config) };
}

export function sanitizeProviderPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeProviderPayload);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (/secret|token|key|authorization|bank|account|routing|ssn|kyc|email|phone|name/i.test(key)) {
        return [key, "[redacted]"];
      }
      return [key, sanitizeProviderPayload(item)];
    })
  );
}

export function crossmintSessionId(prefix: CrossmintKind) {
  return `crossmint_${prefix}_${crypto.randomUUID()}`;
}

export function rawUsdcToUsdString(amountRaw: bigint) {
  return rawUsdcToDecimal(amountRaw);
}

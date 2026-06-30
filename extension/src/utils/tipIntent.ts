export type TipIntentStatus =
  | "created"
  | "signing"
  | "submitted"
  | "confirmed"
  | "failed"
  | "cancelled";

export type TipIntentRecord = {
  intentKey: string;
  attemptId: string;
  status: TipIntentStatus;
  chainId: number;
  from: string;
  contentId: string;
  authorHandle: string;
  authorId?: string;
  rawAmount: string;
  needsApproval?: boolean;
  originTabId?: number;
  createdAt: number;
  updatedAt: number;
  windowId?: number;
  txHash?: string;
  error?: string;
};

const INTENT_PREFIX = "tipIntent:";
const CREATED_TTL_MS = 30 * 60 * 1000;
const TERMINAL_FAILURE_TTL_MS = 24 * 60 * 60 * 1000;
const CONFIRMED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function intentStorageKey(intentKey: string) {
  return `${INTENT_PREFIX}${intentKey}`;
}

export function tipIntentComposite(params: {
  chainId: number;
  from: string;
  contentId: string;
  authorHandle: string;
  rawAmount: string;
}) {
  return [
    params.chainId,
    params.from.toLowerCase(),
    params.contentId.toLowerCase(),
    params.authorHandle.replace(/^@/, "").toLowerCase(),
    params.rawAmount,
  ].join(":");
}

export async function createTipIntentKey(composite: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(composite));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isTipIntentActive(status: TipIntentStatus) {
  return status === "created" || status === "signing" || status === "submitted";
}

export async function getTipIntent(intentKey: string): Promise<TipIntentRecord | null> {
  const key = intentStorageKey(intentKey);
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as TipIntentRecord | undefined) || null;
}

export async function saveTipIntent(record: TipIntentRecord) {
  await chrome.storage.local.set({ [intentStorageKey(record.intentKey)]: record });
}

export async function updateTipIntent(
  intentKey: string,
  attemptId: string,
  patch: Partial<Omit<TipIntentRecord, "intentKey" | "attemptId" | "createdAt">>
) {
  const current = await getTipIntent(intentKey);
  if (!current || current.attemptId !== attemptId) return null;
  const next: TipIntentRecord = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };
  await saveTipIntent(next);
  return next;
}

export async function listTipIntents(): Promise<TipIntentRecord[]> {
  const stored = await chrome.storage.local.get(null);
  return Object.entries(stored)
    .filter(([key]) => key.startsWith(INTENT_PREFIX))
    .map(([, value]) => value as TipIntentRecord)
    .filter((record) => Boolean(record?.intentKey && record?.attemptId && record?.status));
}

export async function pruneTipIntents(now = Date.now()) {
  const records = await listTipIntents();
  const keysToRemove = records
    .filter((record) => {
      const age = now - record.updatedAt;
      if (record.status === "created" || record.status === "signing") return age > CREATED_TTL_MS;
      if (record.status === "submitted" && !record.txHash) return age > CREATED_TTL_MS;
      if (record.status === "failed" || record.status === "cancelled") return age > TERMINAL_FAILURE_TTL_MS;
      if (record.status === "confirmed") return age > CONFIRMED_TTL_MS;
      return false;
    })
    .flatMap((record) => [
      intentStorageKey(record.intentKey),
      `pendingTip:${record.attemptId}`,
    ]);

  if (keysToRemove.length) await chrome.storage.local.remove(keysToRemove);
}

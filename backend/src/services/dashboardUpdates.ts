import type { Response } from "express";
import type { PoolClient } from "pg";
import { getPool } from "../db/database";
import { isAddress } from "../utils/security";
import { invalidateDisplayUsdcBalances } from "./balanceSnapshots";

const CHANNEL = "teep_dashboard_updates";
const MAX_SUBSCRIBERS = Math.max(50, Number(process.env.DASHBOARD_LIVE_MAX_CONNECTIONS || 2_000));
const MAX_CONNECTIONS_PER_ADDRESS = Math.max(1, Number(process.env.DASHBOARD_LIVE_MAX_CONNECTIONS_PER_ADDRESS || 5));

type DashboardUpdate = {
  reason: string;
  addresses: string[];
  occurredAt: number;
};

const subscribers = new Map<string, Set<Response>>();
let listenerClient: PoolClient | null = null;
let listenerStarting: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

function normalizedAddresses(addresses: Array<string | null | undefined>): string[] {
  return [...new Set(addresses
    .map((address) => (address || "").trim().toLowerCase())
    .filter((address) => isAddress(address)))];
}

function subscriberCount(): number {
  let count = 0;
  for (const responses of subscribers.values()) count += responses.size;
  return count;
}

function dispatch(update: DashboardUpdate): void {
  const body = `event: refresh\ndata: ${JSON.stringify({ reason: update.reason, occurredAt: update.occurredAt })}\n\n`;
  for (const address of update.addresses) {
    for (const response of subscribers.get(address) || []) {
      if (!response.writableEnded) response.write(body);
    }
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureDashboardUpdateListener();
  }, 5_000);
  reconnectTimer.unref?.();
}

export async function ensureDashboardUpdateListener(): Promise<void> {
  if (listenerClient || listenerStarting) return listenerStarting || Promise.resolve();
  listenerStarting = (async () => {
    const client = await getPool().connect();
    try {
      await client.query(`LISTEN ${CHANNEL}`);
      client.on("notification", (notification) => {
        if (notification.channel !== CHANNEL || !notification.payload) return;
        try {
          const parsed = JSON.parse(notification.payload) as DashboardUpdate;
          const addresses = normalizedAddresses(parsed.addresses || []);
          if (addresses.length) {
            invalidateDisplayUsdcBalances(addresses);
            dispatch({
              reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 60) : "account_update",
              addresses,
              occurredAt: Number(parsed.occurredAt) || Date.now(),
            });
          }
        } catch {
          // Ignore malformed notifications; this channel carries invalidation only.
        }
      });
      client.on("error", (error) => {
        console.error("[Dashboard live] Postgres listener error:", error.message);
        if (listenerClient === client) listenerClient = null;
        client.release(true);
        scheduleReconnect();
      });
      listenerClient = client;
    } catch (error) {
      client.release(true);
      throw error;
    }
  })().catch((error) => {
    console.error("[Dashboard live] Could not start Postgres listener:", error instanceof Error ? error.message : error);
    scheduleReconnect();
  }).finally(() => {
    listenerStarting = null;
  });
  return listenerStarting;
}

export function canSubscribeToDashboard(address: string): boolean {
  const normalized = address.toLowerCase();
  return isAddress(normalized) &&
    subscriberCount() < MAX_SUBSCRIBERS &&
    (subscribers.get(normalized)?.size || 0) < MAX_CONNECTIONS_PER_ADDRESS;
}

export function subscribeToDashboard(address: string, response: Response): () => void {
  const normalized = address.toLowerCase();
  const responses = subscribers.get(normalized) || new Set<Response>();
  responses.add(response);
  subscribers.set(normalized, responses);
  void ensureDashboardUpdateListener();

  return () => {
    responses.delete(response);
    if (!responses.size) subscribers.delete(normalized);
  };
}

export async function publishDashboardUpdate(input: {
  reason: string;
  addresses?: Array<string | null | undefined>;
  authorIds?: Array<string | null | undefined>;
}): Promise<void> {
  const addresses = normalizedAddresses(input.addresses || []);
  const authorIds = [...new Set((input.authorIds || []).map((value) => (value || "").trim()).filter(Boolean))];
  if (authorIds.length) {
    const result = await getPool().query<{ owner: string }>(
      `SELECT DISTINCT LOWER(owner_address) AS owner
       FROM verified_claims
       WHERE author_id = ANY($1::text[])`,
      [authorIds],
    );
    addresses.push(...normalizedAddresses(result.rows.map((row) => row.owner)));
  }
  const uniqueAddresses = [...new Set(addresses)];
  if (!uniqueAddresses.length) return;

  const update: DashboardUpdate = {
    reason: input.reason.slice(0, 60),
    addresses: uniqueAddresses,
    occurredAt: Date.now(),
  };
  invalidateDisplayUsdcBalances(uniqueAddresses);
  dispatch(update);
  await getPool().query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify(update)]);
}

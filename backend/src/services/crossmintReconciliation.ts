import { getDb } from "../db/database";
import { fetchCrossmintOrderStatus, normalizeCrossmintStatus } from "./crossmint";
import { updateFundingProviderSession } from "./fundingProviderRecords";

type PendingSession = {
  id: string;
  providerSessionId: string;
  kind: "fiat_onramp" | "fiat_offramp";
  status: string;
  metadataJson: string | null;
};

function positiveNumber(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

export async function reconcilePendingCrossmintSessions(): Promise<number> {
  if (process.env.CROSSMINT_ENABLE_RECONCILIATION !== "true") return 0;
  const limit = positiveNumber(process.env.CROSSMINT_RECONCILIATION_BATCH_SIZE, 25, 1);
  const rows = await getDb().prepare(`
    SELECT id, provider_session_id as "providerSessionId", kind, status, metadata_json as "metadataJson"
    FROM funding_provider_sessions
    WHERE provider = 'Crossmint'
      AND provider_session_id IS NOT NULL
      AND status IN ('created', 'pending', 'processing')
    ORDER BY updated_at ASC
    LIMIT ?
  `).all(limit) as PendingSession[];

  let updated = 0;
  for (const session of rows) {
    const kind = session.kind === "fiat_offramp" ? "offramp" : "onramp";
    const metadata = session.metadataJson ? JSON.parse(session.metadataJson) : {};
    try {
      const order = await fetchCrossmintOrderStatus(kind, session.providerSessionId);
      const nextStatus = normalizeCrossmintStatus(order.status);
      await updateFundingProviderSession({
        id: session.id,
        status: nextStatus,
        redirectUrl: order.redirectUrl,
        metadata: {
          ...metadata,
          providerStatus: order.status,
          lastStatusSyncAt: Date.now(),
          statusSync: "ok",
        },
      });
      updated += 1;
    } catch (error) {
      await updateFundingProviderSession({
        id: session.id,
        metadata: {
          ...metadata,
          lastStatusSyncAt: Date.now(),
          statusSync: "failed",
          statusSyncError: error instanceof Error ? error.message.slice(0, 180) : "Provider status unavailable",
        },
      }).catch(() => undefined);
    }
  }
  return updated;
}

export class CrossmintReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start() {
    if (process.env.CROSSMINT_ENABLE_RECONCILIATION !== "true") return;
    const intervalMs = positiveNumber(process.env.CROSSMINT_RECONCILIATION_INTERVAL_MS, 60_000, 15_000);
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await reconcilePendingCrossmintSessions();
      } catch (error) {
        console.error("[Crossmint] Reconciliation failed:", error instanceof Error ? error.message : error);
      } finally {
        this.running = false;
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref?.();
    console.log(`[Crossmint] Reconciliation enabled (${intervalMs}ms interval)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

import { one, query, run } from "../db/database";

export type ServiceHealthStatus = "healthy" | "degraded" | "offline" | "unknown";

export type ServiceHealthRecord = {
  service: string;
  status: ServiceHealthStatus;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  metadata: Record<string, unknown> | null;
  updatedAt: number;
};

const failureThreshold = Math.max(1, Number(process.env.SERVICE_OFFLINE_FAILURE_THRESHOLD || 3));
const consecutiveFailures = new Map<string, number>();

export function sanitizeOperationalError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const summary = raw.split(/\r?\n/).find((line) => line.trim())?.trim() || "Service request failed";
  return summary
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(api[_-]?key|token|authorization)=?\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 200);
}

export function getPublicServiceMessage(service: string, status: ServiceHealthStatus): string {
  const messages: Record<string, string> = {
    arc_rpc: "Live blockchain data is temporarily unavailable. Some balances and money actions may be delayed.",
    goldsky_ingest: "Recent blockchain activity is taking longer than expected to arrive.",
    chain_projector: "Recent account activity is taking longer than expected to update.",
    chain_indexer: "Recent blockchain activity is taking longer than expected to update.",
    database: "Teep data is temporarily unavailable.",
  };
  return messages[service] || `A Teep data service is currently ${status}.`;
}

function safeMetadata(value?: Record<string, unknown>): string | null {
  return value ? JSON.stringify(value) : null;
}

export async function recordServiceSuccess(service: string, metadata?: Record<string, unknown>): Promise<void> {
  const now = Date.now();
  consecutiveFailures.set(service, 0);
  await run(
    `INSERT INTO service_health_state (
       service, status, last_success_at, last_failure_at, last_error, metadata_json, updated_at
     ) VALUES (?, 'healthy', ?, NULL, NULL, ?, ?)
     ON CONFLICT (service) DO UPDATE SET
       status = 'healthy',
       last_success_at = excluded.last_success_at,
       last_error = NULL,
       metadata_json = COALESCE(excluded.metadata_json, service_health_state.metadata_json),
       updated_at = excluded.updated_at`,
    [service, now, safeMetadata(metadata), now]
  );
}

export async function recordServiceFailure(service: string, error: unknown, metadata?: Record<string, unknown>): Promise<void> {
  const now = Date.now();
  const failures = (consecutiveFailures.get(service) || 0) + 1;
  consecutiveFailures.set(service, failures);
  const status: ServiceHealthStatus = failures >= failureThreshold ? "offline" : "degraded";
  const message = sanitizeOperationalError(error);
  await run(
    `INSERT INTO service_health_state (
       service, status, last_success_at, last_failure_at, last_error, metadata_json, updated_at
     ) VALUES (?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT (service) DO UPDATE SET
       status = excluded.status,
       last_failure_at = excluded.last_failure_at,
       last_error = excluded.last_error,
       metadata_json = COALESCE(excluded.metadata_json, service_health_state.metadata_json),
       updated_at = excluded.updated_at`,
    [service, status, now, message.slice(0, 500), safeMetadata(metadata), now]
  );
}

export async function readServiceHealth(): Promise<ServiceHealthRecord[]> {
  const rows = await query<{
    service: string;
    status: ServiceHealthStatus;
    lastSuccessAt: number | string | null;
    lastFailureAt: number | string | null;
    lastError: string | null;
    metadataJson: string | null;
    updatedAt: number | string;
  }>(
    `SELECT service, status,
            last_success_at as "lastSuccessAt",
            last_failure_at as "lastFailureAt",
            last_error as "lastError",
            metadata_json as "metadataJson",
            updated_at as "updatedAt"
     FROM service_health_state
     ORDER BY service`
  );
  return rows.map((row) => ({
    service: row.service,
    status: row.status,
    lastSuccessAt: row.lastSuccessAt == null ? null : Number(row.lastSuccessAt),
    lastFailureAt: row.lastFailureAt == null ? null : Number(row.lastFailureAt),
    lastError: row.lastError,
    metadata: parseMetadata(row.metadataJson),
    updatedAt: Number(row.updatedAt),
  }));
}

export async function readGoldskyProjectionHealth() {
  const latest = await one<{
    latestIngestedAt: number | string | null;
    latestBlock: number | string | null;
    pending: number | string;
  }>(
    `SELECT
       MAX(l.ingested_at) as "latestIngestedAt",
       MAX(l.block_number) as "latestBlock",
       COUNT(*) FILTER (WHERE p.event_id IS NULL OR p.canonical <> l.canonical) as pending
     FROM goldsky_ingest.chain_logs l
     LEFT JOIN chain_event_projections p ON p.event_id = l.id`
  );
  return {
    latestIngestedAt: latest?.latestIngestedAt == null ? null : Number(latest.latestIngestedAt),
    latestBlock: latest?.latestBlock == null ? null : Number(latest.latestBlock),
    pending: Number(latest?.pending || 0),
  };
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

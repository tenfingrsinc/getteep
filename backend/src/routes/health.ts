import { Router, Request, Response } from "express";
import { getDb } from "../db/database";
import { summarizeOpenAbuseEvents } from "../services/abuse";
import {
  applyServiceHealthFreshness,
  getPublicServiceMessage,
  readGoldskyProjectionHealth,
  readServiceHealth,
  sanitizeOperationalError,
} from "../services/serviceHealth";

const router = Router();
const INDEXER_MAX_LAG_BLOCKS = Number(process.env.INDEXER_MAX_LAG_BLOCKS || 50);
const INDEXER_MAX_STALE_MS = Number(process.env.INDEXER_MAX_STALE_MS || 5 * 60 * 1000);
const RPC_HEALTH_MAX_STALE_MS = Math.max(15_000, Number(process.env.RPC_HEALTH_MAX_STALE_MS || 10 * 60_000));

router.get("/live", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

router.get("/client", async (_req: Request, res: Response) => {
  try {
    const mode = (process.env.CHAIN_INDEXER_MODE || "rpc").trim().toLowerCase();
    const [services, goldsky, indexer] = await Promise.all([
      readServiceHealth(),
      readGoldskyProjectionHealth(),
      getDb().prepare(
        "SELECT last_block, current_block, last_success_at, last_error, last_error_at FROM indexer_state WHERE id = 1"
      ).get() as Promise<{
        last_block: number | string;
        current_block: number | string | null;
        last_success_at: number | string | null;
        last_error: string | null;
        last_error_at: number | string | null;
      } | undefined>,
    ]);

    const checkedAt = Date.now();
    const effectiveServices = services.map((service) => service.service === "arc_rpc"
      ? applyServiceHealthFreshness(service, checkedAt, RPC_HEALTH_MAX_STALE_MS)
      : { ...service, ageMs: Math.max(0, checkedAt - service.updatedAt), stale: false });
    const serviceMap = Object.fromEntries(effectiveServices.map((service) => [service.service, {
      service: service.service,
      status: service.status,
      lastSuccessAt: service.lastSuccessAt,
      lastFailureAt: service.lastFailureAt,
      updatedAt: service.updatedAt,
      ageMs: service.ageMs,
      stale: service.stale,
    }]));
    const warnings: Array<{ service: string; status: string; message: string }> = [];
    for (const service of effectiveServices) {
      if (service.status === "degraded" || service.status === "offline" || service.status === "unknown") {
        warnings.push({
          service: service.service,
          status: service.status,
          message: getPublicServiceMessage(service.service, service.status),
        });
      }
    }
    if (!serviceMap.arc_rpc) {
      serviceMap.arc_rpc = {
        service: "arc_rpc",
        status: "unknown",
        lastSuccessAt: null,
        lastFailureAt: null,
        updatedAt: 0,
        ageMs: checkedAt,
        stale: true,
      };
      warnings.push({
        service: "arc_rpc",
        status: "unknown",
        message: getPublicServiceMessage("arc_rpc", "unknown"),
      });
    }
    if (mode === "rpc" && indexer?.last_error) {
      warnings.push({
        service: "chain_indexer",
        status: "degraded",
        message: getPublicServiceMessage("chain_indexer", "degraded"),
      });
    }

    res.set("Cache-Control", "no-store");
    res.json({
      status: warnings.some((warning) => warning.status === "offline") ? "offline" : warnings.length ? "degraded" : "ok",
      mode,
      warnings,
      services: serviceMap,
      ingestion: mode === "goldsky" ? goldsky : {
        latestBlock: Number(indexer?.last_block || 0),
        currentBlock: Number(indexer?.current_block || 0),
        lastSuccessAt: indexer?.last_success_at == null ? null : Number(indexer.last_success_at),
      },
      checkedAt,
    });
  } catch (error) {
    res.status(503).json({
      status: "offline",
      warnings: [{ service: "database", status: "offline", message: "Teep data is temporarily unavailable." }],
      checkedAt: Date.now(),
    });
  }
});

/**
 * GET /health
 * Returns service health and indexer state
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const state = await db
      .prepare("SELECT last_block, current_block, updated_at, last_success_at, last_error, last_error_at FROM indexer_state WHERE id = 1")
      .get() as {
        last_block: number;
        current_block: number | null;
        updated_at: string;
        last_success_at: number | null;
        last_error: string | null;
        last_error_at: number | null;
      } | undefined;

    const tipCount = await db
      .prepare("SELECT COUNT(*) as count FROM tips")
      .get() as { count: string };

    const indexedBlock = Number(state?.last_block || 0);
    const currentBlock = Number(state?.current_block || 0);
    const lagBlocks = currentBlock > indexedBlock ? currentBlock - indexedBlock : 0;
    const lastSuccessAt = state?.last_success_at || null;
    const staleMs = lastSuccessAt ? Date.now() - lastSuccessAt : null;
    const indexerHealthy = lagBlocks <= INDEXER_MAX_LAG_BLOCKS && (staleMs == null || staleMs <= INDEXER_MAX_STALE_MS) && !state?.last_error;
    const abuse = await summarizeOpenAbuseEvents(5);

    res.json({
      status: indexerHealthy ? "ok" : "degraded",
      indexer: {
        lastBlock: state?.last_block || 0,
        currentBlock,
        lagBlocks,
        lastUpdated: state?.updated_at || null,
        lastSuccessAt: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null,
        staleMs,
        lastError: state?.last_error ? sanitizeOperationalError(state.last_error) : null,
        lastErrorAt: state?.last_error_at ? new Date(state.last_error_at).toISOString() : null,
      },
      thresholds: {
        indexerMaxLagBlocks: INDEXER_MAX_LAG_BLOCKS,
        indexerMaxStaleMs: INDEXER_MAX_STALE_MS,
      },
      totalTipsIndexed: Number(tipCount.count),
      abuse,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: "Database unavailable" });
  }
});

router.get("/ready", async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const state = await db
      .prepare("SELECT last_block, current_block, last_success_at, last_error FROM indexer_state WHERE id = 1")
      .get() as { last_block: number; current_block: number | null; last_success_at: number | null; last_error: string | null } | undefined;
    const indexedBlock = Number(state?.last_block || 0);
    const currentBlock = Number(state?.current_block || 0);
    const lagBlocks = currentBlock > indexedBlock ? currentBlock - indexedBlock : 0;
    const staleMs = state?.last_success_at ? Date.now() - state.last_success_at : null;
    const ok = !state?.last_error && lagBlocks <= INDEXER_MAX_LAG_BLOCKS && (staleMs == null || staleMs <= INDEXER_MAX_STALE_MS);
    res.status(ok ? 200 : 503).json({
      status: ok ? "ready" : "degraded",
      lagBlocks,
      staleMs,
      lastError: state?.last_error ? sanitizeOperationalError(state.last_error) : null,
    });
  } catch {
    res.status(503).json({ status: "error", message: "Database unavailable" });
  }
});

export default router;

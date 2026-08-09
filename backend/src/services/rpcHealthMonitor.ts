import { createBackendPublicClient } from "./rpcClient";
import { recordServiceFailure, recordServiceSuccess, sanitizeOperationalError } from "./serviceHealth";

function positiveNumber(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

export async function probeArcRpc(): Promise<boolean> {
  const timeoutMs = positiveNumber(process.env.RPC_HEALTH_PROBE_TIMEOUT_MS, 5_000, 1_000);
  try {
    const client = createBackendPublicClient({ timeoutMs });
    const blockNumber = await client.getBlockNumber();
    await recordServiceSuccess("arc_rpc", {
      operation: "health_probe",
      blockNumber: blockNumber.toString(),
    });
    return true;
  } catch (error) {
    await recordServiceFailure("arc_rpc", error, { operation: "health_probe" }).catch(() => undefined);
    console.warn(`[RPC health] Arc probe failed: ${sanitizeOperationalError(error)}`);
    return false;
  }
}

export class RpcHealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start() {
    if (process.env.RPC_HEALTH_PROBE_ENABLED === "false") return;
    const intervalMs = positiveNumber(process.env.RPC_HEALTH_PROBE_INTERVAL_MS, 5 * 60_000, 5_000);
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await probeArcRpc();
      } finally {
        this.running = false;
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref?.();
    console.log(`[RPC health] Arc probe enabled (${intervalMs}ms interval)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

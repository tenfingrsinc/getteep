import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { API_BASE } from "../config";
import { ARC_RPC_URLS, arcTestnet } from "../chains";

type HealthStatus = "checking" | "ok" | "degraded" | "offline";

type HealthWarning = {
  service: string;
  status: string;
  message: string;
};

type ServiceHealthValue = {
  status: HealthStatus;
  warnings: HealthWarning[];
  checkedAt: number | null;
  refresh: () => Promise<void>;
};

const ServiceHealthContext = createContext<ServiceHealthValue | null>(null);
const CLIENT_RPC_PROBE_INTERVAL_MS = 2 * 60_000;
const CLIENT_RPC_PROBE_TIMEOUT_MS = 6_000;

async function probeRpcUrl(rpcUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), CLIENT_RPC_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    const returnedChainId = typeof payload?.result === "string" ? Number.parseInt(payload.result, 16) : NaN;
    return response.ok && !payload?.error && returnedChainId === arcTestnet.id;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function probeClientRpc(): Promise<HealthWarning | null> {
  for (let index = 0; index < ARC_RPC_URLS.length; index += 1) {
    if (!(await probeRpcUrl(ARC_RPC_URLS[index]))) continue;
    return index === 0 ? null : {
      service: "client_arc_rpc_primary",
      status: "degraded",
      message: "The primary Arc RPC is unavailable. Teep is currently using its fallback RPC.",
    };
  }
  return {
    service: "client_arc_rpc",
    status: "offline",
    message: "This browser cannot currently reach the Arc network. Live balances and wallet actions may not load.",
  };
}

export function ServiceHealthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<HealthStatus>("checking");
  const [warnings, setWarnings] = useState<HealthWarning[]>([]);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const lastClientRpcProbeAt = useRef(0);
  const lastClientRpcWarning = useRef<HealthWarning | null>(null);

  const checkHealth = useCallback(async (forceClientRpcProbe = false) => {
    try {
      const now = Date.now();
      const shouldProbeClientRpc = forceClientRpcProbe || now - lastClientRpcProbeAt.current >= CLIENT_RPC_PROBE_INTERVAL_MS;
      const [response, clientRpcWarning] = await Promise.all([
        fetch(`${API_BASE}/health/client`, { cache: "no-store" }),
        shouldProbeClientRpc ? probeClientRpc() : Promise.resolve(lastClientRpcWarning.current),
      ]);
      if (shouldProbeClientRpc) {
        lastClientRpcProbeAt.current = now;
        lastClientRpcWarning.current = clientRpcWarning;
      }
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload) throw new Error("Teep services are temporarily unavailable.");
      const nextWarnings: HealthWarning[] = Array.isArray(payload.warnings) ? [...payload.warnings] : [];
      if (clientRpcWarning) nextWarnings.push(clientRpcWarning);
      const nextStatus: HealthStatus = clientRpcWarning?.status === "offline" || payload.status === "offline"
        ? "offline"
        : payload.status === "degraded" || nextWarnings.length
          ? "degraded"
          : "ok";
      setStatus(nextStatus);
      setWarnings(nextWarnings);
      setCheckedAt(Number(payload.checkedAt || Date.now()));
    } catch (error) {
      setStatus("offline");
      setWarnings([{
        service: "teep_api",
        status: "offline",
        message: error instanceof Error ? error.message : "Teep services are temporarily unavailable.",
      }]);
      setCheckedAt(Date.now());
    }
  }, []);

  const refresh = useCallback(() => checkHealth(true), [checkHealth]);

  useEffect(() => {
    void checkHealth(true);
    const interval = window.setInterval(() => void checkHealth(), 30_000);
    const handleOnline = () => void checkHealth(true);
    const handleOffline = () => {
      setStatus("offline");
      setWarnings([{ service: "network", status: "offline", message: "Your device is offline." }]);
      setCheckedAt(Date.now());
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [checkHealth]);

  const value = useMemo(() => ({ status, warnings, checkedAt, refresh }), [checkedAt, refresh, status, warnings]);
  return <ServiceHealthContext.Provider value={value}>{children}</ServiceHealthContext.Provider>;
}

export function useServiceHealth() {
  const value = useContext(ServiceHealthContext);
  if (!value) throw new Error("useServiceHealth must be used inside ServiceHealthProvider");
  return value;
}

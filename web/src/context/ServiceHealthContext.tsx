import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { API_BASE } from "../config";

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

export function ServiceHealthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<HealthStatus>("checking");
  const [warnings, setWarnings] = useState<HealthWarning[]>([]);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/health/client`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload) throw new Error("Teep services are temporarily unavailable.");
      setStatus(payload.status === "offline" ? "offline" : payload.status === "degraded" ? "degraded" : "ok");
      setWarnings(Array.isArray(payload.warnings) ? payload.warnings : []);
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

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    const handleOnline = () => void refresh();
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
  }, [refresh]);

  const value = useMemo(() => ({ status, warnings, checkedAt, refresh }), [checkedAt, refresh, status, warnings]);
  return <ServiceHealthContext.Provider value={value}>{children}</ServiceHealthContext.Provider>;
}

export function useServiceHealth() {
  const value = useContext(ServiceHealthContext);
  if (!value) throw new Error("useServiceHealth must be used inside ServiceHealthProvider");
  return value;
}

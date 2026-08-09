import { useEffect, useRef } from "react";
import { API_BASE } from "../config";

export function useDashboardLiveUpdates(address: string, onRefresh: () => void): void {
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    if (!address || typeof EventSource === "undefined") return;

    let refreshTimer: number | null = null;
    let refreshPendingWhileHidden = false;
    const source = new EventSource(`${API_BASE}/live/dashboard?address=${encodeURIComponent(address)}`);

    const scheduleRefresh = () => {
      if (document.visibilityState === "hidden") {
        refreshPendingWhileHidden = true;
        return;
      }
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        refreshRef.current();
      }, 600);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && refreshPendingWhileHidden) {
        refreshPendingWhileHidden = false;
        scheduleRefresh();
      }
    };

    source.addEventListener("refresh", scheduleRefresh);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      source.removeEventListener("refresh", scheduleRefresh);
      source.close();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [address]);
}

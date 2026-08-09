import { useServiceHealth } from "../context/ServiceHealthContext";

export default function ServiceHealthRibbon() {
  const { status, warnings, refresh } = useServiceHealth();
  if (status === "checking" || status === "ok") return null;

  const offline = status === "offline";
  const serviceLabels: Record<string, string> = {
    arc_rpc: "Arc network",
    client_arc_rpc: "Arc network in this browser",
    client_arc_rpc_primary: "primary Arc RPC",
    chain_indexer: "activity index",
    chain_projector: "activity index",
    goldsky_ingest: "activity feed",
    teep_api: "Teep API",
  };
  const affected = warnings
    .map((warning) => serviceLabels[warning.service] || warning.service.replace(/_/g, " "))
    .filter((service, index, services) => services.indexOf(service) === index)
    .slice(0, 3)
    .join(", ");
  const message = offline
    ? "Some Teep services are offline. Saved activity may still be available, but live actions are temporarily limited."
    : "Some live data is delayed. Saved activity remains available, but balances or transactions may not update normally.";

  return (
    <div className={`service-health-ribbon ${offline ? "is-offline" : "is-degraded"}`} role="status" aria-live="polite">
      <span className="material-symbols-outlined" aria-hidden>{offline ? "cloud_off" : "warning"}</span>
      <p>
        <strong>{offline ? "Service interruption" : "Live data delayed"}</strong>
        <span>{message}{affected ? ` Affected: ${affected}.` : ""}</span>
      </p>
      <button type="button" onClick={() => void refresh()} aria-label="Check service status again" title="Check again">
        <span className="material-symbols-outlined" aria-hidden>refresh</span>
      </button>
    </div>
  );
}

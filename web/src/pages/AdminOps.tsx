import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE } from "../config";

type OpsDashboardData = {
  generatedAt: number;
  mode: "token_required" | "dev_open";
  metrics: Record<string, number>;
  sourceBreakdown: Array<{ key: string; label: string; count: number; usd: number }>;
  activityByDay: Array<{ day: string; count: number; usd: number }>;
  health: {
    indexerState?: Record<string, unknown> | null;
    opsLevelCounts: Array<{ level: string; count: number }>;
    openAbuseEvents: number;
    recentSecurityEvents: number;
  };
  tables: {
    recentTips: Array<Record<string, unknown>>;
    recentXBot: Array<Record<string, unknown>>;
    recentWithdrawals: Array<Record<string, unknown>>;
    recentEvents: Array<Record<string, unknown>>;
    securityEvents: Array<Record<string, unknown>>;
    abuseOpen: Array<Record<string, unknown>>;
  };
};

const TOKEN_KEY = "teep_ops_token";

function money(value: unknown) {
  const numeric = Number(value || 0);
  return `$${(Number.isFinite(numeric) ? numeric : 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function short(value: unknown) {
  const text = String(value ?? "");
  if (!text) return "-";
  if (/^0x[a-f0-9]{20,}$/i.test(text)) return `${text.slice(0, 6)}...${text.slice(-4)}`;
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

function dateTime(value: unknown) {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return "-";
  const ms = raw > 10_000_000_000 ? raw : raw * 1000;
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function metricLabel(key: string) {
  return key
    .replace(/Usd$/, " USD")
    .replace(/24h/g, " 24h")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function OpsTable({ title, rows }: { title: string; rows: Array<Record<string, unknown>> }) {
  const columns = useMemo(() => {
    const preferred = ["sourceMethod", "kind", "status", "amountRaw", "txHash", "receiptId", "authorHandle", "recipientXUsername", "source", "eventType", "message", "reason", "createdAt", "timestamp"];
    const discovered = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
    return preferred.filter((key) => discovered.includes(key)).concat(discovered.filter((key) => !preferred.includes(key))).slice(0, 7);
  }, [rows]);

  return (
    <section className="admin-ops-card admin-ops-table-card">
      <div className="admin-ops-card-head">
        <h2>{title}</h2>
        <span>{rows.length} rows</span>
      </div>
      {rows.length === 0 ? (
        <p className="admin-ops-empty">No records yet.</p>
      ) : (
        <div className="admin-ops-table-wrap">
          <table className="admin-ops-table">
            <thead>
              <tr>{columns.map((column) => <th key={column}>{metricLabel(column)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {columns.map((column) => {
                    const value = row[column];
                    const display = column.toLowerCase().includes("amount") ? money(Number(value || 0) / 1_000_000) : column.toLowerCase().includes("at") || column === "timestamp" ? dateTime(value) : short(value);
                    return <td key={column}>{display}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function AdminOps() {
  const [token, setToken] = useState(() => (typeof window !== "undefined" ? window.sessionStorage.getItem(TOKEN_KEY) || "" : ""));
  const [draftToken, setDraftToken] = useState(token);
  const [data, setData] = useState<OpsDashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (nextToken = token) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/api/ops/dashboard?limit=30`, {
        headers: nextToken ? { Authorization: `Bearer ${nextToken}` } : undefined,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "Could not load ops dashboard.");
      setData(payload);
      if (nextToken) window.sessionStorage.setItem(TOKEN_KEY, nextToken);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "Could not load ops dashboard.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load(token);
  }, [load, token]);

  const submitToken = (event: FormEvent) => {
    event.preventDefault();
    setToken(draftToken.trim());
    void load(draftToken.trim());
  };

  const clearToken = () => {
    window.sessionStorage.removeItem(TOKEN_KEY);
    setToken("");
    setDraftToken("");
    setData(null);
  };

  const downloadSnapshot = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `teep-ops-${new Date(data.generatedAt).toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const totalSourceUsd = data?.sourceBreakdown.reduce((sum, item) => sum + item.usd, 0) || 0;
  const maxDay = Math.max(...(data?.activityByDay || []).map((item) => item.usd), 1);
  const indexerError = String(data?.health.indexerState?.lastError || "");

  return (
    <div className="admin-ops-page">
      <header className="admin-ops-header">
        <a href="/" className="admin-ops-brand" aria-label="Teep home">
          <img src="/logo.svg" alt="" width={30} height={30} />
          <span>Teep Ops</span>
        </a>
        <div className="admin-ops-header-actions">
          {data ? <button type="button" onClick={downloadSnapshot}>Export JSON</button> : null}
          <button type="button" onClick={() => load()} disabled={loading}>Refresh</button>
          {token ? <button type="button" onClick={clearToken}>Forget token</button> : null}
        </div>
      </header>

      <main className="admin-ops-main">
        <section className="admin-ops-hero">
          <div>
            <p className="admin-ops-kicker">Admin operations</p>
            <h1>Tip flow, system health, and incident visibility.</h1>
            <p>Track where tips are coming from, watch indexer and abuse signals, and inspect recent records without touching the public app.</p>
          </div>
          <form className="admin-ops-token-card" onSubmit={submitToken}>
            <label htmlFor="ops-token">Ops token</label>
            <div>
              <input
                id="ops-token"
                type="password"
                value={draftToken}
                onChange={(event) => setDraftToken(event.target.value)}
                placeholder={data?.mode === "dev_open" ? "Dev mode allows empty token" : "Paste OPS_TOKEN"}
                autoComplete="off"
              />
              <button type="submit" disabled={loading}>{loading ? "Loading" : "Unlock"}</button>
            </div>
            {error ? <p role="alert">{error}</p> : <span>{data?.mode === "dev_open" ? "Dev mode: backend is open because OPS_TOKEN is not set." : "Production should always require OPS_TOKEN."}</span>}
          </form>
        </section>

        {data ? (
          <>
            <section className="admin-ops-metrics" aria-label="Operations summary">
              {["indexedTipVolumeUsd", "indexedTips", "xBotTips", "withdrawalVolumeUsd", "uniqueTippers", "verifiedCreators"].map((key) => (
                <article className="admin-ops-metric" key={key}>
                  <span>{metricLabel(key)}</span>
                  <strong>{key.toLowerCase().includes("usd") ? money(data.metrics[key]) : (data.metrics[key] || 0).toLocaleString()}</strong>
                </article>
              ))}
            </section>

            <section className="admin-ops-grid">
              <article className="admin-ops-card">
                <div className="admin-ops-card-head">
                  <h2>Tip source mix</h2>
                  <span>{money(totalSourceUsd)}</span>
                </div>
                <div className="admin-ops-source-list">
                  {data.sourceBreakdown.map((item) => {
                    const percent = totalSourceUsd > 0 ? Math.round((item.usd / totalSourceUsd) * 100) : 0;
                    return (
                      <div className="admin-ops-source" key={item.key}>
                        <div>
                          <strong>{item.label}</strong>
                          <span>{item.count.toLocaleString()} tips · {money(item.usd)}</span>
                        </div>
                        <b>{percent}%</b>
                        <i style={{ width: `${Math.max(percent, item.count ? 4 : 0)}%` }} />
                      </div>
                    );
                  })}
                </div>
              </article>

              <article className="admin-ops-card">
                <div className="admin-ops-card-head">
                  <h2>30 day support</h2>
                  <span>{data.activityByDay.length} days</span>
                </div>
                <div className="admin-ops-bars" aria-label="Daily tip volume">
                  {data.activityByDay.map((item) => (
                    <span key={item.day} title={`${item.day}: ${money(item.usd)}`} style={{ height: `${Math.max((item.usd / maxDay) * 100, item.usd ? 8 : 2)}%` }} />
                  ))}
                </div>
              </article>

              <article className={`admin-ops-card admin-ops-health ${indexerError ? "is-error" : ""}`}>
                <div className="admin-ops-card-head">
                  <h2>System health</h2>
                  <span>{indexerError ? "Needs review" : "Nominal"}</span>
                </div>
                <dl>
                  <div><dt>Indexer block</dt><dd>{short(data.health.indexerState?.lastBlock)} / {short(data.health.indexerState?.currentBlock)}</dd></div>
                  <div><dt>Last success</dt><dd>{dateTime(data.health.indexerState?.lastSuccessAt)}</dd></div>
                  <div><dt>Open abuse</dt><dd>{data.health.openAbuseEvents}</dd></div>
                  <div><dt>Security events</dt><dd>{data.health.recentSecurityEvents}</dd></div>
                </dl>
                {indexerError ? <p>{indexerError}</p> : null}
              </article>
            </section>

            <section className="admin-ops-data-grid">
              <OpsTable title="Recent indexed tips" rows={data.tables.recentTips} />
              <OpsTable title="X bot and claimable tips" rows={data.tables.recentXBot} />
              <OpsTable title="Withdrawals" rows={data.tables.recentWithdrawals} />
              <OpsTable title="Warnings and errors" rows={data.tables.recentEvents} />
              <OpsTable title="Security events" rows={data.tables.securityEvents} />
              <OpsTable title="Open abuse review" rows={data.tables.abuseOpen} />
            </section>
          </>
        ) : (
          <section className="admin-ops-card admin-ops-empty-state">
            <h2>Ops is locked</h2>
            <p>Enter the current `OPS_TOKEN` to view operational data. In local development, the backend may allow an empty token if no token is configured.</p>
          </section>
        )}
      </main>
    </div>
  );
}

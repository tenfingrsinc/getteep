import { Link } from "react-router-dom";
import { usePrivy } from "@privy-io/react-auth";
import DashboardShell from "./DashboardShell";
import { CHROME_STORE_URL } from "../config";

type DashboardConnectCardProps = {
  message?: string;
  onDismiss?: () => void;
};

type DashboardAuthPageProps = {
  title: string;
  address?: string;
  message?: string;
};

export function DashboardConnectCard({
  message = "Sign in to view your dashboard, balance, and tipping history.",
  onDismiss,
}: DashboardConnectCardProps) {
  const { login } = usePrivy();

  return (
    <div
      className={`dashboard-logout-overlay${onDismiss ? " dashboard-logout-overlay--floating" : ""}`}
      onMouseDown={onDismiss ? () => onDismiss() : undefined}
    >
      <div className="dashboard-logout-modal" onMouseDown={(event) => event.stopPropagation()}>
        {onDismiss && (
          <button type="button" className="dashboard-logout-dismiss" onClick={onDismiss} aria-label="Close connect prompt">
            <span className="material-symbols-outlined" aria-hidden>
              close
            </span>
          </button>
        )}
        <h2 style={{ fontSize: "1.5rem", fontWeight: 800, margin: "0 0 var(--space-2)" }}>Connect your account</h2>
        <p style={{ color: "var(--text-secondary)", marginBottom: "var(--space-6)", fontSize: "var(--text-small)" }}>
          {message}
        </p>
        <button type="button" onClick={login} className="btn-primary" style={{ width: "100%", padding: "12px 16px", marginBottom: "var(--space-4)" }}>
          Connect
        </button>
        <p style={{ fontSize: "var(--text-small)", color: "var(--text-muted)", marginBottom: "var(--space-2)" }}>
          New here? Install the Teep extension to tip on X, then return here to manage your funds.
        </p>
        <a href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer" style={{ fontSize: "var(--text-small)", color: "var(--link)", display: "block", marginBottom: "var(--space-4)" }}>
          Get Teep extension -&gt;
        </a>
        <Link to="/" style={{ fontSize: "var(--text-small)", fontWeight: 600, color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
            home
          </span>
          Back to home
        </Link>
      </div>
    </div>
  );
}

export function DashboardConnectPage({ title, address, message }: DashboardAuthPageProps) {
  return (
    <DashboardShell title={title} address={address}>
      <DashboardConnectCard message={message} />
    </DashboardShell>
  );
}

export function DashboardPreparingPage({ title, address, message = "Preparing your dashboard." }: DashboardAuthPageProps) {
  return (
    <DashboardShell title={title} address={address}>
      <main className="dashboard-body-inner">
        <div className="dashboard-empty-auth">
          <h1>{title}</h1>
          <p>{message}</p>
        </div>
      </main>
    </DashboardShell>
  );
}

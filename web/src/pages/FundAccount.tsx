import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { buildFundingPolicy } from "@teep/shared";
import DashboardShell from "../components/DashboardShell";
import { DashboardPreparingPage } from "../components/DashboardAuthState";
import {
  API_BASE,
  ENABLE_FIAT_OFFRAMP,
  ENABLE_FIAT_ONRAMP,
  FAUCET_URL,
  FUNDING_ENV,
  OFFRAMP_URL,
  ONRAMP_URL,
} from "../config";

function formatUsdRaw(raw?: string) {
  const value = Number(raw || "0") / 1e6;
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function usdToRaw(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return 0n;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

type CrossmintFundingSession = {
  id: string;
  status: string;
  redirectUrl?: string | null;
  providerStatus?: string | null;
};

function fundingStatusCopy(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "completed") return { icon: "check_circle", title: "Funds delivered", detail: "Crossmint completed this funding order." };
  if (["failed", "cancelled", "expired"].includes(normalized)) return { icon: "error", title: `Funding ${normalized}`, detail: "No further action will be taken for this order. You can start a new one." };
  if (normalized === "processing") return { icon: "sync", title: "Funding in progress", detail: "Crossmint is processing payment and delivery. You can safely leave this page." };
  return { icon: "schedule", title: "Waiting for payment", detail: "Complete the Crossmint checkout to continue." };
}

function crossmintCheckoutUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "crossmint.com" || host.endsWith(".crossmint.com"))
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function openCrossmintCheckout(value: unknown) {
  const url = crossmintCheckoutUrl(value);
  return url ? window.open(url, "_blank", "noopener,noreferrer") : null;
}

export default function FundAccount() {
  const [searchParams] = useSearchParams();
  const crossmintResult = searchParams.get("provider") === "crossmint" ? searchParams.get("result") : null;
  const { ready, authenticated, user, login } = usePrivy();
  const { wallets } = useWallets();
  const { client: smartWalletClient } = useSmartWallets();
  const embeddedWallet = wallets.find((wallet) => wallet.walletClientType === "privy");
  const userWalletAddress = (user?.wallet as { address?: string } | undefined)?.address;
  const linkedAccounts = (user as { linkedAccounts?: Array<{ type?: string; address?: string }> } | null)?.linkedAccounts ?? [];
  const addressFromLinked =
    linkedAccounts.find((account) => account?.type === "smart_wallet" && account?.address)?.address ||
    linkedAccounts.find((account) => account?.type === "wallet" && account?.address)?.address ||
    (linkedAccounts.find((account) => account?.address?.startsWith?.("0x"))?.address ?? "");
  const address = (
    smartWalletClient?.account?.address ||
    embeddedWallet?.address ||
    userWalletAddress ||
    addressFromLinked ||
    ""
  ).toLowerCase();

  const [balanceRaw, setBalanceRaw] = useState("0");
  const [copyStatus, setCopyStatus] = useState("");
  const [faucetStatus, setFaucetStatus] = useState("");
  const [faucetLoading, setFaucetLoading] = useState(false);

  const intent = searchParams.get("intent") || "";
  const recipient = (searchParams.get("recipient") || "").replace(/^@/, "").trim();
  const amount = (searchParams.get("amount") || "").replace(/^\$/, "").trim();
  const hasXTipContext = intent === "x-tip" && recipient && /^\d+(\.\d{1,2})?$/.test(amount);
  const requiredTipRaw = hasXTipContext ? usdToRaw(amount) : 0n;
  const hasEnoughForTip = hasXTipContext && BigInt(balanceRaw || "0") >= requiredTipRaw;
  const [fiatAmount, setFiatAmount] = useState(hasXTipContext ? amount : "10.00");
  const [onrampLoading, setOnrampLoading] = useState(false);
  const [onrampStatus, setOnrampStatus] = useState(() => {
    if (crossmintResult === "success") {
      return "Crossmint checkout finished. Teep is confirming delivery; this page will update automatically.";
    }
    if (crossmintResult === "failure") {
      return "Crossmint checkout was not completed. No delivery is assumed; you can continue the existing checkout or start again.";
    }
    return "";
  });
  const [activeOnramp, setActiveOnramp] = useState<CrossmintFundingSession | null>(null);
  const fundingPolicy = buildFundingPolicy({
    environment: FUNDING_ENV,
    faucetUrl: FAUCET_URL,
    fiatOnrampUrl: ONRAMP_URL,
    fiatOfframpUrl: OFFRAMP_URL,
    enableFiatOnramp: ENABLE_FIAT_ONRAMP,
    enableFiatOfframp: ENABLE_FIAT_OFFRAMP,
  });

  const createWalletProof = useCallback(async (purpose: string) => {
    if (!address || !smartWalletClient) {
      throw new Error("Wallet not ready");
    }
    const challengeRes = await fetch(`${API_BASE}/auth/wallet/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, purpose }),
    });
    const challenge = await challengeRes.json();
    if (!challengeRes.ok || !challenge.message) {
      throw new Error(challenge.error || "Could not verify wallet");
    }
    const signature = await smartWalletClient.signMessage({
      account: smartWalletClient.account,
      message: challenge.message,
    } as any);
    return { message: challenge.message, signature };
  }, [address, smartWalletClient]);

  useEffect(() => {
    if (!address) return;
    try {
      const saved = window.localStorage.getItem(`teep:crossmint:onramp:${address}`);
      const parsed = saved ? JSON.parse(saved) as CrossmintFundingSession : null;
      setActiveOnramp(parsed?.id ? { ...parsed, redirectUrl: crossmintCheckoutUrl(parsed.redirectUrl) } : null);
    } catch {
      setActiveOnramp(null);
    }
  }, [address]);

  useEffect(() => {
    if (!address || !activeOnramp?.id || ["completed", "failed", "cancelled", "expired"].includes(activeOnramp.status)) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(`${API_BASE}/crossmint/sessions/${encodeURIComponent(activeOnramp.id)}?ownerAddress=${encodeURIComponent(address)}`, { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || cancelled) return;
        const next: CrossmintFundingSession = {
          id: activeOnramp.id,
          status: String(payload.status || "pending"),
          redirectUrl: crossmintCheckoutUrl(payload.redirectUrl) || activeOnramp.redirectUrl,
          providerStatus: payload.metadata?.providerStatus || null,
        };
        setActiveOnramp(next);
        window.localStorage.setItem(`teep:crossmint:onramp:${address}`, JSON.stringify(next));
      } catch {
        // The persisted state remains visible and the next poll can recover.
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeOnramp?.id, activeOnramp?.status, activeOnramp?.redirectUrl, address]);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const refreshBalance = () => {
      fetch(`${API_BASE}/api/v1/wallet/${address}/usdc-balance`, { cache: "no-store" })
        .then((response) => response.ok ? response.json() : null)
        .then((payload) => {
          if (!cancelled && payload?.balanceRaw != null) setBalanceRaw(String(payload.balanceRaw));
        })
        .catch(() => {});
    };
    refreshBalance();
    const interval = hasXTipContext ? window.setInterval(refreshBalance, 5000) : null;
    return () => {
      cancelled = true;
      if (interval) window.clearInterval(interval);
    };
  }, [address, hasXTipContext]);

  const copyAddress = useCallback(async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopyStatus("Address copied. Paste it where you are sending funds from.");
    } catch {
      setCopyStatus("Could not copy address.");
    }
    window.setTimeout(() => setCopyStatus(""), 5000);
  }, [address]);

  const openFaucet = useCallback(async () => {
    if (!address) return;
    if (!fundingPolicy.providers.faucet.enabled || !fundingPolicy.providers.faucet.url) {
      setFaucetStatus(fundingPolicy.providers.faucet.disabledReason || "Faucet funding is not available.");
      window.setTimeout(() => setFaucetStatus(""), 5000);
      return;
    }
    setFaucetLoading(true);
    try {
      await navigator.clipboard.writeText(address);
      setFaucetStatus("Address copied. Opening faucet...");
      window.open(fundingPolicy.providers.faucet.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setFaucetStatus(error instanceof Error ? error.message : "Could not open faucet.");
    }
    setFaucetLoading(false);
    window.setTimeout(() => setFaucetStatus(""), 5000);
  }, [address, fundingPolicy]);

  const startCrossmintOnramp = useCallback(async () => {
    if (!fundingPolicy.providers.fiatOnramp.enabled) {
      setOnrampStatus(fundingPolicy.providers.fiatOnramp.disabledReason || "Crossmint funding is not available yet.");
      return;
    }
    const normalizedAmount = fiatAmount.trim().replace(/^\$/, "");
    if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(normalizedAmount) || Number(normalizedAmount) <= 0) {
      setOnrampStatus("Enter a valid funding amount.");
      return;
    }
    setOnrampLoading(true);
    setOnrampStatus("");
    try {
      const walletProof = await createWalletProof("funding");
      const response = await fetch(`${API_BASE}/crossmint/onramp/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerAddress: address,
          walletAddress: address,
          amountUsd: normalizedAmount,
          email: user?.email?.address,
          walletProof,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || "Could not start Crossmint funding.");
      }
      const session: CrossmintFundingSession = {
        id: String(payload.sessionId),
        status: String(payload.status || "pending"),
        redirectUrl: crossmintCheckoutUrl(payload.redirectUrl),
      };
      setActiveOnramp(session);
      window.localStorage.setItem(`teep:crossmint:onramp:${address}`, JSON.stringify(session));
      if (payload.redirectUrl) {
        const checkout = openCrossmintCheckout(payload.redirectUrl);
        setOnrampStatus(checkout
          ? "Crossmint staging opened. Complete the provider flow there."
          : "Your browser blocked the checkout window. Use Continue checkout below.");
      } else {
        setOnrampStatus(payload.orderId
          ? "Crossmint order created. Embedded checkout is not configured for this build yet."
          : "Crossmint order created, but no checkout URL was returned.");
      }
    } catch (error) {
      setOnrampStatus(error instanceof Error ? error.message : "Could not start Crossmint funding.");
    } finally {
      setOnrampLoading(false);
      window.setTimeout(() => setOnrampStatus(""), 7000);
    }
  }, [address, createWalletProof, fiatAmount, fundingPolicy, user?.email?.address]);

  if (!ready) {
    return <DashboardPreparingPage title="Add funds" message="Preparing your funding options." />;
  }

  if (!authenticated) {
    return (
      <main className="public-shell" style={{ minHeight: "calc(100vh - 88px)", display: "grid", placeItems: "center", padding: "clamp(32px, 8vw, 96px) var(--space-4)" }}>
        <section className="dashboard-card" style={{ width: "min(100%, 620px)", display: "grid", gap: "var(--space-5)" }}>
          <div>
            <p className="eyebrow">Funding</p>
            <h1 style={{ margin: "0 0 var(--space-3)", fontSize: "clamp(2rem, 8vw, 3.75rem)", lineHeight: 1 }}>
              {hasXTipContext ? `Fund your $${amount} tip` : "Fund your Teep account"}
            </h1>
            <p style={{ color: "var(--text-secondary)", margin: 0, fontSize: "1.05rem", lineHeight: 1.6 }}>
              {hasXTipContext
                ? `Sign in to add funds for your tip to @${recipient}.`
                : intent === "x-tip"
                  ? "Sign in to add funds and continue with X tipping."
                  : "Sign in to add funds to your Teep balance."}
            </p>
          </div>
          {hasXTipContext && (
            <div className="dashboard-settings-list-row" style={{ alignItems: "center" }}>
              <div>
                <strong>Pending X tip</strong>
                <span>@{recipient}</span>
              </div>
              <strong style={{ color: "var(--text-primary)" }}>${amount}</strong>
            </div>
          )}
          <button type="button" onClick={login} className="btn-primary" style={{ width: "100%", justifyContent: "center" }}>
            Continue
          </button>
        </section>
      </main>
    );
  }

  if (!address) {
    return <DashboardPreparingPage title="Add funds" message="Getting your Teep account ready." />;
  }

  const fundingPanel = (
    <section className={hasXTipContext ? "dashboard-card x-tip-link-card" : "dashboard-card"} style={{ display: "grid", gap: "var(--space-5)", maxWidth: hasXTipContext ? undefined : 920 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-4)", alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <p className="dashboard-metric-label" style={{ marginBottom: 6 }}>Current Teep balance</p>
          <strong style={{ color: "#fff", fontSize: "2rem", lineHeight: 1 }}>${formatUsdRaw(balanceRaw)}</strong>
        </div>
        <button type="button" onClick={copyAddress} className="btn-secondary" style={{ minHeight: 42 }}>
          {shortAddress(address)}
          <span className="material-symbols-outlined" aria-hidden style={{ fontSize: 18 }}>content_copy</span>
        </button>
      </div>

      {hasEnoughForTip && (
        <div className="x-tip-funding-ready" role="status">
          <span className="material-symbols-outlined" aria-hidden>check_circle</span>
          <div>
            <strong>Your ${amount} tip is funded</strong>
            <span>Return to the original Teep tip tab. Its balance updates automatically.</span>
          </div>
        </div>
      )}

      {!hasEnoughForTip && <div className="dashboard-funding-options" style={{ display: "grid", gap: "var(--space-3)" }}>
        {activeOnramp && (() => {
          const copy = fundingStatusCopy(activeOnramp.status);
          return (
            <div className="x-tip-funding-ready" role="status" style={{ alignItems: "flex-start" }}>
              <span className="material-symbols-outlined" aria-hidden>{copy.icon}</span>
              <div style={{ flex: 1 }}>
                <strong>{copy.title}</strong>
                <span>{copy.detail}</span>
              </div>
              {activeOnramp.redirectUrl && !["completed", "failed", "cancelled", "expired"].includes(activeOnramp.status) && (
                <button type="button" className="btn-secondary" onClick={() => openCrossmintCheckout(activeOnramp.redirectUrl)}>Continue checkout</button>
              )}
            </div>
          );
        })()}
        {fundingPolicy.providers.fiatOnramp.enabled ? (
          <>
          <label style={{ display: "grid", gap: 8 }}>
            <span className="dashboard-metric-label">Amount to add</span>
            <span style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <span style={{ position: "absolute", left: 12, color: "var(--text-muted)", fontWeight: 800 }}>$</span>
              <input
                value={fiatAmount}
                onChange={(event) => setFiatAmount(event.target.value)}
                inputMode="decimal"
                placeholder="10.00"
                style={{
                  width: "100%",
                  padding: "12px 12px 12px 28px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border)",
                  background: "var(--bg-page)",
                  color: "var(--text-primary)",
                  fontWeight: 800,
                }}
              />
            </span>
          </label>
          <button type="button" onClick={startCrossmintOnramp} disabled={onrampLoading} className="dashboard-funding-option">
            <span>
              <strong>{fundingPolicy.providers.fiatOnramp.label}</strong>
              <small>{fundingPolicy.providers.fiatOnramp.description}</small>
            </span>
            <span>{onrampLoading ? "..." : "Start"}</span>
          </button>
          </>
        ) : (
          <button type="button" className="dashboard-funding-option" disabled title={fundingPolicy.providers.fiatOnramp.disabledReason}>
            <span>
              <strong>{fundingPolicy.providers.fiatOnramp.label}</strong>
              <small>{fundingPolicy.providers.fiatOnramp.disabledReason || fundingPolicy.providers.fiatOnramp.description}</small>
            </span>
            <span>Soon</span>
          </button>
        )}

        <button type="button" onClick={openFaucet} disabled={faucetLoading || !fundingPolicy.providers.faucet.enabled} className="dashboard-funding-option">
          <span>
            <strong>{fundingPolicy.providers.faucet.label}</strong>
            <small>{fundingPolicy.providers.faucet.description}</small>
          </span>
          <span>{faucetLoading ? "..." : "Open"}</span>
        </button>

        <button type="button" onClick={copyAddress} className="dashboard-funding-option">
          <span>
            <strong>{fundingPolicy.providers.cryptoReceive.label}</strong>
            <small>{fundingPolicy.providers.cryptoReceive.description}</small>
          </span>
          <span>Copy</span>
        </button>
      </div>}

      <div style={{ display: "grid", gap: "var(--space-2)" }}>
        <p className="dashboard-funding-note" style={{ margin: 0 }}>{fundingPolicy.testnetCopy}</p>
        {copyStatus && <p className="dashboard-funding-note dashboard-funding-note--status" style={{ margin: 0 }}>{copyStatus}</p>}
        {faucetStatus && <p className="dashboard-funding-note dashboard-funding-note--status" style={{ margin: 0 }}>{faucetStatus}</p>}
        {onrampStatus && <p className="dashboard-funding-note dashboard-funding-note--status" style={{ margin: 0 }}>{onrampStatus}</p>}
      </div>
    </section>
  );

  if (hasXTipContext) {
    return (
      <main className="x-tip-link-page x-tip-link-page--fund">
        <section className="x-tip-link-hero">
          <p className="eyebrow">X tip setup</p>
          <h1>{hasEnoughForTip ? "Your tip is ready" : `Fund your $${amount} tip`}</h1>
          <p>{hasEnoughForTip ? `Return to your original Teep tab to complete the tip to @${recipient}.` : `Choose a funding method for your tip to @${recipient}. This page updates when the funds arrive.`}</p>
        </section>
        {fundingPanel}
      </main>
    );
  }

  return (
    <DashboardShell title="Add funds" address={address}>
      <main className="dashboard-body-inner">
        <section className="dashboard-page-heading">
          <div>
            <p className="eyebrow">Funding</p>
            <h1 style={{ fontSize: "2rem", fontWeight: 900, margin: "0 0 var(--space-2)" }}>Fund your Teep account</h1>
            <p style={{ color: "var(--text-secondary)", maxWidth: 620, margin: 0 }}>
              {hasXTipContext
                ? `Add funds for your $${amount} tip to @${recipient}, then return to X and send the command again.`
                : "Add funds to your Teep balance, then return to X and send your tip command again."}
            </p>
          </div>
        </section>

        {fundingPanel}

        <div style={{ marginTop: "var(--space-5)", display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
          <Link to="/dashboard" className="btn-secondary">Open dashboard</Link>
          <Link to="/dashboard/settings?tab=funding" className="btn-secondary">View funding history</Link>
        </div>
      </main>
    </DashboardShell>
  );
}

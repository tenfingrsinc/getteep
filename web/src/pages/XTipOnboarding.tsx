import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { API_BASE, USDC_ADDRESS, WEB_APP_URL } from "../config";
import { encodeApproveCall, encodeXTippingPermissionCall, X_TIPPING_ROUTER_ADDRESS } from "../lib/contracts";

type XTippingStatus = {
  balanceRaw: string;
  xAccount: { username: string } | null;
  permissions: { enabled: boolean; maxPerTipRaw: string; maxDailyRaw: string };
};

const ALLOWANCE_DAYS = 30n;

function cleanHandle(value: string | null) {
  return (value || "").replace(/^@/, "").trim();
}

function cleanAmount(value: string | null) {
  const normalized = (value || "").replace(/^\$/, "").trim();
  return /^\d+(\.\d{1,2})?$/.test(normalized) && Number(normalized) > 0 ? normalized : "";
}

function amountToRaw(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function safeXAuthUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "x.com" || url.hostname === "twitter.com") ? url.toString() : null;
  } catch {
    return null;
  }
}

export default function XTipOnboarding() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { ready, authenticated, user, login } = usePrivy();
  const { wallets } = useWallets();
  const { client: smartWalletClient } = useSmartWallets();
  const embeddedWallet = wallets.find((wallet) => wallet.walletClientType === "privy");
  const address = (
    smartWalletClient?.account?.address ||
    embeddedWallet?.address ||
    (user?.wallet as { address?: string } | undefined)?.address ||
    ""
  ).toLowerCase();
  const recipient = cleanHandle(searchParams.get("recipient"));
  const amount = cleanAmount(searchParams.get("amount"));
  const tweetId = (searchParams.get("tweetId") || "").trim();
  const [status, setStatus] = useState<XTippingStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const validIntent = Boolean(recipient && amount);
  const amountRaw = validIntent ? amountToRaw(amount) : 0n;

  const contextQuery = useMemo(() => {
    const params = new URLSearchParams({ intent: "x-tip", recipient, amount });
    if (tweetId) params.set("tweetId", tweetId);
    return params.toString();
  }, [amount, recipient, tweetId]);
  const returnTo = `${WEB_APP_URL}/x/onboard?${contextQuery}`;
  const fundingPath = `/fund?${contextQuery}`;
  const hasEnoughBalance = Boolean(status && BigInt(status.balanceRaw || "0") >= amountRaw);

  const loadStatus = useCallback(async () => {
    if (!address) return;
    setLoadingStatus(true);
    try {
      const response = await fetch(`${API_BASE}/x-balance/${address}`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload) throw new Error(payload?.error || "Could not check your Teep account.");
      setStatus(payload);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not check your Teep account.");
    } finally {
      setLoadingStatus(false);
    }
  }, [address]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const connectX = useCallback(async () => {
    if (!address) return;
    setWorking(true);
    setMessage("");
    try {
      const response = await fetch(`${API_BASE}/auth/x/tipping/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerAddress: address, returnTo }),
      });
      const payload = await response.json().catch(() => ({}));
      const authUrl = response.ok ? safeXAuthUrl(payload.authUrl) : null;
      if (!authUrl) throw new Error(payload.error || "Could not start X connection.");
      window.location.assign(authUrl);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start X connection.");
      setWorking(false);
    }
  }, [address, returnTo]);

  const activateAndContinue = useCallback(async () => {
    if (!address || !smartWalletClient?.account || !status?.xAccount) return;
    setWorking(true);
    setMessage("");
    try {
      if (!/^0x[a-fA-F0-9]{40}$/.test(X_TIPPING_ROUTER_ADDRESS)) throw new Error("X tipping is not ready yet.");
      const configuredPerTip = BigInt(status.permissions.maxPerTipRaw || "0");
      const configuredDaily = BigInt(status.permissions.maxDailyRaw || "0");
      const maxPerTipRaw = configuredPerTip >= amountRaw ? configuredPerTip : amountRaw;
      const maxDailyRaw = configuredDaily >= maxPerTipRaw ? configuredDaily : maxPerTipRaw;

      await smartWalletClient.sendTransaction({
        account: smartWalletClient.account,
        calls: [
          { to: USDC_ADDRESS, data: encodeApproveCall(X_TIPPING_ROUTER_ADDRESS, maxDailyRaw * ALLOWANCE_DAYS) },
          { to: X_TIPPING_ROUTER_ADDRESS, data: encodeXTippingPermissionCall(true, maxPerTipRaw, maxDailyRaw) },
        ],
      } as Parameters<typeof smartWalletClient.sendTransaction>[0]);

      const challengeResponse = await fetch(`${API_BASE}/auth/wallet/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, purpose: "account-settings" }),
      });
      const challenge = await challengeResponse.json().catch(() => ({}));
      if (!challengeResponse.ok || !challenge.message) throw new Error(challenge.error || "Could not verify your account.");
      const signature = await smartWalletClient.signMessage({
        account: smartWalletClient.account,
        message: challenge.message,
      } as Parameters<typeof smartWalletClient.signMessage>[0]);
      const permissionResponse = await fetch(`${API_BASE}/x-balance/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          proof: { message: challenge.message, signature },
          enabled: true,
          maxPerTipRaw: maxPerTipRaw.toString(),
          maxDailyRaw: maxDailyRaw.toString(),
        }),
      });
      const permissionPayload = await permissionResponse.json().catch(() => ({}));
      if (!permissionResponse.ok) throw new Error(permissionPayload.error || "Could not activate X tipping.");
      if (hasEnoughBalance) {
        await loadStatus();
      } else {
        navigate(fundingPath);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not activate X tipping.");
    } finally {
      setWorking(false);
    }
  }, [address, amountRaw, fundingPath, hasEnoughBalance, loadStatus, navigate, smartWalletClient, status]);

  if (!ready || (authenticated && !address)) {
    return <main className="x-tip-link-page"><section className="dashboard-card"><p>Preparing your tip...</p></section></main>;
  }
  if (!validIntent) {
    return <main className="x-tip-link-page"><section className="dashboard-card"><h1>This tip link is incomplete.</h1><p>Return to the Teep reply on X and open the continuation link again.</p></section></main>;
  }

  const step = !authenticated ? 1 : !status?.xAccount || !status.permissions.enabled ? 2 : 3;
  return (
    <main className="x-tip-link-page x-tip-onboarding-page">
      <section className="x-tip-link-hero">
        <p className="eyebrow">Continue your X tip</p>
        <h1>Tip @{recipient} ${amount}</h1>
        <p>Finish this tip first. You can explore Teep after it is ready.</p>
      </section>

      <section className="dashboard-card x-tip-onboarding-card">
        <div className="x-tip-onboarding-steps" aria-label={`Step ${step} of 3`}>
          {["Teep account", "Connect X", "Add funds"].map((label, index) => (
            <span key={label} className={step >= index + 1 ? "is-active" : ""}><i>{index + 1}</i>{label}</span>
          ))}
        </div>

        {!authenticated ? (
          <div className="x-tip-onboarding-action">
            <span className="material-symbols-outlined" aria-hidden>account_balance_wallet</span>
            <div><h2>Create your Teep account</h2><p>Continue with Privy to create the account that will send this tip.</p></div>
            <button type="button" className="btn-primary" onClick={login}>Continue</button>
          </div>
        ) : loadingStatus && !status ? (
          <p>Checking your Teep account...</p>
        ) : !status?.xAccount ? (
          <div className="x-tip-onboarding-action">
            <span className="material-symbols-outlined" aria-hidden>link</span>
            <div><h2>Connect the X account that sent the command</h2><p>This also prepares your creator wallet, so you will not need to connect X again later.</p></div>
            <button type="button" className="btn-primary" onClick={connectX} disabled={working}>{working ? "Opening X..." : "Connect X"}</button>
          </div>
        ) : !status.permissions.enabled ? (
          <div className="x-tip-onboarding-action">
            <span className="material-symbols-outlined" aria-hidden>bolt</span>
            <div><h2>Authorize this X tip</h2><p>Approve the amount and continue directly to funding.</p></div>
            <button type="button" className="btn-primary" onClick={activateAndContinue} disabled={working}>{working ? "Activating..." : "Continue to funding"}</button>
          </div>
        ) : hasEnoughBalance ? (
          <div className="x-tip-onboarding-action">
            <span className="material-symbols-outlined" aria-hidden>check_circle</span>
            <div><h2>Your tip is ready</h2><p>Your account is connected and funded. Send the command on X to complete it.</p></div>
            <a className="btn-primary" href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(`@teepagent tip @${recipient} ${amount}`)}`} target="_blank" rel="noreferrer">Send tip on X</a>
          </div>
        ) : (
          <div className="x-tip-onboarding-action">
            <span className="material-symbols-outlined" aria-hidden>payments</span>
            <div><h2>Add ${amount} to continue</h2><p>@{status.xAccount.username} is connected. Choose how you want to fund this tip.</p></div>
            <button type="button" className="btn-primary" onClick={() => navigate(fundingPath)}>View funding options</button>
          </div>
        )}
        {message && <p className="tip-post-error" role="alert">{message}</p>}
      </section>
    </main>
  );
}

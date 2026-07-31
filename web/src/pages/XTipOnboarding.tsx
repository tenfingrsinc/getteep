import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { arcTestnet } from "../chains";
import { API_BASE, USDC_ADDRESS, WEB_APP_URL } from "../config";
import {
  computeContentId,
  computeDirectCreatorContentId,
  encodeApproveCall,
  encodeTipCall,
  encodeXTippingPermissionCall,
  TIP_CONTRACT_ADDRESS,
  X_TIPPING_ROUTER_ADDRESS,
} from "../lib/contracts";
import RechargePrompt from "../components/RechargePrompt";
import TeepTipModal from "../components/TeepTipModal";
import { avatarErrorFallback, xAvatarUrl } from "../lib/avatar";

type ClaimStatus = {
  verified: boolean;
  claims: Array<{ author_id: string; username: string }>;
};

type OembedData = {
  author_name?: string | null;
  excerpt?: string | null;
  thumbnail_url?: string | null;
};

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

function formatBalance(raw: string) {
  const value = Number(raw || "0") / 1e6;
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function rawToUsdInput(raw: string) {
  const value = Number(raw || "0") / 1e6;
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function usdInputToRaw(value: string) {
  const normalized = value.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized) || Number(normalized) <= 0) {
    throw new Error("Enter a valid USD amount.");
  }
  return amountToRaw(normalized);
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
  const { ready, authenticated, user, login } = usePrivy();
  const { wallets } = useWallets();
  const { client: smartWalletClient } = useSmartWallets();
  const embeddedWallet = wallets.find((wallet) => wallet.walletClientType === "privy");
  const linkedAccounts = (user as { linkedAccounts?: Array<{ type?: string; address?: string }> } | null)?.linkedAccounts ?? [];
  const linkedWalletAddress =
    linkedAccounts.find((account) => account.type === "smart_wallet" && account.address)?.address ||
    linkedAccounts.find((account) => account.type === "wallet" && account.address)?.address ||
    linkedAccounts.find((account) => account.address?.startsWith("0x"))?.address ||
    "";
  const address = (
    smartWalletClient?.account?.address ||
    embeddedWallet?.address ||
    (user?.wallet as { address?: string } | undefined)?.address ||
    linkedWalletAddress
  ).toLowerCase();

  const recipient = cleanHandle(searchParams.get("recipient"));
  const amount = cleanAmount(searchParams.get("amount"));
  const sourceTweetId = (searchParams.get("tweetId") || "").trim();
  const tipKind = searchParams.get("kind") === "post_tip" ? "post_tip" : "direct_creator_tip";
  const targetTweetId = (searchParams.get("targetTweetId") || sourceTweetId).trim();
  const requestedTargetHandle = cleanHandle(searchParams.get("targetHandle"));
  const validIntent = Boolean(recipient && amount && targetTweetId);
  const amountRaw = validIntent ? amountToRaw(amount) : 0n;

  const [claimStatus, setClaimStatus] = useState<ClaimStatus | null>(null);
  const [claimLoading, setClaimLoading] = useState(false);
  const [balanceRaw, setBalanceRaw] = useState("0");
  const [balanceState, setBalanceState] = useState<"idle" | "checking" | "ready" | "error">("idle");
  const [oembed, setOembed] = useState<OembedData | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [rechargeStatus, setRechargeStatus] = useState<"idle" | "checking" | "insufficient">("idle");
  const [rechargeMessage, setRechargeMessage] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [tipSending, setTipSending] = useState(false);
  const [tipError, setTipError] = useState<string | null>(null);
  const [successTxHash, setSuccessTxHash] = useState<string | null>(null);
  const [xSetupOpen, setXSetupOpen] = useState(false);
  const [xSetupLoading, setXSetupLoading] = useState(false);
  const [xSetupSaving, setXSetupSaving] = useState(false);
  const [xSetupDone, setXSetupDone] = useState(false);
  const [xSetupError, setXSetupError] = useState<string | null>(null);
  const [xMaxPerTip, setXMaxPerTip] = useState("10.00");
  const [xTipBudget, setXTipBudget] = useState("50.00");

  const connectedX = claimStatus?.claims[0] || null;
  const previewHandle = requestedTargetHandle || (tipKind === "post_tip" ? recipient : connectedX?.username || "");
  const postUrl = previewHandle && targetTweetId ? `https://x.com/${previewHandle}/status/${targetTweetId}` : "";
  const hasEnoughBalance = BigInt(balanceRaw || "0") >= amountRaw;

  const contextQuery = useMemo(() => {
    const params = new URLSearchParams({
      intent: "x-tip",
      recipient,
      amount,
      kind: tipKind,
      targetTweetId,
    });
    if (sourceTweetId) params.set("tweetId", sourceTweetId);
    if (previewHandle) params.set("targetHandle", previewHandle);
    return params.toString();
  }, [amount, previewHandle, recipient, sourceTweetId, targetTweetId, tipKind]);
  const returnTo = `${WEB_APP_URL}/x/onboard?${contextQuery}`;

  const loadClaimStatus = useCallback(async () => {
    if (!address) return null;
    setClaimLoading(true);
    try {
      const response = await fetch(`${API_BASE}/auth/claim-status/${address}`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload) throw new Error(payload?.error || "Could not check your X connection.");
      setClaimStatus(payload);
      return payload as ClaimStatus;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not check your X connection.");
      return null;
    } finally {
      setClaimLoading(false);
    }
  }, [address]);

  const refreshBalance = useCallback(async (): Promise<bigint | null> => {
    if (!address) return null;
    setBalanceState("checking");
    try {
      const response = await fetch(`${API_BASE}/api/v1/wallet/${address}/usdc-balance`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.balanceRaw == null) throw new Error(payload?.error || "Could not check your balance.");
      const nextRaw = String(payload.balanceRaw);
      setBalanceRaw(nextRaw);
      setBalanceState("ready");
      return BigInt(nextRaw);
    } catch {
      setBalanceState("error");
      return null;
    }
  }, [address]);

  useEffect(() => {
    if (!authenticated || !address) return;
    void loadClaimStatus();
  }, [address, authenticated, loadClaimStatus]);

  useEffect(() => {
    if (!authenticated || !address || !claimStatus?.verified) return;
    let cancelled = false;
    const check = async () => {
      if (!cancelled) await refreshBalance();
    };
    void check();
    const interval = window.setInterval(() => void check(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [address, authenticated, claimStatus?.verified, refreshBalance]);

  useEffect(() => {
    if (!postUrl || !claimStatus?.verified) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/v1/oembed?url=${encodeURIComponent(postUrl)}`)
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (!cancelled && payload) setOembed(payload);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [claimStatus?.verified, postUrl]);

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

  const continueTip = useCallback(async () => {
    setMessage("");
    const currentBalance = await refreshBalance();
    if (currentBalance == null) {
      setMessage("Balance check is temporarily unavailable. No transaction was started.");
      return;
    }
    if (currentBalance < amountRaw) {
      setRechargeStatus("idle");
      setRechargeMessage(null);
      setRechargeOpen(true);
      return;
    }
    setConfirmOpen(true);
  }, [amountRaw, refreshBalance]);

  const retryAfterFunding = useCallback(async () => {
    setRechargeStatus("checking");
    setRechargeMessage(null);
    const currentBalance = await refreshBalance();
    if (currentBalance == null) {
      setRechargeStatus("insufficient");
      setRechargeMessage("Teep could not refresh your balance. No transaction was started; try again in a moment.");
      return;
    }
    if (currentBalance >= amountRaw) {
      setRechargeOpen(false);
      setRechargeStatus("idle");
      setMessage(`Balance updated. Your $${amount} tip is ready to review.`);
      return;
    }
    const shortfall = Number(amountRaw - currentBalance) / 1e6;
    setRechargeStatus("insufficient");
    setRechargeMessage(`Balance is still $${formatBalance(currentBalance.toString())}. Add $${shortfall.toFixed(2)} more to continue.`);
  }, [amount, amountRaw, refreshBalance]);

  const sendTip = useCallback(async () => {
    if (!smartWalletClient?.account || !address || !validIntent) return;
    setTipSending(true);
    setTipError(null);
    try {
      const currentBalance = await refreshBalance();
      if (currentBalance == null) throw new Error("Balance could not be verified. No transaction was started.");
      if (currentBalance < amountRaw) {
        setConfirmOpen(false);
        setRechargeOpen(true);
        throw new Error("Your Teep balance is below this tip amount.");
      }

      const response = await fetch(`${API_BASE}/auth/x/user/${encodeURIComponent(recipient)}`);
      const resolved = await response.json().catch(() => ({}));
      const authorId = String(resolved.authorId || resolved.id || "");
      if (!response.ok || !/^\d+$/.test(authorId)) throw new Error("Could not verify this creator.");

      const contentId = tipKind === "post_tip"
        ? computeContentId(recipient, targetTweetId)
        : computeDirectCreatorContentId(authorId);
      const txHash = await smartWalletClient.sendTransaction({
        account: smartWalletClient.account,
        chain: arcTestnet,
        calls: [
          { to: USDC_ADDRESS, data: encodeApproveCall(TIP_CONTRACT_ADDRESS, amountRaw) },
          { to: TIP_CONTRACT_ADDRESS, data: encodeTipCall(contentId, BigInt(authorId), amountRaw) },
        ],
      } as Parameters<typeof smartWalletClient.sendTransaction>[0]);

      await fetch(`${API_BASE}/tips/metadata`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          tipKind === "post_tip"
            ? { contentId, authorHandle: recipient, tweetId: targetTweetId, kind: "post_tip" }
            : { contentId, authorHandle: recipient, authorId, kind: "direct_creator_tip" },
        ),
      }).catch(() => {});

      setConfirmOpen(false);
      setSuccessTxHash(txHash);
      setBalanceRaw((currentBalance - amountRaw).toString());
    } catch (error) {
      const text = error instanceof Error ? error.message : "Could not send this tip.";
      setTipError(text);
    } finally {
      setTipSending(false);
    }
  }, [address, amountRaw, recipient, refreshBalance, smartWalletClient, targetTweetId, tipKind, validIntent]);

  const openXSetup = useCallback(async () => {
    setXSetupOpen(true);
    setXSetupLoading(true);
    setXSetupError(null);
    try {
      const response = await fetch(`${API_BASE}/x-balance/${address}`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.permissions) throw new Error(payload?.error || "Could not load X tip limits.");
      setXMaxPerTip(rawToUsdInput(String(payload.permissions.maxPerTipRaw || "10000000")));
      setXTipBudget(rawToUsdInput(String(payload.permissions.maxDailyRaw || "50000000")));
    } catch (error) {
      setXSetupError(error instanceof Error ? error.message : "Could not load X tip limits.");
    } finally {
      setXSetupLoading(false);
    }
  }, [address]);

  const enableFutureXTipping = useCallback(async () => {
    if (!smartWalletClient?.account || !address) return;
    setXSetupSaving(true);
    setXSetupError(null);
    try {
      if (!/^0x[a-fA-F0-9]{40}$/.test(X_TIPPING_ROUTER_ADDRESS)) {
        throw new Error("X tip commands are not configured yet.");
      }
      const maxPerTipRaw = usdInputToRaw(xMaxPerTip);
      const budgetRaw = usdInputToRaw(xTipBudget);
      if (budgetRaw < maxPerTipRaw) throw new Error("X tip budget must be at least the per-tip limit.");

      await smartWalletClient.sendTransaction({
        account: smartWalletClient.account,
        chain: arcTestnet,
        calls: [
          { to: USDC_ADDRESS, data: encodeApproveCall(X_TIPPING_ROUTER_ADDRESS, budgetRaw) },
          { to: X_TIPPING_ROUTER_ADDRESS, data: encodeXTippingPermissionCall(true, maxPerTipRaw, budgetRaw) },
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
          maxDailyRaw: budgetRaw.toString(),
        }),
      });
      const permissionPayload = await permissionResponse.json().catch(() => ({}));
      if (!permissionResponse.ok) throw new Error(permissionPayload.error || "Could not enable X tip commands.");
      setXSetupDone(true);
    } catch (error) {
      setXSetupError(error instanceof Error ? error.message : "Could not enable X tip commands.");
    } finally {
      setXSetupSaving(false);
    }
  }, [address, smartWalletClient, xMaxPerTip, xTipBudget]);

  if (!ready || (authenticated && !address)) {
    return <main className="x-tip-link-page"><section className="dashboard-card"><p>Preparing your tip...</p></section></main>;
  }
  if (!validIntent) {
    return <main className="x-tip-link-page"><section className="dashboard-card"><h1>This tip link is incomplete.</h1><p>Return to the Teep reply on X and open the continuation link again.</p></section></main>;
  }

  if (successTxHash) {
    return (
      <main className="x-tip-link-page x-tip-onboarding-page">
        <section className="dashboard-card x-tip-onboarding-card x-tip-onboarding-success" role="status">
          <span className="material-symbols-outlined" aria-hidden>check_circle</span>
          <p className="eyebrow">Tip sent</p>
          <h1>${amount} is on its way to @{recipient}</h1>
          <p>Your tip was submitted successfully. Teep will attach the receipt once the transaction is indexed.</p>
          <div className="x-tip-onboarding-success-actions">
            <Link to={`/tx/${successTxHash}`} className="btn-primary">View receipt</Link>
            {!xSetupDone ? (
              <button type="button" className="btn-secondary" onClick={openXSetup} disabled={xSetupLoading}>
                {xSetupLoading ? "Loading limits..." : "Enable future tips from X"}
              </button>
            ) : null}
            <Link to="/dashboard" className="btn-secondary">Explore Teep</Link>
          </div>
          {xSetupOpen && !xSetupDone ? (
            <div className="x-tip-onboarding-x-setup">
              <div>
                <strong>Enable @teepagent commands</strong>
                <span>Choose the most Teep may move through future X commands. This approval is a budget, not a charge.</span>
              </div>
              <div className="x-tip-onboarding-x-fields">
                <label>
                  <span>Maximum per tip</span>
                  <div><b aria-hidden>$</b><input value={xMaxPerTip} onChange={(event) => setXMaxPerTip(event.target.value.replace(/^\$/, ""))} inputMode="decimal" disabled={xSetupSaving} /></div>
                </label>
                <label>
                  <span>Total X tip budget</span>
                  <div><b aria-hidden>$</b><input value={xTipBudget} onChange={(event) => setXTipBudget(event.target.value.replace(/^\$/, ""))} inputMode="decimal" disabled={xSetupSaving} /></div>
                </label>
              </div>
              <button type="button" className="btn-primary" onClick={enableFutureXTipping} disabled={xSetupSaving || xSetupLoading}>
                {xSetupSaving ? "Enabling X tips..." : `Authorize $${xTipBudget} X tip budget`}
              </button>
              {xSetupError ? <p className="tip-post-error" role="alert">{xSetupError}</p> : null}
            </div>
          ) : null}
          {xSetupDone ? (
            <div className="x-tip-onboarding-x-enabled" role="status">
              <span className="material-symbols-outlined" aria-hidden>check_circle</span>
              Future @teepagent tips are enabled with a ${xTipBudget} total budget and ${xMaxPerTip} per-tip limit.
            </div>
          ) : null}
        </section>
      </main>
    );
  }

  const step = !authenticated ? 1 : !claimStatus?.verified ? 2 : 3;
  const avatarHandle = tipKind === "post_tip" ? recipient : previewHandle;
  return (
    <main className="x-tip-link-page x-tip-onboarding-page">
      <section className="x-tip-link-hero">
        <p className="eyebrow">Continue your X tip</p>
        <h1>Tip @{recipient} ${amount}</h1>
        <p>Finish the action you started on X. Your tip stays here while you connect and fund your account.</p>
      </section>

      <section className="dashboard-card x-tip-onboarding-card">
        <div className="x-tip-onboarding-steps" aria-label={`Step ${step} of 3`}>
          {["Teep account", "Connect X", "Send tip"].map((label, index) => (
            <span key={label} className={step >= index + 1 ? "is-active" : ""}><i>{index + 1}</i>{label}</span>
          ))}
        </div>

        {!authenticated ? (
          <div className="x-tip-onboarding-action">
            <span className="material-symbols-outlined" aria-hidden>account_balance_wallet</span>
            <div><h2>Create your Teep account</h2><p>Continue with Privy to create the account that will send this tip.</p></div>
            <button type="button" className="btn-primary" onClick={login}>Continue</button>
          </div>
        ) : claimLoading && !claimStatus ? (
          <p>Checking your X connection...</p>
        ) : !claimStatus?.verified ? (
          <div className="x-tip-onboarding-action">
            <span className="material-symbols-outlined" aria-hidden>link</span>
            <div><h2>Connect the X account that sent the command</h2><p>This also prepares your creator wallet, so you will not need to connect X again later.</p></div>
            <button type="button" className="btn-primary" onClick={connectX} disabled={working}>{working ? "Opening X..." : "Connect X"}</button>
          </div>
        ) : (
          <div className="x-tip-onboarding-final">
            <article className="x-tip-onboarding-post">
              <div className="x-tip-onboarding-post-head">
                <img src={xAvatarUrl(avatarHandle) || "/logo.svg"} alt="" onError={(event) => avatarErrorFallback(event, avatarHandle)} />
                <div><strong>{oembed?.author_name || `@${previewHandle}`}</strong><span>@{previewHandle}</span></div>
                <b>{tipKind === "post_tip" ? "Post tip" : "Direct tip"}</b>
              </div>
              <p>{oembed?.excerpt || (tipKind === "post_tip" ? "This is the X post receiving your tip." : "This is the X post that started your direct tip.")}</p>
              {oembed?.thumbnail_url ? <img className="x-tip-onboarding-post-media" src={oembed.thumbnail_url} alt="" /> : null}
              <a href={postUrl} target="_blank" rel="noopener noreferrer">View post on X <span className="material-symbols-outlined" aria-hidden>open_in_new</span></a>
            </article>

            <div className="x-tip-onboarding-payment">
              <div><span>Tip amount</span><strong>${amount}</strong></div>
              <div><span>Teep balance {balanceState === "checking" ? "· checking" : ""}</span><strong>${formatBalance(balanceRaw)}</strong></div>
            </div>
            <button type="button" className="btn-primary x-tip-onboarding-continue" onClick={continueTip} disabled={balanceState === "checking"}>
              {hasEnoughBalance ? `Review and send $${amount}` : "Continue"}
            </button>
            {balanceState === "error" ? <p className="tip-post-error" role="alert">Balance check is temporarily unavailable. Try Continue again.</p> : null}
          </div>
        )}
        {message && <p className="tip-post-error" role="status">{message}</p>}
      </section>

      <RechargePrompt
        open={rechargeOpen}
        onClose={() => {
          setRechargeOpen(false);
          setRechargeStatus("idle");
          setRechargeMessage(null);
        }}
        onRetry={retryAfterFunding}
        amountUsd={amount}
        handle={recipient}
        embedFunding
        walletAddress={address || null}
        retryStatus={rechargeStatus}
        retryMessage={rechargeMessage}
        fundingQuery={contextQuery}
      />
      <TeepTipModal
        open={confirmOpen}
        title="Confirm tip"
        modeLabel={tipKind === "post_tip" ? "Post tip" : "Direct tip"}
        recipientLabel={`@${recipient}`}
        context={`This sends exactly $${amount} from your Teep balance. No recurring X-tip allowance will be created.`}
        amount={amount}
        onAmountChange={() => {}}
        readOnlyAmount
        confirmLabel="Send tip"
        sending={tipSending}
        error={tipError}
        onConfirm={sendTip}
        onClose={() => {
          if (!tipSending) {
            setConfirmOpen(false);
            setTipError(null);
          }
        }}
      />
    </main>
  );
}

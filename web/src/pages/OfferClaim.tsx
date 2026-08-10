import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { usePrivy } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { API_BASE } from "../config";
import { privyAuthorizedFetch } from "../lib/privyApi";

type ClaimPreview = {
  status: string;
  creatorUsername: string;
  expiresAt: number | null;
  offer: { name?: string; description?: string; fulfillmentType?: string; thresholdUsd?: string };
};

type Fulfillment = {
  type: string;
  protectedUrl: string | null;
  sharedCode: string | null;
  uniqueCode: string | null;
  instructions: string | null;
};

export default function OfferClaim() {
  const { token = "" } = useParams<{ token: string }>();
  const { ready, authenticated, login, getAccessToken } = usePrivy();
  const { client: smartWalletClient } = useSmartWallets();
  const address = (smartWalletClient?.account?.address || "").toLowerCase();
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [fulfillment, setFulfillment] = useState<Fulfillment | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    fetch(`${API_BASE}/offers/claim/${encodeURIComponent(token)}`)
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "This claim is unavailable.");
        setPreview(payload);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "This claim is unavailable."))
      .finally(() => setLoading(false));
  }, [token]);

  const claim = useCallback(async () => {
    if (!ready) return;
    if (!authenticated) {
      login();
      return;
    }
    if (!address) return;
    setClaiming(true);
    setError("");
    try {
      const response = await privyAuthorizedFetch(getAccessToken, `${API_BASE}/offers/claim/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supporterAddress: address }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "This offer could not be claimed.");
      setFulfillment(payload.fulfillment);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "This offer could not be claimed.");
    } finally {
      setClaiming(false);
    }
  }, [address, authenticated, getAccessToken, login, ready, token]);

  const copy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(""), 1600);
  };

  return (
    <main className="offer-claim-page">
      <section className="offer-claim-card">
        <div className="offer-claim-brand"><img src="/logo.svg" alt="" /><span>Teep Creator Offer</span></div>
        {loading ? <div className="offer-claim-loading"><span className="creator-offers-spinner" />Checking your offer…</div> : error && !preview ? <div className="offer-claim-error"><span className="material-symbols-outlined">link_off</span><h1>Claim unavailable</h1><p>{error}</p></div> : preview ? <>
          <header className="offer-claim-head"><span className="offer-claim-gift"><span className="material-symbols-outlined">redeem</span></span><p>You unlocked an offer from @{preview.creatorUsername}</p><h1>{preview.offer.name || "Creator offer"}</h1><span>{preview.offer.description}</span></header>
          {!fulfillment ? <div className="offer-claim-ready"><div><span className="material-symbols-outlined">verified_user</span><span><strong>{preview.status === "CLAIMED" ? "Protected for the account that claimed it" : "Reserved for the account that tipped"}</strong><small>Connect that same Teep account to reveal it securely.</small></span></div>{preview.expiresAt && preview.status === "RESERVED_UNCLAIMED" && <div><span className="material-symbols-outlined">schedule</span><span><strong>Claim before it closes</strong><small>{new Date(preview.expiresAt).toLocaleString()}</small></span></div>}<button className="btn-primary" type="button" disabled={claiming || !ready || !["RESERVED_UNCLAIMED", "CLAIMED"].includes(preview.status)} onClick={claim}>{claiming ? "Opening…" : !authenticated ? "Connect to view" : preview.status === "CLAIMED" ? "View claimed offer" : "Reveal my offer"}<span className="material-symbols-outlined">arrow_forward</span></button>{error && <p className="offer-claim-inline-error" role="alert">{error}</p>}</div> : <div className="offer-claim-fulfillment"><div className="offer-claim-success"><span className="material-symbols-outlined">check_circle</span><span><strong>{preview.status === "CLAIMED" ? "Your offer details" : "Offer claimed"}</strong><small>You can return here from My Offers whenever you need them.</small></span></div>{fulfillment.protectedUrl && <div className="offer-claim-value"><span>Private destination</span><a href={fulfillment.protectedUrl} target="_blank" rel="noopener noreferrer">Open destination <span className="material-symbols-outlined">arrow_outward</span></a></div>}{(fulfillment.uniqueCode || fulfillment.sharedCode) && <div className="offer-claim-value"><span>Your code</span><div><code>{fulfillment.uniqueCode || fulfillment.sharedCode}</code><button type="button" onClick={() => copy("code", fulfillment.uniqueCode || fulfillment.sharedCode || "")}><span className="material-symbols-outlined">{copied === "code" ? "check" : "content_copy"}</span>{copied === "code" ? "Copied" : "Copy"}</button></div></div>}{fulfillment.instructions && <div className="offer-claim-value"><span>Creator instructions</span><p>{fulfillment.instructions}</p></div>}<a className="btn-secondary" href="/dashboard/offers">View all my offers</a></div>}
        </> : null}
      </section>
      <p className="offer-claim-boundary">Teep verifies the qualifying tip and protects initial access. The creator manages the external offer.</p>
    </main>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePrivy } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import DashboardShell from "../components/DashboardShell";
import { DashboardConnectPage, DashboardPreparingPage } from "../components/DashboardAuthState";
import { API_BASE } from "../config";
import { useDashboardLiveUpdates } from "../hooks/useDashboardLiveUpdates";

type Entitlement = {
  id: string;
  status: "RESERVED_UNCLAIMED" | "CLAIMED" | "EXPIRED" | "REVOKED";
  offer: {
    name?: string;
    description?: string;
    offerType?: string;
    fulfillmentType?: string;
    creatorUsername?: string;
  };
  creatorUsername: string;
  claimUrl: string | null;
  qualifiedAt: number;
  expiresAt: number | null;
  claimedAt: number | null;
};

function stateCopy(status: Entitlement["status"]) {
  if (status === "CLAIMED") return "Claimed";
  if (status === "EXPIRED") return "Claim ended";
  if (status === "REVOKED") return "Unavailable";
  return "Ready to claim";
}

export default function SupporterOffers() {
  const { ready, authenticated } = usePrivy();
  const { client: smartWalletClient } = useSmartWallets();
  const navigate = useNavigate();
  const address = (smartWalletClient?.account?.address || "").toLowerCase();
  const [items, setItems] = useState<Entitlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openingId, setOpeningId] = useState("");
  const readSessionRef = useRef<{ address: string; token: string; expiresAt: number } | null>(null);
  const readSessionPromiseRef = useRef<Promise<string> | null>(null);

  const walletProof = useCallback(async () => {
    if (!smartWalletClient?.account || !address) throw new Error("Connect your Teep account first.");
    const challengeResponse = await fetch(`${API_BASE}/auth/wallet/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, purpose: "offer-claim" }),
    });
    const challenge = await challengeResponse.json().catch(() => ({}));
    if (!challengeResponse.ok || !challenge.message) throw new Error(challenge.error || "Could not verify your account.");
    const signature = await smartWalletClient.signMessage({
      account: smartWalletClient.account,
      message: challenge.message,
    } as Parameters<typeof smartWalletClient.signMessage>[0]);
    return { message: challenge.message, signature };
  }, [address, smartWalletClient]);

  const getReadSession = useCallback(async () => {
    const current = readSessionRef.current;
    if (current && current.address === address && current.expiresAt > Date.now() + 10_000) return current.token;
    if (readSessionPromiseRef.current) return readSessionPromiseRef.current;
    readSessionPromiseRef.current = (async () => {
      const proof = await walletProof();
      const response = await fetch(`${API_BASE}/offers/supporter/${address}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletProof: proof }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.token) throw new Error(payload.error || "Could not verify your Teep account.");
      readSessionRef.current = { address, token: payload.token, expiresAt: Number(payload.expiresAt || 0) };
      return payload.token as string;
    })();
    try {
      return await readSessionPromiseRef.current;
    } finally {
      readSessionPromiseRef.current = null;
    }
  }, [address, walletProof]);

  const load = useCallback(() => {
    if (!address) return;
    getReadSession()
      .then((token) => fetch(`${API_BASE}/offers/supporter/${address}`, { headers: { Authorization: `Bearer ${token}` } }))
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "Could not load your offers.");
        setItems(Array.isArray(payload.entitlements) ? payload.entitlements : []);
        setError("");
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load your offers."))
      .finally(() => setLoading(false));
  }, [address, getReadSession]);

  useEffect(load, [load]);
  useDashboardLiveUpdates(address, load);

  const openClaim = async (entitlementId: string) => {
    if (!smartWalletClient?.account || !address) return;
    setOpeningId(entitlementId);
    setError("");
    try {
      const proof = await walletProof();
      const response = await fetch(`${API_BASE}/offers/supporter/${address}/claim-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletProof: proof }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not open this claim.");
      const item = (payload.entitlements || []).find((entry: Entitlement) => entry.id === entitlementId);
      if (!item?.claimUrl) throw new Error("This offer is not currently available.");
      navigate(new URL(item.claimUrl).pathname);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open this claim.");
    } finally {
      setOpeningId("");
    }
  };

  if (!ready || (authenticated && !address)) return <DashboardPreparingPage title="My Offers" address={address} />;
  if (!authenticated) return <DashboardConnectPage title="My Offers" />;

  return (
    <DashboardShell address={address} title="My Offers">
      <main className="supporter-offers-page">
        <header className="supporter-offers-head">
          <span>Unlocked Offers</span>
          <h1>What your support unlocked.</h1>
          <p>Private access, codes, and links earned from confirmed tips appear here.</p>
        </header>
        {error && <div className="creator-offers-feedback is-error" role="alert"><span className="material-symbols-outlined">error</span>{error}</div>}
        {loading ? (
          <div className="creator-offers-empty"><span className="creator-offers-spinner" /><strong>Checking your offers</strong></div>
        ) : items.length === 0 ? (
          <section className="supporter-offers-empty">
            <span className="material-symbols-outlined" aria-hidden>redeem</span>
            <h2>No offers unlocked yet</h2>
            <p>Visit a creator profile to see what your next tip can unlock.</p>
            <a className="btn-primary" href="/dashboard/discover">Discover creators</a>
          </section>
        ) : (
          <section className="supporter-offers-list" aria-label="Your unlocked creator offers">
            {items.map((item) => (
              <article className="supporter-offer-card" key={item.id}>
                <span className="supporter-offer-icon"><span className="material-symbols-outlined" aria-hidden>{item.offer.fulfillmentType === "UNIQUE_CODE" || item.offer.fulfillmentType === "SHARED_CODE" ? "confirmation_number" : item.offer.fulfillmentType === "PROTECTED_LINK" ? "link" : "key"}</span></span>
                <div className="supporter-offer-copy">
                  <span>From @{item.creatorUsername}</span>
                  <h2>{item.offer.name || "Creator offer"}</h2>
                  <p>{item.offer.description}</p>
                  <small>Unlocked {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(item.qualifiedAt))}{item.expiresAt ? ` · Claim by ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(item.expiresAt))}` : ""}</small>
                </div>
                <div className="supporter-offer-action">
                  <span className={`supporter-offer-state state-${item.status.toLowerCase()}`}>{stateCopy(item.status)}</span>
                  {["RESERVED_UNCLAIMED", "CLAIMED"].includes(item.status) && <button className={item.status === "CLAIMED" ? "btn-secondary" : "btn-primary"} type="button" disabled={openingId === item.id} onClick={() => openClaim(item.id)}>{openingId === item.id ? "Opening…" : item.status === "CLAIMED" ? "View details" : "Claim offer"}<span className="material-symbols-outlined">arrow_forward</span></button>}
                </div>
              </article>
            ))}
          </section>
        )}
      </main>
    </DashboardShell>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { API_BASE, RECEIPT_BASE_URL } from "../config";
import { avatarErrorFallback, creatorAvatarUrl } from "../lib/avatar";

type ClaimStatus = "unclaimed" | "verified" | "claim_wallet_active";

interface TipperCreator {
  authorId: string;
  username: string | null;
  profileImageUrl?: string | null;
  total: string;
  totalRaw?: string;
  tipCount?: number;
  isVerified?: boolean;
  claimStatus?: ClaimStatus;
}

interface RecentTip {
  contentId: string;
  authorId: string;
  username: string | null;
  amountRaw: string;
  amount: string;
  txHash: string | null;
  timestamp: number;
  claimStatus: ClaimStatus;
}

interface TipperProfileData {
  address: string | null;
  identity?: string;
  privateActivity?: boolean;
  totalSent: string;
  tipCount: number;
  thankYouReceivedCount?: number;
  recentTips?: RecentTip[];
  creatorsSupported: TipperCreator[];
}

function formatUsdRaw(raw: string): string {
  return (Number(raw || "0") / 1e6).toFixed(2);
}

function formatUsdAlreadyDollars(val: string): string {
  return Number(val || "0").toFixed(2);
}

function setMeta(propertyOrName: string, content: string): void {
  const isOg = propertyOrName.startsWith("og:");
  const attr = isOg ? "property" : "name";
  let el = document.querySelector(`meta[${attr}="${propertyOrName}"]`) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, propertyOrName);
    document.head.appendChild(el);
  }
  el.content = content;
}

function profileLabel(profile: TipperProfileData): string {
  return profile.identity || "Teep supporter";
}

function initials(label: string): string {
  return label.replace(/^@/, "").slice(0, 2).toUpperCase() || "TP";
}

function creatorAvatar(creator: Pick<TipperCreator, "authorId" | "username" | "profileImageUrl">): string {
  return creatorAvatarUrl({ username: creator.username, authorId: creator.authorId, profileImageUrl: creator.profileImageUrl });
}

function creatorLabel(creator: Pick<TipperCreator, "authorId" | "username">): string {
  return creator.username ? `@${creator.username}` : "Creator";
}

function inviteToClaimUrl(username: string): string {
  const handle = username.replace(/^@/, "");
  const text = `@${handle} you have tips waiting on Teep. Verify your creator account to claim them.\n\nSupport creators directly via @teepxyz`;
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

function claimStatusLabel(status?: ClaimStatus): string {
  if (status === "verified" || status === "claim_wallet_active") return "Claimed";
  return "Awaiting claim";
}

function claimStatusClass(status?: ClaimStatus): string {
  return status === "verified" || status === "claim_wallet_active" ? "is-claimed" : "is-waiting";
}

function timeAgo(timestamp: number): string {
  const millis = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  const diff = Math.max(0, Date.now() - millis);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(millis).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function TipperProfile() {
  const params = useParams<{ address?: string; id?: string }>();
  const address = params.address || params.id;
  const [profile, setProfile] = useState<TipperProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [shareCopied, setShareCopied] = useState(false);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    setLoading(true);
    fetch(`${API_BASE}/api/v1/profile/tipper/${encodeURIComponent(address)}`)
      .then((r) => {
        if (!r.ok) throw new Error("Tipper profile request failed");
        return r.json();
      })
      .then((data) => {
        if (!cancelled) setProfile(data);
      })
      .catch(() => {
        if (!cancelled) setProfile(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  useEffect(() => {
    if (!profile) return;
    const title = `${profileLabel(profile)} on Teep`;
    const description = profile.tipCount > 0
      ? `${profileLabel(profile)} has tipped $${formatUsdRaw(profile.totalSent)} across ${profile.tipCount} creator support moment${profile.tipCount === 1 ? "" : "s"} on Teep.`
      : "A public Teep tipper profile.";
    const url = `${RECEIPT_BASE_URL}/tipper/${address || profile.address || ""}`;
    const prevTitle = document.title;
    document.title = title;
    setMeta("og:title", title);
    setMeta("og:description", description);
    setMeta("og:url", url);
    setMeta("og:type", "profile");
    setMeta("twitter:card", "summary");
    setMeta("twitter:title", title);
    setMeta("twitter:description", description);
    return () => {
      document.title = prevTitle;
    };
  }, [profile, address]);

  const profileUrl = `${RECEIPT_BASE_URL}/tipper/${address || profile?.address || ""}`;
  const totalUsd = profile ? formatUsdRaw(profile.totalSent) : "0.00";
  const creators = profile?.creatorsSupported || [];
  const recentTips = profile?.recentTips || [];
  const visibleCreators = creators.slice(0, 5);
  const visibleRecentTips = recentTips.slice(0, 5);
  const verifiedCreators = creators.filter((creator) => creator.isVerified || creator.claimStatus === "verified" || creator.claimStatus === "claim_wallet_active").length;
  const displayName = profile ? profileLabel(profile) : "Tipper";
  const topCreator = creators[0];
  const topCreatorPercent = useMemo(() => {
    if (!profile || !topCreator) return 0;
    const total = Number(profile.totalSent || "0");
    const top = Number(topCreator.totalRaw || Math.round(Number(topCreator.total || "0") * 1e6));
    return total > 0 ? Math.min(100, Math.round((top / total) * 100)) : 0;
  }, [profile, topCreator]);

  const shareProfile = () => {
    navigator.clipboard?.writeText(profileUrl);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="tipper-public-page">
        <PublicHeader />
        <main className="tipper-public-shell">
          <div className="tipper-public-empty">Loading tipper profile...</div>
        </main>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="tipper-public-page">
        <PublicHeader />
        <main className="tipper-public-shell">
          <div className="tipper-public-empty">
            <span className="material-symbols-outlined" aria-hidden>person_search</span>
            <strong>Profile not found</strong>
            <p>We could not load this tipper profile.</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="tipper-public-page">
      <PublicHeader />
      <main className="tipper-public-shell">
        <aside className="tipper-public-rail" aria-label="Tipper profile context">
          <section className="tipper-public-side-card">
            <p className="tipper-public-kicker">Public profile</p>
            <h2>Backing record</h2>
            <p>A public view of creators this account has backed, receipts shared, and tips still waiting to be claimed.</p>
          </section>

          {!profile.privateActivity && topCreator ? (
            <section className="tipper-public-side-card">
              <h2><span className="material-symbols-outlined" aria-hidden>pie_chart</span>Where tips went</h2>
              <p className="tipper-public-muted">Most backed creator</p>
              <div className="tipper-public-mix-row">
                <strong>{creatorLabel(topCreator)}</strong>
                <span>{topCreatorPercent}%</span>
              </div>
              <div className="tipper-public-mix-bar" aria-hidden>
                <span style={{ width: `${topCreatorPercent}%` }} />
                <i style={{ width: `${Math.max(0, 100 - topCreatorPercent)}%` }} />
              </div>
              <div className="tipper-public-legend">
                <span><i />Leading creator</span>
                <span><i />Other creators</span>
              </div>
            </section>
          ) : null}
        </aside>

        <div className="tipper-public-main" id="overview">
          <section className="tipper-public-hero" aria-labelledby="tipper-profile-title">
            <div className="tipper-public-avatar" aria-hidden>{initials(displayName)}</div>
            <div className="tipper-public-hero-copy">
              <div className="tipper-public-name-row">
                <h1 id="tipper-profile-title">{displayName}</h1>
                <span className="tipper-public-status"><i />Active</span>
              </div>
              <p>{profile.privateActivity ? "This account keeps detailed Teep activity private." : `${profile.tipCount} tips sent across ${creators.length} creators, with receipts and claim status visible where activity is public.`}</p>
            </div>
            <button type="button" className="tipper-public-share" onClick={shareProfile}>
              <span className="material-symbols-outlined" aria-hidden>{shareCopied ? "check" : "share"}</span>
              {shareCopied ? "Copied" : "Share profile"}
            </button>
          </section>

          <section className="tipper-public-stats" aria-label="Tipper stats">
            <Stat label="Total supported" value={`$${totalUsd}`} highlight />
            <Stat label="Tips sent" value={profile.tipCount.toLocaleString()} detail={profile.tipCount > 1 ? `${Math.max(0, creators.filter((c) => (c.tipCount || 0) > 1).length)} creators tipped more than once` : undefined} />
            <Stat label="Creators supported" value={creators.length.toLocaleString()} />
            <Stat label="Thank You Received" value={(profile.thankYouReceivedCount || 0).toLocaleString()} highlight />
            <Stat label="Verified creators" value={verifiedCreators.toLocaleString()} success />
          </section>

          {profile.privateActivity ? (
            <section className="tipper-public-section">
              <div className="tipper-public-empty">
                <span className="material-symbols-outlined" aria-hidden>lock</span>
                <strong>Private activity</strong>
                <p>This tipper only exposes activity when they share a specific receipt.</p>
              </div>
            </section>
          ) : (
            <div className="tipper-public-content-grid">
              <section className="tipper-public-section" id="creators" aria-labelledby="creators-backed-title">
                <h2 id="creators-backed-title"><span className="material-symbols-outlined" aria-hidden>stars</span>Creators backed most</h2>
                {creators.length === 0 ? (
                  <div className="tipper-public-empty">No creators supported yet.</div>
                ) : (
                  <div className="tipper-public-creator-list">
                    {visibleCreators.map((creator) => (
                      <article className="tipper-public-creator-row" key={`${creator.authorId || creator.username}-${creator.total}`}>
                        <img
                          src={creatorAvatar(creator)}
                          alt=""
                          onError={(event) => avatarErrorFallback(event, creator.username || creator.authorId)}
                        />
                        <div>
                          <strong>{creatorLabel(creator)} {creator.isVerified ? <span className="material-symbols-outlined tipper-public-verified" title="Verified creator">verified</span> : null}</strong>
                          <p>${formatUsdAlreadyDollars(creator.total)} sent &middot; {(creator.tipCount || 0).toLocaleString()} tip{creator.tipCount === 1 ? "" : "s"}</p>
                        </div>
                        <ClaimStatusAction status={creator.claimStatus} username={creator.username} />
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <section className="tipper-public-section" aria-labelledby="recent-tips-title">
                <h2 id="recent-tips-title"><span className="material-symbols-outlined" aria-hidden>receipt_long</span>Recent tips</h2>
                {recentTips.length === 0 ? (
                  <div className="tipper-public-empty">No recent public tips yet.</div>
                ) : (
                  <div className="tipper-public-timeline">
                    {visibleRecentTips.map((tip) => (
                      <article className={`tipper-public-tip ${claimStatusClass(tip.claimStatus)}`} key={`${tip.txHash || tip.contentId}-${tip.timestamp}`}>
                        <i aria-hidden />
                        <div>
                          <p>
                            Tipped <strong>{tip.username ? `@${tip.username}` : "a creator"}</strong>{" "}
                            <ClaimStatusAction status={tip.claimStatus} username={tip.username} />
                          </p>
                          <small>{timeAgo(tip.timestamp)} {tip.txHash ? <> &middot; <Link to={`/tx/${tip.txHash}`}>Receipt</Link></> : null}</small>
                        </div>
                        <strong className="tipper-public-tip-amount">${formatUsdAlreadyDollars(tip.amount)}</strong>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function PublicHeader() {
  return (
    <header className="tipper-public-header">
      <Link to="/" className="tipper-public-logo">
        <img src="/logo.svg" alt="" width={32} height={32} />
        <span>Teep</span>
      </Link>
      <Link to="/dashboard" className="tipper-public-launch">Launch App</Link>
    </header>
  );
}

function Stat({ label, value, detail, highlight, success }: { label: string; value: string; detail?: string; highlight?: boolean; success?: boolean }) {
  return (
    <div className="tipper-public-stat">
      <span>{label}</span>
      <strong className={success ? "is-success" : highlight ? "is-highlight" : undefined}>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function ClaimStatusAction({ status, username }: { status?: ClaimStatus; username?: string | null }) {
  const isClaimed = status === "verified" || status === "claim_wallet_active";
  if (isClaimed || !username) {
    return <span className={`tipper-public-pill ${claimStatusClass(status)}`}>{claimStatusLabel(status)}</span>;
  }

  return (
    <a
      className="tipper-public-claim-action"
      href={inviteToClaimUrl(username)}
      target="_blank"
      rel="noreferrer"
    >
      Invite to claim
    </a>
  );
}

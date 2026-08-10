import { useCallback, useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import CreatorDashboardShell from "../components/CreatorDashboardShell";
import { API_BASE, WEB_APP_URL } from "../config";
import { useDashboardLiveUpdates } from "../hooks/useDashboardLiveUpdates";
import { conditionLabel, creatorOfferXIntentUrl, offerTypeLabel, statusLabel, type CreatorOffer } from "../lib/creatorOffers";
import { privyAuthorizedFetch } from "../lib/privyApi";

type OfferFilter = "ACTIVE" | "SCHEDULED" | "DRAFT" | "PAUSED" | "PAST";

type OfferAnalytics = {
  qualifyingSupporters: number;
  qualifyingTips: number;
  totalQualifyingUsd: string;
  averageQualifyingUsd: string;
};

type OfferForm = {
  name: string;
  description: string;
  offerType: CreatorOffer["offerType"];
  conditionType: CreatorOffer["condition"]["type"];
  thresholdUsd: string;
  postId: string;
  limited: boolean;
  maxClaims: string;
  startsAt: string;
  endsAt: string;
  claimWindowDays: string;
  visibility: CreatorOffer["visibility"];
  fulfillmentType: CreatorOffer["fulfillmentType"];
  protectedUrl: string;
  sharedCode: string;
  instructions: string;
};

const EMPTY_FORM: OfferForm = {
  name: "",
  description: "",
  offerType: "ACCESS",
  conditionType: "SINGLE_TIP_MINIMUM",
  thresholdUsd: "5.00",
  postId: "",
  limited: false,
  maxClaims: "10",
  startsAt: "",
  endsAt: "",
  claimWindowDays: "",
  visibility: "PUBLIC",
  fulfillmentType: "PROTECTED_LINK",
  protectedUrl: "",
  sharedCode: "",
  instructions: "",
};

function toLocalInput(value: number) {
  const date = new Date(value - new Date().getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function formatDate(value: number | null) {
  if (!value) return "No end date";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function amountInputFromRaw(value: string) {
  const raw = BigInt(value || "0");
  const fraction = (raw % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${raw / 1_000_000n}.${fraction}` : String(raw / 1_000_000n);
}

function formFromOffer(offer: CreatorOffer): OfferForm {
  return {
    name: offer.name,
    description: offer.description,
    offerType: offer.offerType,
    conditionType: offer.condition.type,
    thresholdUsd: offer.condition.thresholdUsd,
    postId: offer.condition.postId || "",
    limited: offer.inventory.maximum !== null,
    maxClaims: String(offer.inventory.maximum || 10),
    startsAt: toLocalInput(offer.startsAt),
    endsAt: offer.endsAt ? toLocalInput(offer.endsAt) : "",
    claimWindowDays: offer.claimWindowSeconds ? String(Math.max(1, Math.round(offer.claimWindowSeconds / 86_400))) : "",
    visibility: offer.visibility,
    fulfillmentType: offer.fulfillmentType,
    protectedUrl: "",
    sharedCode: "",
    instructions: "",
  };
}

function codesFromCsv(text: string) {
  return text.split(/\r?\n/).map((line) => {
    const clean = line.trim();
    if (!clean) return "";
    if (clean.startsWith('"')) {
      const match = clean.match(/^"((?:[^"]|"")*)"/);
      return (match?.[1] || "").split('""').join('"').trim();
    }
    return clean.split(",", 1)[0].trim();
  }).filter((code, index) => code && !(index === 0 && code.toLowerCase() === "code")).join("\n");
}

export default function CreatorOffers() {
  const { getAccessToken } = usePrivy();
  const { client: smartWalletClient } = useSmartWallets();
  const address = (smartWalletClient?.account?.address || "").toLowerCase();
  const [offers, setOffers] = useState<CreatorOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState<OfferFilter>("ACTIVE");
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<OfferForm>(EMPTY_FORM);
  const [editingOffer, setEditingOffer] = useState<CreatorOffer | null>(null);
  const [replaceDelivery, setReplaceDelivery] = useState(false);
  const [saving, setSaving] = useState(false);
  const [codesOffer, setCodesOffer] = useState<CreatorOffer | null>(null);
  const [codes, setCodes] = useState("");
  const [generateCount, setGenerateCount] = useState("10");
  const [detailOffer, setDetailOffer] = useState<CreatorOffer | null>(null);
  const [analytics, setAnalytics] = useState<OfferAnalytics | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [archiveOffer, setArchiveOffer] = useState<CreatorOffer | null>(null);
  const loadOffers = useCallback((withLoader = false) => {
    if (!address) return;
    if (withLoader) setLoading(true);
    privyAuthorizedFetch(getAccessToken, `${API_BASE}/offers/creator/${address}`, { headers: { Accept: "application/json" } })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "Could not load creator offers.");
        setOffers(Array.isArray(payload.offers) ? payload.offers : []);
        setError("");
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load creator offers."))
      .finally(() => setLoading(false));
  }, [address, getAccessToken]);

  useEffect(() => loadOffers(true), [loadOffers]);
  useDashboardLiveUpdates(address, loadOffers);

  const authorizedPost = useCallback(async (path: string, body: Record<string, unknown> = {}) => {
    const response = await privyAuthorizedFetch(getAccessToken, `${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "The offer could not be updated.");
    return payload;
  }, [getAccessToken]);

  const visibleOffers = useMemo(() => offers.filter((offer) => {
    if (filter === "ACTIVE") return offer.status === "ACTIVE";
    if (filter === "SCHEDULED") return offer.status === "SCHEDULED";
    if (filter === "DRAFT") return offer.status === "DRAFT";
    if (filter === "PAUSED") return offer.status === "PAUSED";
    if (filter === "PAST") return ["CLAIMED_OUT", "ENDED", "ARCHIVED"].includes(offer.status);
    return false;
  }), [filter, offers]);

  const filterItems = useMemo<OfferFilter[]>(() => [
    "ACTIVE",
    "SCHEDULED",
    "DRAFT",
    ...(offers.some((offer) => offer.status === "PAUSED") ? ["PAUSED" as const] : []),
    "PAST",
  ], [offers]);

  useEffect(() => {
    if (filter === "PAUSED" && !offers.some((offer) => offer.status === "PAUSED")) setFilter("ACTIVE");
  }, [filter, offers]);

  const totals = useMemo(() => ({
    active: offers.filter((offer) => offer.status === "ACTIVE").length,
    // claimsReserved is the lifetime unlock count; claimed entitlements remain included.
    unlocked: offers.reduce((sum, offer) => sum + offer.inventory.reserved, 0),
    claimed: offers.reduce((sum, offer) => sum + offer.inventory.claimed, 0),
  }), [offers]);
  const offerTermsLocked = Boolean(editingOffer && editingOffer.inventory.reserved > 0);

  const submitOffer = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await privyAuthorizedFetch(getAccessToken, `${API_BASE}/offers/creator/${address}${editingOffer ? `/${editingOffer.id}` : ""}`, {
        method: editingOffer ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offer: {
            name: form.name,
            description: form.description,
            offerType: offerTermsLocked ? editingOffer!.offerType : form.offerType,
            visibility: form.visibility,
            conditionType: offerTermsLocked ? editingOffer!.condition.type : form.conditionType,
            thresholdUsd: offerTermsLocked ? amountInputFromRaw(editingOffer!.condition.amountRaw) : form.thresholdUsd,
            postId: offerTermsLocked
              ? editingOffer!.condition.postId || undefined
              : form.conditionType === "SPECIFIC_X_POST_MINIMUM" ? form.postId : undefined,
            maxClaims: form.limited ? Number(form.maxClaims) : null,
            onePerSupporter: offerTermsLocked ? editingOffer!.onePerSupporter : true,
            startsAt: offerTermsLocked
              ? editingOffer!.startsAt
              : form.startsAt ? new Date(form.startsAt).toISOString() : Date.now(),
            endsAt: offerTermsLocked && editingOffer?.endsAt && form.endsAt === toLocalInput(editingOffer.endsAt)
              ? editingOffer.endsAt
              : form.endsAt ? new Date(form.endsAt).toISOString() : null,
            claimWindowSeconds: offerTermsLocked
              ? editingOffer!.claimWindowSeconds
              : form.claimWindowDays ? Number(form.claimWindowDays) * 86_400 : null,
            ...(!editingOffer || replaceDelivery ? { fulfillment: {
              type: form.fulfillmentType,
              protectedUrl: form.protectedUrl || null,
              sharedCode: form.sharedCode || null,
              instructions: form.instructions || null,
            } } : {}),
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not create this offer.");
      setFormOpen(false);
      setForm(EMPTY_FORM);
      setEditingOffer(null);
      setReplaceDelivery(false);
      setNotice(editingOffer ? "Offer changes saved." : "Offer saved as a draft. Review it, then activate it when you are ready.");
      loadOffers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create this offer.");
    } finally {
      setSaving(false);
    }
  };

  const openCreate = () => {
    setEditingOffer(null);
    setReplaceDelivery(false);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  };

  const openEdit = (offer: CreatorOffer) => {
    setEditingOffer(offer);
    setReplaceDelivery(false);
    setForm(formFromOffer(offer));
    setFormOpen(true);
  };

  const duplicateOffer = (offer: CreatorOffer) => {
    setEditingOffer(null);
    setReplaceDelivery(false);
    setForm({
      ...formFromOffer(offer),
      name: `${offer.name} copy`.slice(0, 100),
      startsAt: "",
      endsAt: "",
      protectedUrl: "",
      sharedCode: "",
      instructions: "",
    });
    setFormOpen(true);
  };

  const confirmArchive = async () => {
    if (!archiveOffer) return;
    const offer = archiveOffer;
    setArchiveOffer(null);
    await updateStatus(offer, "archive");
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingOffer(null);
    setReplaceDelivery(false);
    setForm(EMPTY_FORM);
  };

  const updateStatus = async (offer: CreatorOffer, action: "activate" | "pause" | "archive") => {
    setError("");
    setNotice("");
    try {
      await authorizedPost(`/offers/creator/${address}/${offer.id}/${action}`);
      setNotice(action === "activate" ? "Offer is ready for supporters." : action === "pause" ? "New unlocks are paused." : "Offer archived.");
      loadOffers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The offer could not be updated.");
    }
  };

  const importCodes = async () => {
    if (!codesOffer) return;
    setSaving(true);
    try {
      await authorizedPost(`/offers/creator/${address}/${codesOffer.id}/codes`, { codes });
      setNotice("Unique codes added securely.");
      setCodesOffer(null);
      setCodes("");
      loadOffers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Codes could not be added.");
    } finally {
      setSaving(false);
    }
  };

  const generateCodes = async () => {
    if (!codesOffer) return;
    setSaving(true);
    try {
      await authorizedPost(`/offers/creator/${address}/${codesOffer.id}/codes/generate`, { count: Number(generateCount) });
      setNotice("Codes generated. Export them and configure them on the service where supporters will redeem them.");
      setCodesOffer(null);
      loadOffers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Codes could not be generated.");
    } finally {
      setSaving(false);
    }
  };

  const loadCodeFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 1_000_000) {
      setError("Code files must be 1 MB or smaller.");
      return;
    }
    setCodes(codesFromCsv(await file.text()));
  };

  const exportCodes = async () => {
    if (!codesOffer) return;
    setSaving(true);
    setError("");
    try {
      const response = await privyAuthorizedFetch(getAccessToken, `${API_BASE}/offers/creator/${address}/${codesOffer.id}/codes/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Codes could not be exported.");
      }
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || "teep-offer-codes.csv";
      anchor.click();
      URL.revokeObjectURL(href);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Codes could not be exported.");
    } finally {
      setSaving(false);
    }
  };

  const openDetails = async (offer: CreatorOffer) => {
    setDetailOffer(offer);
    setAnalytics(null);
    setDetailsLoading(true);
    setError("");
    try {
      const response = await privyAuthorizedFetch(getAccessToken, `${API_BASE}/offers/creator/${address}/${offer.id}`, { headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not load the offer report.");
      setDetailOffer(payload.offer || offer);
      setAnalytics(payload.analytics || null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load the offer report.");
    } finally {
      setDetailsLoading(false);
    }
  };

  return (
    <CreatorDashboardShell title="Offers">
      <main className={`creator-offers-page ${offers.length ? "has-offers" : "is-empty"}`}>
        <header className="creator-offers-head">
          <div>
            <h1>Give supporters something meaningful to unlock.</h1>
            <p>Reward qualifying tips with private access, links, codes, or other perks you provide.</p>
          </div>
          <button className="btn-primary" type="button" onClick={openCreate}>
            <span className="material-symbols-outlined" aria-hidden>add</span>
            Create offer
          </button>
        </header>

        <section className="creator-offers-summary" aria-label="Offer funnel summary">
          <div aria-label={`${totals.active} offers currently accepting qualifying tips`}><span className="material-symbols-outlined" aria-hidden>campaign</span><small>Active offers</small><strong>{totals.active}</strong></div>
          <div aria-label={`${totals.unlocked} supporter entitlements unlocked`}><span className="material-symbols-outlined" aria-hidden>lock_open</span><small>Unlocks</small><strong>{totals.unlocked}</strong></div>
          <div aria-label={`${totals.claimed} rewards retrieved by supporters`}><span className="material-symbols-outlined" aria-hidden>redeem</span><small>Claims</small><strong>{totals.claimed}</strong></div>
        </section>
        <p className="creator-offers-funnel-note"><span className="material-symbols-outlined" aria-hidden>info</span>A qualifying tip creates an unlock. A claim means the supporter retrieved the reward.</p>

        {(error || notice) && <div className={`creator-offers-feedback ${error ? "is-error" : "is-success"}`} role={error ? "alert" : "status"}>
          <span className="material-symbols-outlined" aria-hidden>{error ? "error" : "check_circle"}</span>
          {error || notice}
        </div>}

        <section className="creator-offers-list-section">
          <div className="creator-offers-toolbar">
            <div><h2>Your offers</h2><p>Draft, schedule, pause, and review supporter activity.</p></div>
            <div className="creator-offers-filters" aria-label="Filter offers">
              {filterItems.map((item) => (
                <button type="button" className={filter === item ? "is-active" : ""} onClick={() => setFilter(item)} key={item}>
                  {item === "DRAFT" ? "Drafts" : item.charAt(0) + item.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="creator-offers-empty"><span className="creator-offers-spinner" /><strong>Loading your offers</strong></div>
          ) : visibleOffers.length === 0 ? (
            <div className="creator-offers-empty">
              <span className="material-symbols-outlined" aria-hidden>redeem</span>
              <strong>{offers.length ? `No ${filter.toLowerCase()} offers` : "Create your first offer"}</strong>
              <p>{offers.length ? "Choose another campaign state or create a new offer." : "Give your next supporter a clear reason to tip and something useful to claim."}</p>
              <button className="btn-primary" type="button" onClick={openCreate}>{offers.length ? "Create new offer" : "Create offer"}</button>
            </div>
          ) : (
            <div className="creator-offers-grid">
              {visibleOffers.map((offer) => (
                <article className="creator-offer-card" key={offer.id}>
                  <div className="creator-offer-card-head">
                    <span className={`creator-offer-icon type-${offer.offerType.toLowerCase()}`}><span className="material-symbols-outlined" aria-hidden>{offer.offerType === "CODE" ? "confirmation_number" : offer.offerType === "LINK" ? "link" : offer.offerType === "CUSTOM" ? "tune" : "key"}</span></span>
                    <div><span>{offerTypeLabel(offer.offerType)}</span><h3>{offer.name}</h3></div>
                    <span className={`creator-offer-status status-${offer.status.toLowerCase()}`}>{statusLabel(offer.status)}</span>
                  </div>
                  <p>{offer.description}</p>
                  <dl>
                    <div><dt>Unlocks with</dt><dd>{conditionLabel(offer)}</dd></div>
                    <div className="creator-offer-availability"><dt>Availability</dt><dd>{offer.inventory.maximum == null ? "Unlimited" : `${offer.inventory.remaining} of ${offer.inventory.maximum} left`}</dd>{offer.inventory.maximum !== null && <span className="creator-offer-progress" role="progressbar" aria-label={`${offer.inventory.reserved} of ${offer.inventory.maximum} offers unlocked`} aria-valuemin={0} aria-valuemax={offer.inventory.maximum} aria-valuenow={offer.inventory.reserved}><span style={{ width: `${Math.min(100, (offer.inventory.reserved / Math.max(1, offer.inventory.maximum)) * 100)}%` }} /></span>}</div>
                    <div><dt>Claims</dt><dd>{offer.inventory.reserved} unlocked · {offer.inventory.claimed} claimed</dd></div>
                    <div><dt>Ends</dt><dd>{formatDate(offer.endsAt)}</dd></div>
                  </dl>
                  <div className="creator-offer-actions">
                    <button className="btn-primary creator-offer-report-action" type="button" onClick={() => void openDetails(offer)}><span className="material-symbols-outlined" aria-hidden>analytics</span>View report</button>
                    {offer.status === "ACTIVE" && <a
                      className="btn-secondary creator-offer-share-action"
                      href={creatorOfferXIntentUrl({
                        creatorUsername: offer.creator.username,
                        name: offer.name,
                        visibility: offer.visibility,
                        conditionType: offer.condition.type,
                        thresholdUsd: offer.condition.thresholdUsd,
                        webAppUrl: WEB_APP_URL,
                      })}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Share ${offer.visibility === "PUBLIC" ? offer.name : "this private supporter offer"} on X`}
                    ><span className="creator-offer-x-mark" aria-hidden>𝕏</span><span>Share to X</span></a>}
                    <details className="creator-offer-manage">
                      <summary><span className="material-symbols-outlined" aria-hidden>tune</span>Manage<span className="material-symbols-outlined creator-offer-manage-chevron" aria-hidden>expand_more</span></summary>
                      <div className="creator-offer-manage-menu">
                        {!["ARCHIVED", "ENDED", "CLAIMED_OUT"].includes(offer.status) && <button type="button" onClick={() => openEdit(offer)}><span className="material-symbols-outlined" aria-hidden>edit</span>Edit details</button>}
                        <button type="button" onClick={() => duplicateOffer(offer)}><span className="material-symbols-outlined" aria-hidden>content_copy</span>Duplicate offer</button>
                        {offer.fulfillmentType === "UNIQUE_CODE" && <button type="button" onClick={() => setCodesOffer(offer)}><span className="material-symbols-outlined" aria-hidden>inventory_2</span>Codes ({offer.inventory.availableCodes || 0} ready)</button>}
                        {(["DRAFT", "PAUSED", "SCHEDULED"].includes(offer.status)) && <button type="button" onClick={() => updateStatus(offer, "activate")}><span className="material-symbols-outlined" aria-hidden>play_arrow</span>{offer.status === "PAUSED" ? "Resume offer" : "Activate offer"}</button>}
                        {(["ACTIVE", "SCHEDULED"].includes(offer.status)) && <button type="button" onClick={() => updateStatus(offer, "pause")}><span className="material-symbols-outlined" aria-hidden>pause</span>Pause offer</button>}
                        {offer.status !== "ARCHIVED" && <button className="is-danger" type="button" onClick={() => setArchiveOffer(offer)}><span className="material-symbols-outlined" aria-hidden>archive</span>Archive offer</button>}
                      </div>
                    </details>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      {archiveOffer && (
        <div className="creator-offer-modal" role="presentation">
          <button className="creator-offer-modal-backdrop" type="button" aria-label="Cancel archive" onClick={() => setArchiveOffer(null)} />
          <section className="creator-offer-modal-card creator-offer-confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="archive-offer-title" aria-describedby="archive-offer-description">
            <header><div><span>Archive offer</span><h2 id="archive-offer-title">Remove {archiveOffer.name} from active management?</h2></div><button type="button" aria-label="Close" onClick={() => setArchiveOffer(null)}><span className="material-symbols-outlined">close</span></button></header>
            <div className="creator-offer-form-body"><p id="archive-offer-description" className="creator-offer-confirm-copy"><span className="material-symbols-outlined" aria-hidden>info</span><span>Archiving stops future unlocks and moves this campaign to Past. Existing supporter entitlements remain protected.</span></p></div>
            <footer><button className="btn-secondary" type="button" onClick={() => setArchiveOffer(null)}>Keep offer</button><button className="btn-danger" type="button" onClick={() => void confirmArchive()}><span className="material-symbols-outlined" aria-hidden>archive</span>Archive offer</button></footer>
          </section>
        </div>
      )}

      {formOpen && (
        <div className="creator-offer-modal" role="presentation">
          <button className="creator-offer-modal-backdrop" type="button" aria-label="Close offer editor" onClick={closeForm} />
          <form className="creator-offer-modal-card" onSubmit={submitOffer} role="dialog" aria-modal="true" aria-labelledby="create-offer-title">
            <header><div><span>{editingOffer ? "Edit offer" : "Create offer"}</span><h2 id="create-offer-title">{editingOffer ? "Update the public offer details" : "What should supporters unlock?"}</h2></div><button type="button" aria-label="Close" onClick={closeForm}><span className="material-symbols-outlined">close</span></button></header>
            <div className="creator-offer-form-body">
              <label><span>Offer name</span><input required maxLength={100} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Private community access" /></label>
              <label><span>Short description</span><textarea required maxLength={280} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Tell supporters what they will receive." /></label>
              <div className="creator-offer-form-grid">
                <label><span>Offer type</span><select disabled={offerTermsLocked} value={form.offerType} onChange={(event) => setForm({ ...form, offerType: event.target.value as CreatorOffer["offerType"] })}><option value="ACCESS">Access</option><option value="LINK">Private link</option><option value="CODE">Coupon or code</option><option value="CUSTOM">Custom</option></select></label>
                <label><span>Unlock rule</span><select disabled={offerTermsLocked} value={form.conditionType} onChange={(event) => setForm({ ...form, conditionType: event.target.value as CreatorOffer["condition"]["type"] })}><option value="SINGLE_TIP_MINIMUM">One tip reaches amount</option><option value="CUMULATIVE_TIPS_MINIMUM">Support over time reaches amount</option><option value="SPECIFIC_X_POST_MINIMUM">Tip on a specific X post</option></select></label>
                <label><span>Amount to unlock (USD)</span><input disabled={offerTermsLocked} required type="number" min="0.01" step="0.01" value={form.thresholdUsd} onChange={(event) => setForm({ ...form, thresholdUsd: event.target.value })} /></label>
                {form.conditionType === "SPECIFIC_X_POST_MINIMUM" && <label><span>X post ID</span><input disabled={offerTermsLocked} required inputMode="numeric" value={form.postId} onChange={(event) => setForm({ ...form, postId: event.target.value.replace(/\D/g, "") })} placeholder="Numbers at the end of the post URL" /></label>}
              </div>
              <fieldset><legend>Availability</legend><label className="creator-offer-check"><input type="checkbox" disabled={offerTermsLocked && editingOffer?.inventory.maximum === null} checked={form.limited} onChange={(event) => setForm({ ...form, limited: event.target.checked })} /><span>Limit this to the first supporters</span></label>{form.limited && <label><span>Maximum supporters</span><input type="number" min={Math.max(1, editingOffer?.inventory.reserved || 1)} value={form.maxClaims} onChange={(event) => setForm({ ...form, maxClaims: event.target.value })} /></label>}</fieldset>
              <div className="creator-offer-form-grid">
                <label><span>Start</span><input disabled={offerTermsLocked} type="datetime-local" min={editingOffer ? undefined : toLocalInput(Date.now())} value={form.startsAt} onChange={(event) => setForm({ ...form, startsAt: event.target.value })} /></label>
                <label><span>End (optional)</span><input disabled={offerTermsLocked && editingOffer?.endsAt === null} type="datetime-local" min={offerTermsLocked && editingOffer?.endsAt ? toLocalInput(editingOffer.endsAt) : undefined} value={form.endsAt} onChange={(event) => setForm({ ...form, endsAt: event.target.value })} /></label>
                <label><span>Days to claim (optional)</span><input disabled={offerTermsLocked} type="number" min="1" value={form.claimWindowDays} onChange={(event) => setForm({ ...form, claimWindowDays: event.target.value })} placeholder="No expiry" /></label>
                <label><span>Visibility</span><select value={form.visibility} onChange={(event) => setForm({ ...form, visibility: event.target.value as CreatorOffer["visibility"] })}><option value="PUBLIC">Show on public profile</option><option value="HIDDEN">Only share directly</option></select></label>
              </div>
              {offerTermsLocked && <p className="creator-offer-form-note"><span className="material-symbols-outlined">verified_user</span>Supporters have already qualified. You can improve the public copy, increase availability, extend an existing end date, or pause the offer; their earned unlock rule and private delivery stay protected.</p>}
              <fieldset><legend>What they receive</legend>{editingOffer && !offerTermsLocked && <label className="creator-offer-check"><input type="checkbox" checked={replaceDelivery} onChange={(event) => setReplaceDelivery(event.target.checked)} /><span>Replace the private delivery details</span></label>}{(!editingOffer || replaceDelivery) ? <><label><span>Delivery method</span><select value={form.fulfillmentType} onChange={(event) => setForm({ ...form, fulfillmentType: event.target.value as CreatorOffer["fulfillmentType"] })}><option value="PROTECTED_LINK">Private link</option><option value="SHARED_CODE">Shared code</option><option value="UNIQUE_CODE">A different code for each person</option><option value="INSTRUCTIONS">Private instructions</option><option value="CUSTOM">Link, code, and instructions</option></select></label>{(["PROTECTED_LINK", "CUSTOM"].includes(form.fulfillmentType)) && <label><span>Private destination</span><input type="url" required={form.fulfillmentType === "PROTECTED_LINK"} value={form.protectedUrl} onChange={(event) => setForm({ ...form, protectedUrl: event.target.value })} placeholder="https://..." /></label>}{(["SHARED_CODE", "CUSTOM"].includes(form.fulfillmentType)) && <label><span>Shared code</span><input required={form.fulfillmentType === "SHARED_CODE"} value={form.sharedCode} onChange={(event) => setForm({ ...form, sharedCode: event.target.value })} /></label>}{(["INSTRUCTIONS", "CUSTOM"].includes(form.fulfillmentType)) && <label><span>Private instructions</span><textarea required={form.fulfillmentType === "INSTRUCTIONS"} value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} /></label>}{form.fulfillmentType === "UNIQUE_CODE" && <p className="creator-offer-form-note"><span className="material-symbols-outlined">info</span>Save the draft first, then add or generate its unique codes before activation.</p>}</> : <p className="creator-offer-form-note"><span className="material-symbols-outlined">lock</span>Your current private delivery details stay encrypted and unchanged.</p>}</fieldset>
            </div>
            <footer><button className="btn-secondary" type="button" onClick={closeForm}>Cancel</button><button className="btn-primary" type="submit" disabled={saving}>{saving ? "Saving…" : editingOffer ? "Save changes" : "Save draft"}</button></footer>
          </form>
        </div>
      )}

      {codesOffer && (
        <div className="creator-offer-modal" role="presentation">
          <button className="creator-offer-modal-backdrop" type="button" aria-label="Close code inventory" onClick={() => setCodesOffer(null)} />
          <section className="creator-offer-modal-card creator-offer-code-modal" role="dialog" aria-modal="true" aria-labelledby="offer-codes-title">
            <header><div><span>Code inventory</span><h2 id="offer-codes-title">{codesOffer.name}</h2></div><button type="button" aria-label="Close" onClick={() => setCodesOffer(null)}><span className="material-symbols-outlined">close</span></button></header>
            <div className="creator-offer-form-body"><p>Each qualifying supporter gets one reserved code. Codes remain private until claimed.</p><label><span>Paste codes, one per line</span><textarea rows={7} value={codes} onChange={(event) => setCodes(event.target.value)} placeholder={'WELCOME-001\nWELCOME-002'} /></label><label className="creator-offer-file"><span className="material-symbols-outlined" aria-hidden>upload_file</span><span>Load a CSV or text file</span><input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => void loadCodeFile(event.target.files?.[0])} /></label><button className="btn-primary" type="button" disabled={saving || !codes.trim()} onClick={importCodes}>Add codes</button><div className="creator-offer-code-divider"><span>or</span></div><div className="creator-offer-generate"><label><span>Generate secure codes</span><input type="number" min="1" max="1000" value={generateCount} onChange={(event) => setGenerateCount(event.target.value)} /></label><button className="btn-secondary" type="button" disabled={saving} onClick={generateCodes}>Generate</button></div><button className="btn-secondary creator-offer-export" type="button" disabled={saving || !codesOffer.inventory.availableCodes} onClick={exportCodes}><span className="material-symbols-outlined" aria-hidden>download</span>Export code inventory</button><p className="creator-offer-form-note"><span className="material-symbols-outlined">warning</span>Teep-generated codes must also be configured on the external service where supporters will use them.</p></div>
          </section>
        </div>
      )}

      {detailOffer && (
        <div className="creator-offer-modal" role="presentation">
          <button className="creator-offer-modal-backdrop" type="button" aria-label="Close offer report" onClick={() => setDetailOffer(null)} />
          <section className="creator-offer-modal-card creator-offer-report-modal" role="dialog" aria-modal="true" aria-labelledby="offer-report-title">
            <header><div><span>Offer report</span><h2 id="offer-report-title">{detailOffer.name}</h2></div><button type="button" aria-label="Close" onClick={() => setDetailOffer(null)}><span className="material-symbols-outlined">close</span></button></header>
            <div className="creator-offer-form-body">
              {detailsLoading ? <div className="creator-offers-empty"><span className="creator-offers-spinner" /><strong>Loading report</strong></div> : <>
                <div className="creator-offer-report-grid"><div><span>Supporters qualified</span><strong>{analytics?.qualifyingSupporters || 0}</strong></div><div><span>Qualifying tips</span><strong>{analytics?.qualifyingTips || 0}</strong></div><div><span>Value from qualifying tips</span><strong>${Number(analytics?.totalQualifyingUsd || 0).toFixed(2)}</strong></div><div><span>Average qualifying tip</span><strong>${Number(analytics?.averageQualifyingUsd || 0).toFixed(2)}</strong></div></div>
                <dl className="creator-offer-report-terms"><div><dt>Status</dt><dd>{statusLabel(detailOffer.status)}</dd></div><div><dt>Unlock rule</dt><dd>{conditionLabel(detailOffer)}</dd></div><div><dt>Claims</dt><dd>{detailOffer.inventory.reserved} unlocked · {detailOffer.inventory.claimed} claimed</dd></div><div><dt>Availability</dt><dd>{detailOffer.inventory.maximum == null ? "Unlimited" : `${detailOffer.inventory.remaining} remaining`}</dd></div><div><dt>Started</dt><dd>{formatDate(detailOffer.startsAt)}</dd></div><div><dt>Ends</dt><dd>{formatDate(detailOffer.endsAt)}</dd></div>{detailOffer.fulfillmentType === "UNIQUE_CODE" && <div><dt>Codes ready</dt><dd>{detailOffer.inventory.availableCodes || 0}</dd></div>}</dl>
              </>}
            </div>
          </section>
        </div>
      )}
    </CreatorDashboardShell>
  );
}

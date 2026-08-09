import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { usePrivy } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import CreatorDashboardShell from "../components/CreatorDashboardShell";
import { API_BASE } from "../config";
import { arcTestnet } from "../chains";

type PositionControl = "add" | "withdraw_partial" | "withdraw_all";
type StrategyAvailabilityFilter = "all" | "live" | "preview" | "paused";
type StrategyRiskFilter = "all" | "low" | "medium" | "high";
type StrategyAccessFilter = "all" | "fast" | "moderate" | "longer";
type StrategyActivityFilter = "all" | "using" | "not_using";
type StrategySort = "recommended" | "risk" | "access" | "rate";

type StrategyEvidence = {
  participantCount: number;
  yieldPaidRaw: string;
  updatedAt: number;
  participants: Array<{ displayName: string; profileImageUrl: string | null }>;
};

type GrowOption = {
  id: string;
  name: string;
  plainName?: string;
  description: string;
  provider: string;
  status: "preview" | "pending_provider" | "ready" | "disabled";
  availability?: "live" | "preview" | "paused";
  accessCategory?: "fast" | "moderate" | "longer";
  sourceChainName: string;
  destinationChainName?: string;
  assetSymbol: string;
  estimatedApy: number | null;
  riskLevel: "low" | "medium" | "high";
  minDepositRaw: string;
  exitTimeEstimate: string;
  transactionEnabled: boolean;
  controls?: PositionControl[];
  tags: string[];
  disclosures: string[];
  icon?: string;
  bestFor?: string;
  balanceMovement?: string;
  evidence?: StrategyEvidence;
  details?: {
    objective: string;
    route: Array<{ label: string; value: string }>;
    risk: Array<{ label: string; value: string }>;
    addresses: Array<{ label: string; value: string }>;
  };
};

type GrowSummary = {
  mode: string;
  transactionEnabled: boolean;
  strategyCount: number;
  readyStrategyCount: number;
  guardrails: string[];
};

type GrowPosition = {
  id: string;
  strategyId: string;
  status?: string;
  principalRaw: string;
  currentValueRaw: string;
  yieldEarnedRaw: string;
  chainState: string;
  updatedAt: number;
};

type GrowActivity = {
  id: string;
  timestamp: number;
  action: "grow" | "yield" | "withdraw" | "details" | "watch";
  strategyId: string;
  strategyName: string;
  amountRaw: string;
  direction: "in" | "out" | "neutral";
  status: "preview" | "pending" | "complete" | "failed";
  txHash?: string;
  detail?: string;
};

const EMPTY_SUMMARY: GrowSummary = {
  mode: "unavailable",
  transactionEnabled: false,
  strategyCount: 0,
  readyStrategyCount: 0,
  guardrails: [],
};

function raw(value: string | number | bigint | null | undefined) {
  try {
    return BigInt(String(value ?? "0").split(".")[0] || "0");
  } catch {
    return 0n;
  }
}

function money(value: string | number | bigint | null | undefined) {
  const amount = raw(value);
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${sign}$${Number(whole).toLocaleString()}.${fraction}`;
}

function percent(numerator: bigint, denominator: bigint) {
  if (denominator === 0n) return "0.00%";
  return `${(Number(numerator * 10_000n / denominator) / 100).toFixed(2)}%`;
}

function inputToRaw(value: string) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{0,6})?$/.test(normalized)) return 0n;
  const [whole, fraction = ""] = normalized.split(".");
  return BigInt(whole || "0") * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function rawToInput(value: string | bigint) {
  const amount = raw(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function date(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "T";
}

function statusLabel(status: GrowOption["status"]) {
  if (status === "ready") return "Available";
  if (status === "disabled") return "Paused";
  if (status === "pending_provider") return "Opening soon";
  return "Preview";
}

function strategyLanguage(option: GrowOption) {
  if (option.bestFor && option.balanceMovement) return { bestFor: option.bestFor, movement: option.balanceMovement };
  if (option.riskLevel === "high") return { bestFor: "Tips you are unlikely to need soon", movement: "More noticeable" };
  if (option.riskLevel === "medium") return { bestFor: "Idle tips you may use later", movement: "More balanced" };
  return { bestFor: "Tips you may need again soon", movement: "Usually smaller" };
}

function strategyName(option: GrowOption | undefined, fallback = "Growth position") {
  return option?.plainName || option?.name || fallback;
}

function strategyAvailability(option: GrowOption) {
  return option.availability || (option.status === "ready" ? "live" : option.status === "disabled" ? "paused" : "preview");
}

function strategyAccess(option: GrowOption) {
  if (option.accessCategory) return option.accessCategory;
  const access = option.exitTimeEstimate.toLowerCase();
  if (/longer|day|bridge|finality/.test(access)) return "longer";
  if (/moderate|hour/.test(access)) return "moderate";
  return "fast";
}

function actionLabel(action: GrowActivity["action"]) {
  if (action === "grow") return "Started growing";
  if (action === "yield") return "Service fees received";
  if (action === "withdraw") return "Funds withdrawn";
  if (action === "details") return "Viewed details";
  return "Watched strategy";
}

function actionIcon(action: GrowActivity["action"]) {
  if (action === "grow") return "add_circle";
  if (action === "yield") return "trending_up";
  if (action === "withdraw") return "download";
  if (action === "details") return "info";
  return "visibility";
}

type StrategyFilterOption<T extends string> = { value: T; label: string };

function StrategyFilterSelect<T extends string>({
  label,
  icon,
  value,
  options,
  onChange,
  className = "",
}: {
  label: string;
  icon: string;
  value: T;
  options: readonly StrategyFilterOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) || options[0];

  return <div className={`grow-live-strategy-filter${open ? " is-open" : ""}${className ? ` ${className}` : ""}`} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
    <button type="button" className="grow-live-strategy-filter-trigger" aria-label={`${label}: ${selected.label}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <span className="material-symbols-outlined">{icon}</span>
      <span><small>{label}</small><strong>{selected.label}</strong></span>
      <span className="material-symbols-outlined">{open ? "expand_less" : "expand_more"}</span>
    </button>
    {open && <div className="grow-live-strategy-filter-menu" role="listbox" aria-label={label}>
      {options.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} onClick={() => { onChange(option.value); setOpen(false); }}><span>{option.label}</span>{option.value === value && <span className="material-symbols-outlined">check</span>}</button>)}
    </div>}
  </div>;
}

export default function GrowTipsLive() {
  const { ready, authenticated, login } = usePrivy();
  const { client: smartWalletClient } = useSmartWallets();
  const address = (ready && authenticated ? smartWalletClient?.account?.address || "" : "").toLowerCase();
  const [summary, setSummary] = useState<GrowSummary>(EMPTY_SUMMARY);
  const [strategies, setStrategies] = useState<GrowOption[]>([]);
  const [positions, setPositions] = useState<GrowPosition[]>([]);
  const [activity, setActivity] = useState<GrowActivity[]>([]);
  const [availableRaw, setAvailableRaw] = useState("0");
  const [claimWalletAddress, setClaimWalletAddress] = useState("");
  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(null);
  const [detailStrategy, setDetailStrategy] = useState<GrowOption | null>(null);
  const [actionPosition, setActionPosition] = useState<GrowPosition | null>(null);
  const [actionMode, setActionMode] = useState<PositionControl>("add");
  const [actionAmount, setActionAmount] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionMessageTone, setActionMessageTone] = useState<"info" | "success" | "error">("info");
  const [loadingStrategies, setLoadingStrategies] = useState(true);
  const [loadingAccount, setLoadingAccount] = useState(true);
  const [refreshingAccount, setRefreshingAccount] = useState(false);
  const [hasAccountSnapshot, setHasAccountSnapshot] = useState(false);
  const [strategyError, setStrategyError] = useState("");
  const [accountError, setAccountError] = useState("");
  const [accountSetup, setAccountSetup] = useState<"ready" | "unverified" | "wallet_pending">("ready");
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [submittingAction, setSubmittingAction] = useState(false);
  const [availabilityFilter, setAvailabilityFilter] = useState<StrategyAvailabilityFilter>("all");
  const [riskFilter, setRiskFilter] = useState<StrategyRiskFilter>("all");
  const [accessFilter, setAccessFilter] = useState<StrategyAccessFilter>("all");
  const [activityFilter, setActivityFilter] = useState<StrategyActivityFilter>("all");
  const [strategySort, setStrategySort] = useState<StrategySort>("recommended");
  const [strategyFiltersOpen, setStrategyFiltersOpen] = useState(false);

  const loadStrategies = useCallback(async () => {
    setLoadingStrategies(true);
    setStrategyError("");
    try {
      const [summaryResponse, strategyResponse] = await Promise.all([
        fetch(`${API_BASE}/defi/summary`),
        fetch(`${API_BASE}/defi/strategies`),
      ]);
      if (!summaryResponse.ok || !strategyResponse.ok) throw new Error("Growth choices are temporarily unavailable.");
      const [summaryData, strategyData] = await Promise.all([summaryResponse.json(), strategyResponse.json()]);
      setSummary(summaryData);
      setStrategies(Array.isArray(strategyData?.strategies) ? strategyData.strategies : []);
    } catch (error) {
      setSummary(EMPTY_SUMMARY);
      setStrategies([]);
      setStrategyError(error instanceof Error ? error.message : "Growth choices are temporarily unavailable.");
    } finally {
      setLoadingStrategies(false);
    }
  }, []);

  const loadAccount = useCallback(async () => {
    if (!address) {
      setPositions([]);
      setActivity([]);
      setAvailableRaw("0");
      setClaimWalletAddress("");
      setLoadingAccount(false);
      setRefreshingAccount(false);
      setHasAccountSnapshot(false);
      setAccountSetup("ready");
      return;
    }
    const isBackgroundRefresh = hasAccountSnapshot;
    if (isBackgroundRefresh) setRefreshingAccount(true);
    else setLoadingAccount(true);
    setAccountError("");
    try {
      const eligibilityResponse = await fetch(`${API_BASE}/api/v1/wallet/${address}/eligibility`);
      if (!eligibilityResponse.ok) throw new Error("Your creator status could not be refreshed.");
      const eligibility = await eligibilityResponse.json();
      if (!eligibility?.hasVerifiedClaim) {
        setAccountSetup("unverified");
        setPositions([]);
        setActivity([]);
        setAvailableRaw("0");
        setClaimWalletAddress("");
        setHasAccountSnapshot(false);
        return;
      }
      if (!eligibility?.claimWalletDeployed) {
        setAccountSetup("wallet_pending");
        setPositions([]);
        setActivity([]);
        setAvailableRaw("0");
        setClaimWalletAddress("");
        setHasAccountSnapshot(false);
        return;
      }
      setAccountSetup("ready");
      const [balanceResponse, positionResponse, activityResponse] = await Promise.all([
        fetch(`${API_BASE}/api/v1/wallet/${address}/balance`),
        fetch(`${API_BASE}/defi/positions/${address}`),
        fetch(`${API_BASE}/defi/activity/${address}`),
      ]);
      if (!balanceResponse.ok || !positionResponse.ok || !activityResponse.ok) throw new Error("Your growth data could not be refreshed.");
      const [balanceData, positionData, activityData] = await Promise.all([
        balanceResponse.json(), positionResponse.json(), activityResponse.json(),
      ]);
      const nextPositions = Array.isArray(positionData?.positions) ? positionData.positions : [];
      setAvailableRaw(String(balanceData?.balanceRaw || "0"));
      setClaimWalletAddress(typeof balanceData?.claimWalletAddress === "string" ? balanceData.claimWalletAddress.toLowerCase() : "");
      setPositions(nextPositions);
      setActivity(Array.isArray(activityData?.records) ? activityData.records : []);
      setSelectedPositionId((current) => nextPositions.some((position: GrowPosition) => position.id === current) ? current : nextPositions[0]?.id || null);
      setHasAccountSnapshot(true);
    } catch (error) {
      if (!isBackgroundRefresh) {
        setPositions([]);
        setActivity([]);
        setClaimWalletAddress("");
        setAccountSetup("ready");
        setHasAccountSnapshot(false);
      }
      setAccountError(error instanceof Error ? error.message : "Your growth data could not be refreshed.");
    } finally {
      setLoadingAccount(false);
      setRefreshingAccount(false);
    }
  }, [address, hasAccountSnapshot]);

  useEffect(() => { void loadStrategies(); }, [loadStrategies]);
  useEffect(() => { void loadAccount(); }, [loadAccount]);
  useEffect(() => {
    if (!address) return;
    const interval = window.setInterval(() => void loadAccount(), 30_000);
    return () => window.clearInterval(interval);
  }, [address, loadAccount]);

  const strategyById = useMemo(() => new Map(strategies.map((strategy) => [strategy.id, strategy])), [strategies]);
  const selectedPosition = positions.find((position) => position.id === selectedPositionId) || positions[0] || null;
  const selectedPositionStrategy = selectedPosition ? strategyById.get(selectedPosition.strategyId) : undefined;
  const totalPrincipal = positions.reduce((sum, position) => sum + raw(position.principalRaw), 0n);
  const totalCurrent = positions.reduce((sum, position) => sum + raw(position.currentValueRaw), 0n);
  const aggregateGrowth = totalCurrent - totalPrincipal;
  const totalTipsBalance = raw(availableRaw) + totalCurrent;
  const shownActivity = showAllActivity ? activity : activity.slice(0, 4);
  const selectedGrowth = selectedPosition ? raw(selectedPosition.currentValueRaw) - raw(selectedPosition.principalRaw) : 0n;
  const selectedPositionPaused = Boolean(selectedPosition && (
    selectedPositionStrategy?.status === "disabled" || selectedPosition.chainState.toLowerCase().includes("paused")
  ));
  const actionLimitRaw = actionPosition ? (actionMode === "add" ? raw(availableRaw) : raw(actionPosition.currentValueRaw)) : 0n;
  const actionValueRaw = inputToRaw(actionAmount);
  const actionStrategy = actionPosition ? strategyById.get(actionPosition.strategyId) : undefined;
  const actionAmountValid = actionValueRaw > 0n
    && actionValueRaw <= actionLimitRaw
    && (actionMode !== "add" || actionValueRaw >= raw(actionStrategy?.minDepositRaw));
  const accountBlockingError = Boolean(accountError && !hasAccountSnapshot);
  const activeStrategyIds = useMemo(() => new Set(positions.map((position) => position.strategyId)), [positions]);
  const filteredStrategies = useMemo(() => {
    const riskRank = { low: 0, medium: 1, high: 2 } as const;
    const accessRank = { fast: 0, moderate: 1, longer: 2 } as const;
    const availabilityRank = { live: 0, preview: 1, paused: 2 } as const;
    return strategies
      .filter((strategy) => availabilityFilter === "all" || strategyAvailability(strategy) === availabilityFilter)
      .filter((strategy) => riskFilter === "all" || strategy.riskLevel === riskFilter)
      .filter((strategy) => accessFilter === "all" || strategyAccess(strategy) === accessFilter)
      .filter((strategy) => activityFilter === "all"
        || (activityFilter === "using" ? activeStrategyIds.has(strategy.id) : !activeStrategyIds.has(strategy.id)))
      .map((strategy, index) => ({ strategy, index }))
      .sort((left, right) => {
        if (strategySort === "risk") return riskRank[left.strategy.riskLevel] - riskRank[right.strategy.riskLevel] || left.index - right.index;
        if (strategySort === "access") return accessRank[strategyAccess(left.strategy)] - accessRank[strategyAccess(right.strategy)] || left.index - right.index;
        if (strategySort === "rate") return (right.strategy.estimatedApy ?? -Infinity) - (left.strategy.estimatedApy ?? -Infinity) || left.index - right.index;
        return availabilityRank[strategyAvailability(left.strategy)] - availabilityRank[strategyAvailability(right.strategy)] || left.index - right.index;
      })
      .map(({ strategy }) => strategy);
  }, [accessFilter, activeStrategyIds, activityFilter, availabilityFilter, riskFilter, strategies, strategySort]);
  const activeFilterCount = [availabilityFilter, riskFilter, accessFilter, activityFilter].filter((value) => value !== "all").length
    + (strategySort !== "recommended" ? 1 : 0);
  const filtersActive = activeFilterCount > 0;
  const strategyChoiceLabel = filteredStrategies.length === strategies.length
    ? `${strategies.length} ${strategies.length === 1 ? "choice" : "choices"}`
    : `${filteredStrategies.length} of ${strategies.length} choices`;

  const clearStrategyFilters = () => {
    setAvailabilityFilter("all");
    setRiskFilter("all");
    setAccessFilter("all");
    setActivityFilter("all");
    setStrategySort("recommended");
  };

  const scrollToStrategies = () => document.querySelector("#grow-live-strategies")?.scrollIntoView({ behavior: "smooth" });

  const openAction = (position: GrowPosition, mode: PositionControl) => {
    setActionPosition(position);
    setActionMode(mode);
    setActionAmount(mode === "withdraw_all" ? rawToInput(position.currentValueRaw) : "");
    setActionMessage("");
    setActionMessageTone("info");
  };

  const requestDefiWalletProof = async () => {
    if (!address || !smartWalletClient?.account) throw new Error("Connect your wallet to continue.");
    const challengeResponse = await fetch(`${API_BASE}/auth/wallet/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "TeepWeb" },
      body: JSON.stringify({ address, purpose: "defi-intent" }),
    });
    const challenge = await challengeResponse.json().catch(() => ({}));
    if (!challengeResponse.ok || typeof challenge?.message !== "string") {
      throw new Error(challenge?.error || "Your wallet could not be verified.");
    }
    const signature = await smartWalletClient.signMessage({
      account: smartWalletClient.account,
      message: challenge.message,
    } as Parameters<typeof smartWalletClient.signMessage>[0]);
    return { message: challenge.message, signature };
  };

  const submitAction = async () => {
    if (!actionPosition || !address || !smartWalletClient?.account || !actionAmountValid) return;
    const strategy = strategyById.get(actionPosition.strategyId);
    if (!summary.transactionEnabled || !strategy?.transactionEnabled) return;
    const amountRaw = actionValueRaw.toString();
    setSubmittingAction(true);
    setActionMessageTone("info");
    setActionMessage("Verifying your wallet…");
    try {
      const walletProof = await requestDefiWalletProof();
      setActionMessage("Checking the latest on-chain quote…");
      const response = await fetch(`${API_BASE}/defi/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "TeepWeb" },
        body: JSON.stringify({
          address,
          positionId: actionPosition.id || undefined,
          strategyId: actionPosition.strategyId,
          action: actionMode,
          amountRaw,
          walletProof,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "The wallet request could not be prepared.");
      const calls = Array.isArray(data?.calls) ? data.calls : data?.call ? [data.call] : [];
      const returnedWallet = typeof data?.claimWalletAddress === "string" ? data.claimWalletAddress.toLowerCase() : "";
      const safeCalls = calls.length === 1
        && Number(data?.chainId) === arcTestnet.id
        && returnedWallet === claimWalletAddress
        && calls.every((call: { to?: unknown; data?: unknown }) => (
          typeof call?.to === "string" && call.to.toLowerCase() === returnedWallet
          && typeof call?.data === "string" && /^0x[0-9a-f]+$/i.test(call.data)
        ));
      if (!safeCalls) throw new Error("The wallet request did not match your verified Teep account.");
      setActionMessage("Review and approve the transaction in your wallet…");
      const txHash = await smartWalletClient.sendTransaction({
        account: smartWalletClient.account,
        chain: arcTestnet,
        calls,
      } as Parameters<typeof smartWalletClient.sendTransaction>[0]);
      setActionMessage(`Submitted: ${String(txHash).slice(0, 10)}… Your report will update after confirmation.`);
      setActionMessageTone("success");
      await loadAccount();
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "The wallet request could not be prepared.");
      setActionMessageTone("error");
    } finally {
      setSubmittingAction(false);
    }
  };

  return (
    <CreatorDashboardShell title="Grow Tips">
      <main className="dashboard-body-inner grow-live-page">
        <header className="grow-live-heading">
          <h1>Grow what you&apos;ve earned.</h1>
          <p>Put idle tips to work, follow their progress, and withdraw whenever you choose.</p>
        </header>

        <section className="grow-live-overview">
          <aside className="grow-live-balances" aria-labelledby="grow-live-balances-title">
            <h2 id="grow-live-balances-title">Your balances</h2>
            <div className="grow-live-balance-scroll" tabIndex={0} aria-label="Balance summary. Scroll horizontally for more.">
              <div><span>Total tips balance</span><strong>{money(totalTipsBalance)}</strong><small>Available tips and money currently growing</small></div>
              <div><span>Available now</span><strong>{money(availableRaw)}</strong><small>Ready to grow or withdraw</small></div>
              <div><span>Currently growing</span><strong>{money(totalCurrent)}</strong><small className={aggregateGrowth < 0n ? "is-negative" : "is-positive"}>{aggregateGrowth >= 0n ? "+" : ""}{money(aggregateGrowth)} · {aggregateGrowth > 0n ? "+" : ""}{percent(aggregateGrowth, totalPrincipal)}</small></div>
            </div>
            <span className="grow-live-scroll-cue" aria-hidden>Swipe to see all balances <span className="material-symbols-outlined">arrow_forward</span></span>
          </aside>

          <section className="grow-live-report" aria-labelledby="grow-live-report-title">
            <div className="grow-live-section-head">
              <div><h2 id="grow-live-report-title">Your growth report</h2><p>Live totals from your indexed positions.</p></div>
              {hasAccountSnapshot && <span className={`grow-live-live${accountError ? " is-delayed" : ""}`}><span className={`material-symbols-outlined${refreshingAccount ? " is-spinning" : ""}`}>{accountError ? "warning" : "sync"}</span>{refreshingAccount ? " Updating" : accountError ? " Update delayed" : " Updated live"}</span>}
            </div>

            {loadingAccount && !hasAccountSnapshot ? (
              <div className="grow-live-state"><span className="material-symbols-outlined is-spinning">progress_activity</span><strong>Loading your positions…</strong></div>
            ) : accountBlockingError ? (
              <div className="grow-live-state is-error"><span className="material-symbols-outlined">cloud_off</span><strong>{accountError}</strong><button type="button" onClick={() => void loadAccount()}>Try again</button></div>
            ) : !address ? (
              <div className="grow-live-state"><span className="material-symbols-outlined">account_circle</span><strong>Connect your creator account to see your growth report.</strong><button type="button" onClick={login}>Connect account</button></div>
            ) : accountSetup === "unverified" ? (
              <div className="grow-live-state"><span className="material-symbols-outlined">verified_user</span><strong>Finish your creator setup first.</strong><p>Verify your creator account so Teep can connect the balance that holds your earned tips.</p><Link to="/creator/dashboard">Complete creator setup</Link></div>
            ) : accountSetup === "wallet_pending" ? (
              <div className="grow-live-state"><span className="material-symbols-outlined">account_balance_wallet</span><strong>Your secure tips balance is still being prepared.</strong><p>Once it is ready, your available balance and growth positions will appear here automatically.</p><Link to="/creator/dashboard">Check setup status</Link></div>
            ) : positions.length === 0 ? (
              <div className="grow-live-state"><span className="material-symbols-outlined">spa</span><strong>No active growth positions yet.</strong><p>Choose a strategy when you are ready to put part of your tips to work.</p><button type="button" onClick={scrollToStrategies}>Explore strategies</button></div>
            ) : (
              <>
                <div className="grow-live-metrics">
                  <div><i className="material-symbols-outlined">trending_up</i><span>Currently growing</span><strong>{money(totalCurrent)}</strong></div>
                  <div><i className="material-symbols-outlined">account_balance_wallet</i><span>Amount added</span><strong>{money(totalPrincipal)}</strong></div>
                  <div className={aggregateGrowth < 0n ? "is-negative" : "is-positive"}><i className="material-symbols-outlined">monitoring</i><span>Total balance change</span><strong>{aggregateGrowth >= 0n ? "+" : ""}{money(aggregateGrowth)}</strong></div>
                  <div className={aggregateGrowth < 0n ? "is-negative" : "is-positive"}><i className="material-symbols-outlined">percent</i><span>Overall growth</span><strong>{aggregateGrowth > 0n ? "+" : ""}{percent(aggregateGrowth, totalPrincipal)}</strong></div>
                  <div><i className="material-symbols-outlined">group_work</i><span>Active positions</span><strong>{positions.length}</strong></div>
                </div>
                <div className="grow-live-position-layout">
                  <div className="grow-live-position-list" role="listbox" aria-label="Active growth positions">
                    {positions.map((position) => {
                      const strategy = strategyById.get(position.strategyId);
                      const gain = raw(position.currentValueRaw) - raw(position.principalRaw);
                      return <button key={position.id} type="button" role="option" aria-selected={selectedPosition?.id === position.id} className={selectedPosition?.id === position.id ? "is-selected" : ""} onClick={() => setSelectedPositionId(position.id)}>
                        <i className="material-symbols-outlined">{strategy?.icon || "savings"}</i>
                        <span><strong>{strategyName(strategy, position.strategyId)}</strong><small>{money(position.currentValueRaw)} · <em className={gain < 0n ? "is-negative" : "is-positive"}>{gain >= 0n ? "+" : ""}{money(gain)}</em></small></span>
                        <span className="material-symbols-outlined">chevron_right</span>
                      </button>;
                    })}
                  </div>
                  {selectedPosition && <div className="grow-live-position-detail">
                    <div className="grow-live-position-title"><div><h3>{strategyName(selectedPositionStrategy, selectedPosition.strategyId)}</h3><small>Updated {date(selectedPosition.updatedAt)}</small></div><div><strong>{money(selectedPosition.currentValueRaw)}</strong><small className={selectedGrowth < 0n ? "is-negative" : "is-positive"}>{selectedGrowth >= 0n ? "+" : ""}{money(selectedGrowth)} balance change</small></div></div>
                    <div className="grow-live-position-metrics">
                      <div><span>You put in</span><strong>{money(selectedPosition.principalRaw)}</strong></div>
                      <div><span>Balance change</span><strong className={selectedGrowth < 0n ? "is-negative" : "is-positive"}>{selectedGrowth >= 0n ? "+" : ""}{money(selectedGrowth)}</strong></div>
                      <div><span>Estimated yearly rate <i title="An estimate is never counted as service fees earned." className="material-symbols-outlined">info</i></span><strong>{selectedPositionStrategy?.estimatedApy != null ? `${selectedPositionStrategy.estimatedApy.toFixed(1)}%` : "Variable"}</strong></div>
                      <div><span>Expected access</span><strong>{selectedPositionStrategy?.exitTimeEstimate || "—"}</strong></div>
                    </div>
                    {selectedPositionPaused && <div className="grow-live-paused"><span className="material-symbols-outlined">pause_circle</span>This strategy is paused. Your position remains visible, but new actions are unavailable.</div>}
                    <div className="grow-live-position-actions">
                      <button type="button" disabled={selectedPositionPaused} onClick={() => openAction(selectedPosition, "add")}><span className="material-symbols-outlined">add</span>Add more</button>
                      <button type="button" disabled={selectedPositionPaused} onClick={() => openAction(selectedPosition, "withdraw_partial")}><span className="material-symbols-outlined">download</span>Withdraw funds</button>
                    </div>
                  </div>}
                </div>
              </>
            )}
          </section>
        </section>

        <section className="grow-live-strategies" id="grow-live-strategies">
          <div className="grow-live-section-head"><div><h2>Choose a way to grow</h2><p>Compare what each option is best for, how balances may move, and expected access time.</p></div>{!loadingStrategies && <span>{strategyChoiceLabel}</span>}</div>
          {loadingStrategies ? <div className="grow-live-state"><span className="material-symbols-outlined is-spinning">progress_activity</span><strong>Loading strategies…</strong></div>
            : strategyError ? <div className="grow-live-state is-error"><span className="material-symbols-outlined">cloud_off</span><strong>{strategyError}</strong><button type="button" onClick={() => void loadStrategies()}>Try again</button></div>
            : strategies.length === 0 ? <div className="grow-live-state"><span className="material-symbols-outlined">hourglass_empty</span><strong>No strategies are available right now.</strong><p>Check back after a provider strategy has been verified.</p></div>
            : <><div className="grow-live-filter-mobile-trigger"><button type="button" aria-expanded={strategyFiltersOpen} aria-controls="grow-live-strategy-filters" onClick={() => setStrategyFiltersOpen((open) => !open)}><span><i className="material-symbols-outlined">tune</i><strong>Filters &amp; sort</strong>{activeFilterCount > 0 && <b>{activeFilterCount}</b>}</span><small>{filtersActive ? "Custom view" : "All strategies"}</small><i className="material-symbols-outlined">{strategyFiltersOpen ? "expand_less" : "expand_more"}</i></button></div><div id="grow-live-strategy-filters" className={`grow-live-strategy-filters${strategyFiltersOpen ? " is-open" : ""}`} aria-label="Strategy filters">
              <StrategyFilterSelect label="Availability" icon="toggle_on" value={availabilityFilter} onChange={setAvailabilityFilter} options={[{ value: "all", label: "All" }, { value: "live", label: "Available now" }, { value: "preview", label: "Preview" }, { value: "paused", label: "Paused" }]} />
              <StrategyFilterSelect label="Risk" icon="shield" value={riskFilter} onChange={setRiskFilter} options={[{ value: "all", label: "All levels" }, { value: "low", label: "Lower" }, { value: "medium", label: "Moderate" }, { value: "high", label: "Higher" }]} />
              <StrategyFilterSelect label="Access" icon="schedule" value={accessFilter} onChange={setAccessFilter} options={[{ value: "all", label: "Any speed" }, { value: "fast", label: "Fastest" }, { value: "moderate", label: "Moderate" }, { value: "longer", label: "Longer" }]} />
              <StrategyFilterSelect label="My activity" icon="account_balance_wallet" value={activityFilter} onChange={setActivityFilter} options={[{ value: "all", label: "All strategies" }, { value: "using", label: "Using" }, { value: "not_using", label: "Not using" }]} />
              <StrategyFilterSelect className="is-sort" label="Sort" icon="sort" value={strategySort} onChange={setStrategySort} options={[{ value: "recommended", label: "Recommended" }, { value: "risk", label: "Lowest risk" }, { value: "access", label: "Fastest access" }, { value: "rate", label: "Highest estimated rate" }]} />
              {filtersActive && <button type="button" onClick={clearStrategyFilters}><span className="material-symbols-outlined">filter_alt_off</span>Clear</button>}
            </div>
            {filteredStrategies.length === 0 ? <div className="grow-live-state"><span className="material-symbols-outlined">filter_alt_off</span><strong>No strategies match these filters.</strong><p>Clear the filters to see every available choice.</p><button type="button" onClick={clearStrategyFilters}>Clear filters</button></div>
            : <div className="grow-live-strategy-grid">{filteredStrategies.map((strategy) => {
              const language = strategyLanguage(strategy);
              const evidence = strategy.evidence && strategy.evidence.participantCount > 0 && raw(strategy.evidence.yieldPaidRaw) > 0n ? strategy.evidence : null;
              return <article key={strategy.id} className={`grow-live-strategy${strategy.status === "disabled" ? " is-paused" : ""}`}>
                <button type="button" className="grow-live-strategy-main" onClick={() => setDetailStrategy(strategy)}>
                  <span className="grow-live-strategy-title"><i className="material-symbols-outlined">{strategy.icon || "savings"}</i><strong>{strategyName(strategy)}</strong><em>{strategy.estimatedApy != null ? `${strategy.estimatedApy.toFixed(1)}% est.` : "Variable"}</em></span>
                  <span className="grow-live-strategy-best">Best for {language.bestFor.toLowerCase()}.</span>
                  <span className="grow-live-strategy-facts"><span>Balance movement <b>{language.movement}</b></span><span>Expected access <b>{strategy.exitTimeEstimate}</b></span></span>
                  {evidence && <span className="grow-live-evidence">
                    <span className="grow-live-avatar-stack">{evidence.participants.slice(0, 2).map((person, index) => person.profileImageUrl ? <img key={`${person.displayName}-${index}`} src={person.profileImageUrl} alt="" /> : <i key={`${person.displayName}-${index}`}>{initials(person.displayName)}</i>)}{evidence.participantCount > Math.min(evidence.participants.length, 2) && <b>+{evidence.participantCount - Math.min(evidence.participants.length, 2)}</b>}</span>
                    <span><strong>{money(evidence.yieldPaidRaw)}</strong><small>verified service fees paid <i title="Confirmed service-fee growth paid to creators after the performance fee. Principal withdrawals and uncollected estimates are excluded." className="material-symbols-outlined">info</i></small></span>
                  </span>}
                  <span className="grow-live-strategy-link">See how it works <i className="material-symbols-outlined">arrow_forward</i></span>
                </button>
                {strategy.status === "disabled" && <span className="grow-live-strategy-status"><i className="material-symbols-outlined">pause_circle</i>Paused</span>}
              </article>;
            })}</div>}</>}
        </section>

        <section className="grow-live-history">
          <div className="grow-live-section-head"><div><h2>Your history</h2><p>Every amount added, earned, or withdrawn.</p></div>{activity.length > 0 && <button type="button" onClick={() => setShowAllActivity((value) => !value)}>{showAllActivity ? "Show less" : "View all"}</button>}</div>
          {loadingAccount && !hasAccountSnapshot ? <div className="grow-live-state"><span className="material-symbols-outlined is-spinning">progress_activity</span><strong>Loading history…</strong></div>
            : accountBlockingError ? <div className="grow-live-state is-error"><span className="material-symbols-outlined">cloud_off</span><strong>History is unavailable.</strong><button type="button" onClick={() => void loadAccount()}>Try again</button></div>
            : activity.length === 0 ? <div className="grow-live-state"><span className="material-symbols-outlined">history</span><strong>No growth activity yet.</strong><p>Your amounts added, verified service fees received, and withdrawals will appear here.</p>{strategies.length > 0 && <button type="button" onClick={scrollToStrategies}>Explore strategies</button>}</div>
            : <div className="grow-live-history-table"><div className="is-head"><span>Date</span><span>Action</span><span>Strategy</span><span>Amount</span><span>Status</span></div>{shownActivity.map((record) => <div key={record.id}><span>{date(record.timestamp)}</span><span><i className="material-symbols-outlined">{actionIcon(record.action)}</i><strong>{actionLabel(record.action)}</strong></span><span>{record.strategyName}</span><strong className={record.direction === "in" ? "is-positive" : ""}>{record.direction === "out" ? "−" : record.direction === "in" ? "+" : ""}{record.direction === "neutral" ? "—" : money(record.amountRaw)}</strong><span>{record.status}</span></div>)}</div>}
        </section>

        <footer className="grow-live-footer">Growth comes from real network activity and is never guaranteed. Estimates and balance changes are not reported as service fees paid.</footer>
      </main>

      {detailStrategy && <div className="grow-live-modal-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetailStrategy(null); }}><section className="grow-live-modal" role="dialog" aria-modal="true" aria-labelledby="grow-live-strategy-title">
        <header><div><span>{statusLabel(detailStrategy.status)}</span><h2 id="grow-live-strategy-title">{strategyName(detailStrategy)}</h2><p>{detailStrategy.details?.objective || detailStrategy.description}</p></div><button type="button" aria-label="Close strategy details" onClick={() => setDetailStrategy(null)}><i className="material-symbols-outlined">close</i></button></header>
        <div className="grow-live-modal-grid"><div><i className="material-symbols-outlined">monitoring</i><span>Estimated yearly rate</span><strong>{detailStrategy.estimatedApy != null ? `${detailStrategy.estimatedApy.toFixed(1)}%` : "Variable"}</strong><small>{detailStrategy.estimatedApy != null ? "Estimate—not service fees earned" : "No verified estimate available"}</small></div><div><i className="material-symbols-outlined">schedule</i><span>Expected access</span><strong>{detailStrategy.exitTimeEstimate}</strong></div><div><i className="material-symbols-outlined">shield</i><span>Risk level</span><strong>{detailStrategy.riskLevel}</strong></div><div><i className="material-symbols-outlined">payments</i><span>Minimum</span><strong>{money(detailStrategy.minDepositRaw)}</strong></div></div>
        {detailStrategy.status === "disabled" && <div className="grow-live-paused"><span className="material-symbols-outlined">pause_circle</span>This strategy is paused. Existing positions remain visible, but deposits are unavailable.</div>}
        <div className="grow-live-modal-note"><span className="material-symbols-outlined">info</span><p>Your balance helps power exchange activity and receives a share of its service fees. Balances can rise or fall. You may request a withdrawal whenever you choose, but the returned amount and completion time depend on current network and market conditions.</p></div>
        {detailStrategy.disclosures.length > 0 && <ul className="grow-live-disclosures">{detailStrategy.disclosures.map((item) => <li key={item}>{item}</li>)}</ul>}
        <div className="grow-live-modal-actions"><button type="button" onClick={() => setDetailStrategy(null)}>Back</button><button type="button" disabled={!address || detailStrategy.status === "disabled" || !detailStrategy.transactionEnabled} onClick={() => { const existing = positions.find((position) => position.strategyId === detailStrategy.id); openAction(existing || { id: "", strategyId: detailStrategy.id, principalRaw: "0", currentValueRaw: "0", yieldEarnedRaw: "0", chainState: "NEW", updatedAt: Date.now() }, "add"); setDetailStrategy(null); }}><i className="material-symbols-outlined">add_circle</i>{!address ? "Connect to continue" : detailStrategy.transactionEnabled ? "Start growing" : "Transactions unavailable"}</button></div>
      </section></div>}

      {actionPosition && (() => {
        const strategy = strategyById.get(actionPosition.strategyId);
        const controlsEnabled = Boolean(summary.transactionEnabled && strategy?.transactionEnabled && strategy.status !== "disabled");
        const limitRaw = actionMode === "add" ? availableRaw : actionPosition.currentValueRaw;
        return <div className="grow-live-modal-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setActionPosition(null); }}><section className="grow-live-modal" role="dialog" aria-modal="true" aria-labelledby="grow-live-action-title">
          <header><div><span>{actionMode === "add" ? "Add funds" : "Withdraw funds"}</span><h2 id="grow-live-action-title">{strategyName(strategy, actionPosition.strategyId)}</h2><p>{actionMode === "add" ? "Adding funds creates a new position under this strategy." : "This withdrawal applies only to the selected position."}</p></div><button type="button" aria-label="Close action" onClick={() => setActionPosition(null)}><i className="material-symbols-outlined">close</i></button></header>
          <div className="grow-live-action-control-row"><span>{actionMode === "add" ? "Amount to add" : "Amount to withdraw"}</span><div className="grow-live-action-tabs"><button type="button" className={actionMode === "add" ? "is-active" : ""} onClick={() => { setActionMode("add"); setActionAmount(""); }}><i className="material-symbols-outlined">add_circle</i>Add funds</button>{actionPosition.id && <button type="button" className={actionMode !== "add" ? "is-active" : ""} onClick={() => { setActionMode("withdraw_partial"); setActionAmount(""); }}><i className="material-symbols-outlined">download</i>Withdraw funds</button>}</div></div>
          <label className="grow-live-action-input"><div><b>$</b><input type="number" min="0" step="0.01" value={actionAmount} onChange={(event) => { setActionAmount(event.target.value); if (actionMode === "withdraw_all") setActionMode("withdraw_partial"); }} /></div><small>{actionMode === "add" ? "Available balance" : "Position balance"}: <strong>{money(limitRaw)}</strong></small></label>
          <div className="grow-live-presets">{[25, 50, 75, 100].map((item) => <button key={item} type="button" onClick={() => { setActionAmount(rawToInput(raw(limitRaw) * BigInt(item) / 100n)); if (actionMode !== "add") setActionMode(item === 100 ? "withdraw_all" : "withdraw_partial"); }}>{item === 100 ? "MAX" : `${item}%`}</button>)}</div>
          {actionValueRaw > actionLimitRaw && <p className="grow-live-action-message is-error">That amount is higher than your available balance.</p>}
          {actionMode === "add" && actionValueRaw > 0n && actionValueRaw < raw(strategy?.minDepositRaw) && <p className="grow-live-action-message is-error">The minimum for this option is {money(strategy?.minDepositRaw)}.</p>}
          {actionMode !== "add" && <div className="grow-live-modal-note"><span className="material-symbols-outlined">info</span><p>You can request this withdrawal now. The final amount can differ from the displayed balance, and completion depends on current network and market conditions.</p></div>}
          {!controlsEnabled && <div className="grow-live-paused"><span className="material-symbols-outlined">lock</span>The provider transaction route is not enabled yet. No wallet request will be created.</div>}
          {actionMessage && <p className={`grow-live-action-message is-${actionMessageTone}`}><span className="material-symbols-outlined">{actionMessageTone === "success" ? "check_circle" : actionMessageTone === "error" ? "error" : "info"}</span>{actionMessage}</p>}
          <div className="grow-live-modal-actions"><button type="button" onClick={() => setActionPosition(null)}>Cancel</button><button type="button" disabled={!controlsEnabled || !actionAmountValid || submittingAction} onClick={() => void submitAction()}><i className={`material-symbols-outlined${submittingAction ? " is-spinning" : ""}`}>{submittingAction ? "progress_activity" : "account_balance_wallet"}</i>{controlsEnabled ? submittingAction ? "Preparing…" : "Continue in wallet" : "Transactions unavailable"}</button></div>
        </section></div>;
      })()}
      <Link to="/creator/grow/learn" className="grow-live-help" aria-label="Learn how Grow Tips works"><span className="material-symbols-outlined">help</span></Link>
    </CreatorDashboardShell>
  );
}

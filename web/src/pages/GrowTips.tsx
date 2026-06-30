import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { usePrivy } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import CreatorDashboardShell from "../components/CreatorDashboardShell";
import { API_BASE } from "../config";

type StrategyDetails = {
  objective: string;
  asset: string;
  providerSummary: string;
  route: Array<{ label: string; value: string }>;
  risk: Array<{ label: string; value: string }>;
  addresses: Array<{ label: string; value: string }>;
  providerPayload: Record<string, string | number | boolean | null>;
};

type PositionControl = "add" | "withdraw_partial" | "withdraw_all";

type GrowOption = {
  id: string;
  name: string;
  description: string;
  provider: string;
  status: "preview" | "pending_provider" | "ready" | "disabled";
  sourceChainName: string;
  destinationChainName?: string;
  assetSymbol: string;
  estimatedApy: number;
  riskLevel: "low" | "medium" | "high";
  minDepositRaw: string;
  bridgeProvider?: string;
  exitTimeEstimate: string;
  userOwnsPosition: boolean;
  transactionEnabled: boolean;
  controls?: PositionControl[];
  tags: string[];
  disclosures: string[];
  totalDepositedRaw?: string;
  participantCount?: number;
  icon?: string;
  details?: StrategyDetails;
};

type GrowSummary = {
  mode: string;
  transactionEnabled: boolean;
  strategyCount: number;
  readyStrategyCount: number;
  providerCount: number;
  communityTotalRaw?: string;
  participantCount?: number;
  guardrails: string[];
};

type GrowPosition = {
  strategyId: string;
  status?: string;
  principalRaw: string;
  currentValueRaw: string;
  yieldEarnedRaw: string;
  chainState: string;
  updatedAt: number;
};

type GrowPositionDetail = GrowPosition & {
  strategy?: GrowOption;
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

const PREVIEW_ADDRESS = "0x0000000000000000000000000000000000000001";
const FALLBACK_BALANCE_RAW = "1420500000";

const fallbackOptions: GrowOption[] = [
  {
    id: "teep-treasury-stable-preview",
    name: "Teep Treasury (Stable)",
    description: "Low risk capital preservation",
    provider: "Teep Treasury",
    status: "preview",
    sourceChainName: "Arc Testnet",
    assetSymbol: "USDC",
    estimatedApy: 3.8,
    riskLevel: "low",
    minDepositRaw: "1000000",
    exitTimeEstimate: "Usually minutes after exit",
    userOwnsPosition: true,
    transactionEnabled: false,
    controls: ["add", "withdraw_partial", "withdraw_all"],
    tags: ["Low risk", "Planning only"],
    disclosures: ["Planning only. This option is not backed by a live strategy contract in beta."],
    totalDepositedRaw: "540250000",
    participantCount: 18,
    icon: "security",
  },
  {
    id: "morpho-usdc-cross-chain-preview",
    name: "Morpho USDC Yield",
    description: "Optimized lending on Base",
    provider: "Morpho",
    status: "pending_provider",
    sourceChainName: "Arc Testnet",
    destinationChainName: "Base Sepolia",
    assetSymbol: "USDC",
    estimatedApy: 4.2,
    riskLevel: "low",
    minDepositRaw: "1000000",
    bridgeProvider: "Circle CCTP / Arc App Kit",
    exitTimeEstimate: "Minutes after bridge finality",
    userOwnsPosition: true,
    transactionEnabled: false,
    controls: ["add", "withdraw_partial", "withdraw_all"],
    tags: ["Low risk", "Base testnet", "Planning only"],
    disclosures: ["Planning only. Morpho and bridge provider addresses are not verified for Arc beta yet."],
    totalDepositedRaw: "128500000000",
    participantCount: 34,
    icon: "account_balance",
  },
];

const fallbackSummary: GrowSummary = {
  mode: "preview_only",
  transactionEnabled: false,
  strategyCount: fallbackOptions.length,
  readyStrategyCount: 0,
  providerCount: 2,
  communityTotalRaw: "128500000000",
  participantCount: 34,
  guardrails: ["Grow Tips is planning-only in beta. No deposits, withdrawals, approvals, bridging, or provider transactions are enabled."],
};

const fallbackPositions: GrowPosition[] = [
  {
    strategyId: "morpho-usdc-cross-chain-preview",
    principalRaw: "500000000",
    currentValueRaw: "1280400000",
    yieldEarnedRaw: "780400000",
    chainState: "SIMULATED_ACTIVE",
    updatedAt: Date.now(),
  },
  {
    strategyId: "teep-treasury-stable-preview",
    principalRaw: "540250000",
    currentValueRaw: "540250000",
    yieldEarnedRaw: "0",
    chainState: "SIMULATED_ACTIVE",
    updatedAt: Date.now(),
  },
];

const fallbackActivity: GrowActivity[] = [
  {
    id: "preview-grow-morpho",
    timestamp: Date.UTC(2024, 5, 15),
    action: "grow",
    strategyId: "morpho-usdc-cross-chain-preview",
    strategyName: "Morpho USDC Yield",
    amountRaw: "500000000",
    direction: "in",
    status: "preview",
  },
  {
    id: "preview-yield-treasury",
    timestamp: Date.UTC(2024, 5, 1),
    action: "yield",
    strategyId: "teep-treasury-stable-preview",
    strategyName: "Teep Treasury",
    amountRaw: "12450000",
    direction: "in",
    status: "preview",
  },
  {
    id: "preview-withdraw-morpho",
    timestamp: Date.UTC(2024, 4, 24),
    action: "withdraw",
    strategyId: "morpho-usdc-cross-chain-preview",
    strategyName: "Morpho USDC Yield",
    amountRaw: "200000000",
    direction: "out",
    status: "preview",
  },
];

function rawToUsd(raw: string | number | null | undefined) {
  return Number(raw || "0") / 1e6;
}

function formatRawUsdc(raw: string | number | null | undefined, maximumFractionDigits = 2) {
  const minimumFractionDigits = maximumFractionDigits === 0 ? 0 : 2;
  return rawToUsd(raw).toLocaleString(undefined, {
    minimumFractionDigits,
    maximumFractionDigits,
  });
}

function money(raw: string | number | null | undefined, maximumFractionDigits = 2) {
  return `$${formatRawUsdc(raw, maximumFractionDigits)}`;
}

function moneyFromUsd(value: number) {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatInputAmount(value: number) {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function formatDateTime(timestamp: number) {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatChainState(state?: string) {
  if (!state) return "Planning only";
  if (state.toLowerCase() === "preview") return "Planning only";
  return state
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function positionRoi(position: GrowPosition) {
  const principal = rawToUsd(position.principalRaw);
  const yieldEarned = rawToUsd(position.yieldEarnedRaw);
  if (!principal) return "0.00%";
  return `${((yieldEarned / principal) * 100).toFixed(2)}%`;
}

function positionControlLabel(control: PositionControl) {
  if (control === "withdraw_partial") return "Withdraw partial";
  if (control === "withdraw_all") return "Exit position";
  return "Add more";
}

function positionControlIcon(control: PositionControl) {
  if (control === "withdraw_partial") return "call_received";
  if (control === "withdraw_all") return "logout";
  return "add_circle";
}

function actionLabel(action: GrowActivity["action"]) {
  switch (action) {
    case "grow":
      return "Grow";
    case "yield":
      return "Yield";
    case "withdraw":
      return "Withdraw";
    case "details":
      return "Details";
    case "watch":
      return "Watch";
    default:
      return "Activity";
  }
}

function actionIcon(action: GrowActivity["action"]) {
  switch (action) {
    case "grow":
      return "add";
    case "yield":
      return "trending_up";
    case "withdraw":
      return "remove";
    case "details":
      return "info";
    case "watch":
      return "visibility";
    default:
      return "bolt";
  }
}

function activityAmount(record: GrowActivity) {
  if (record.direction === "neutral") return "Viewed";
  const sign = record.direction === "out" ? "-" : "+";
  return `${sign}${money(record.amountRaw)}`;
}

function statusLabel(status: GrowOption["status"]) {
  if (status === "ready") return "Available";
  if (status === "disabled") return "Unavailable";
  if (status === "pending_provider") return "Opening soon";
  return "Planning only";
}

function normalizeStrategyName(name: string) {
  return name.replace(" (Stable)", "");
}

function strategyPreferenceMatches(option: GrowOption, preference: string) {
  const normalizedPreference = preference.toLowerCase().replace(/-preview$/, "");
  const normalizedOption = option.id.toLowerCase().replace(/-preview$/, "");
  if (normalizedOption === normalizedPreference) return true;
  if (normalizedPreference.includes("morpho")) return option.provider.toLowerCase().includes("morpho") || normalizedOption.includes("morpho");
  if (normalizedPreference.includes("treasury")) return normalizedOption.includes("treasury") || option.name.toLowerCase().includes("treasury");
  return false;
}

function buildChartPoints(startRaw: string | number, endRaw: string | number, pointCount: number) {
  const start = rawToUsd(startRaw);
  const end = rawToUsd(endRaw);
  const delta = end - start;
  return Array.from({ length: pointCount }, (_, index) => {
    const progress = index / Math.max(pointCount - 1, 1);
    const eased = Math.pow(progress, 1.55);
    return start + delta * eased;
  });
}

function GrowthSnapshot({ points, tooltipValue }: { points: number[]; tooltipValue: string }) {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(max - min, 1);
  const coordinates = points.map((point, index) => {
    const x = (index / Math.max(points.length - 1, 1)) * 100;
    const y = 86 - ((point - min) / span) * 74;
    return { x, y };
  });
  const line = coordinates.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `0,100 ${line} 100,100`;
  const end = coordinates[coordinates.length - 1];

  return (
    <div className="defi-chart">
      <div className="defi-chart-surface" />
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="defiGrowFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(16, 185, 129, 0.28)" />
            <stop offset="100%" stopColor="rgba(16, 185, 129, 0)" />
          </linearGradient>
        </defs>
        <polygon points={area} className="defi-chart-area" />
        <polyline points={line} className="defi-chart-line" />
        <circle cx={end.x} cy={end.y} r="1.8" className="defi-chart-dot" />
      </svg>
      <div className="defi-chart-grid" aria-hidden>
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="defi-chart-tooltip">
        <span>Jun 14</span>
        <strong>{tooltipValue}</strong>
      </div>
    </div>
  );
}

export default function GrowTips() {
  const { ready, authenticated } = usePrivy();
  const { client: smartWalletClient } = useSmartWallets();
  const liveAddress = (ready && authenticated ? smartWalletClient?.account?.address || "" : "").toLowerCase();
  const [stableAddress, setStableAddress] = useState("");
  const address = liveAddress || stableAddress;
  const dataAddress = address || PREVIEW_ADDRESS;
  const [options, setOptions] = useState<GrowOption[]>(fallbackOptions);
  const [summary, setSummary] = useState<GrowSummary>(fallbackSummary);
  const [selectedId, setSelectedId] = useState("morpho-usdc-cross-chain-preview");
  const [preferredStrategyId, setPreferredStrategyId] = useState<string | null>(null);
  const [riskVisibilityLevel, setRiskVisibilityLevel] = useState<"minimal" | "standard" | "detailed">("standard");
  const [previewAmount, setPreviewAmount] = useState("500");
  const [amountEdited, setAmountEdited] = useState(false);
  const [walletBalanceRaw, setWalletBalanceRaw] = useState(FALLBACK_BALANCE_RAW);
  const [positions, setPositions] = useState<GrowPosition[]>(fallbackPositions);
  const [activity, setActivity] = useState<GrowActivity[]>(fallbackActivity);
  const [range, setRange] = useState<"7D" | "30D" | "90D">("30D");
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [detailStrategy, setDetailStrategy] = useState<GrowOption | null>(null);
  const [previewPlanOpen, setPreviewPlanOpen] = useState(false);
  const [positionDetail, setPositionDetail] = useState<GrowPositionDetail | null>(null);
  const [positionControlMode, setPositionControlMode] = useState<PositionControl>("add");
  const [positionControlAmount, setPositionControlAmount] = useState("");
  const [isStrategyMenuOpen, setStrategyMenuOpen] = useState(false);
  const strategyPickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (liveAddress) setStableAddress(liveAddress);
  }, [liveAddress]);

  useEffect(() => {
    if (!isStrategyMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!strategyPickerRef.current?.contains(event.target as Node)) {
        setStrategyMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setStrategyMenuOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isStrategyMenuOpen]);

  useEffect(() => {
    let cancelled = false;
    async function loadGrowPreview() {
      try {
        const [summaryRes, optionsRes] = await Promise.all([
          fetch(`${API_BASE}/defi/summary`),
          fetch(`${API_BASE}/defi/strategies`),
        ]);
        const summaryJson = summaryRes.ok ? await summaryRes.json() : fallbackSummary;
        const optionsJson = optionsRes.ok ? await optionsRes.json() : { strategies: fallbackOptions };
        if (cancelled) return;
        const nextOptions = Array.isArray(optionsJson.strategies) && optionsJson.strategies.length
          ? optionsJson.strategies
          : fallbackOptions;
        setSummary(summaryJson);
        setOptions(nextOptions);
        setSelectedId(nextOptions.find((option: GrowOption) => option.provider === "Morpho")?.id || nextOptions[0].id);
      } catch {
        if (!cancelled) {
          setSummary(fallbackSummary);
          setOptions(fallbackOptions);
        }
      }
    }
    loadGrowPreview();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/v1/wallet/${address}/settings`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        setPreferredStrategyId(data?.growTips?.defaultStrategyId || null);
        if (["minimal", "standard", "detailed"].includes(data?.growTips?.riskVisibilityLevel)) {
          setRiskVisibilityLevel(data.growTips.riskVisibilityLevel);
        }
      })
      .catch(() => {
        if (!cancelled) setPreferredStrategyId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  useEffect(() => {
    if (!preferredStrategyId || options.length === 0) return;
    const preferred = options.find((option) => strategyPreferenceMatches(option, preferredStrategyId));
    if (preferred) setSelectedId(preferred.id);
  }, [options, preferredStrategyId]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      address
        ? fetch(`${API_BASE}/api/v1/wallet/${address}/balance`).then((res) => (res.ok ? res.json() : { balanceRaw: "0" })).catch(() => ({ balanceRaw: "0" }))
        : Promise.resolve({ balanceRaw: FALLBACK_BALANCE_RAW }),
      fetch(`${API_BASE}/defi/positions/${dataAddress}`).then((res) => (res.ok ? res.json() : { positions: fallbackPositions })).catch(() => ({ positions: fallbackPositions })),
      fetch(`${API_BASE}/defi/activity/${dataAddress}`).then((res) => (res.ok ? res.json() : { records: fallbackActivity })).catch(() => ({ records: fallbackActivity })),
    ]).then(([balanceData, positionData, activityData]) => {
      if (cancelled) return;
      setWalletBalanceRaw(String(balanceData?.balanceRaw ?? (address ? "0" : FALLBACK_BALANCE_RAW)));
      setPositions(Array.isArray(positionData?.positions) && positionData.positions.length ? positionData.positions : fallbackPositions);
      setActivity(Array.isArray(activityData?.records) && activityData.records.length ? activityData.records : fallbackActivity);
    });
    return () => {
      cancelled = true;
    };
  }, [address, dataAddress]);

  useEffect(() => {
    if (!address || amountEdited) return;
    setPreviewAmount(formatInputAmount(rawToUsd(walletBalanceRaw)));
  }, [address, amountEdited, walletBalanceRaw]);

  const selected = useMemo(
    () => options.find((option) => option.id === selectedId) || options[0],
    [selectedId, options],
  );
  const strategyById = useMemo(() => new Map(options.map((option) => [option.id, option])), [options]);
  const activePositions = useMemo(
    () => positions.map((position) => ({
      ...position,
      strategy: strategyById.get(position.strategyId),
    })),
    [positions, strategyById],
  );

  const displayBalanceRaw = address ? walletBalanceRaw : FALLBACK_BALANCE_RAW;
  const availableUsd = rawToUsd(displayBalanceRaw);
  const amountUsd = Number(previewAmount || "0");
  const estimatedYearly = selected ? (amountUsd * selected.estimatedApy) / 100 : 0;
  const estimatedMonthly = estimatedYearly / 12;
  const estimatedEndValue = amountUsd + estimatedYearly;
  const selectedRoute = selected?.destinationChainName
    ? `${selected.sourceChainName} to ${selected.destinationChainName}`
    : selected?.sourceChainName || "Planning route";
  const selectedPosition = positions.find((position) => position.strategyId === selected?.id) || positions[0];
  const chartStartRaw = selectedPosition?.principalRaw || String(Math.max(amountUsd, 1) * 1e6);
  const chartEndRaw = selectedPosition?.currentValueRaw || String((amountUsd + estimatedYearly) * 1e6);
  const chartPoints = buildChartPoints(chartStartRaw, chartEndRaw, range === "7D" ? 12 : range === "90D" ? 36 : 24);
  const communityCount = summary.participantCount || selected?.participantCount || 34;
  const collectiveValueRaw = summary.communityTotalRaw || selected?.totalDepositedRaw || "128500000000";
  const shownActivity = showAllActivity ? activity : activity.slice(0, 3);

  const setPercentAmount = useCallback((percent: number) => {
    setAmountEdited(true);
    setPreviewAmount(formatInputAmount(availableUsd * percent));
  }, [availableUsd]);

  const openStrategyDetails = useCallback(async (strategyId: string) => {
    setSelectedId(strategyId);
    const fallback = options.find((option) => option.id === strategyId) || null;
    try {
      const res = await fetch(`${API_BASE}/defi/strategies/${encodeURIComponent(strategyId)}`);
      const data = res.ok ? await res.json() : null;
      setDetailStrategy(data?.strategy || fallback);
    } catch {
      setDetailStrategy(fallback);
    }
  }, [options]);

  const downloadActivityCsv = useCallback(() => {
    const header = ["date", "action", "strategy", "amount", "status"];
    const rows = activity.map((record) => [
      formatDate(record.timestamp),
      actionLabel(record.action),
      record.strategyName,
      activityAmount(record),
      record.status,
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "grow-tips-activity.csv";
    link.click();
    URL.revokeObjectURL(url);
  }, [activity]);

  return (
    <CreatorDashboardShell title="Grow Tips">
      <main className="dashboard-body-inner defi-grow-page">
        <div className="defi-grow-grid">
          <div className="defi-grow-main">
            <section className="defi-grow-command">
              <div className="defi-grow-section-head">
                <div>
                  <h2>Choose how much to grow</h2>
                  <p id="grow-preview-note" className="defi-grow-preview-note">
                    Planning only. No deposits, withdrawals, bridging, or provider transactions run from this page yet.
                  </p>
                </div>
              </div>

              <label className="defi-grow-amount-field">
                <small className="defi-grow-available-balance">Available <strong>{money(displayBalanceRaw)}</strong></small>
                <span>$</span>
                <input
                  aria-label="Amount to grow"
                  aria-describedby="grow-preview-note"
                  type="number"
                  min="0"
                  step="1"
                  value={previewAmount}
                  onChange={(event) => {
                    setAmountEdited(true);
                    setPreviewAmount(event.target.value);
                  }}
                />
              </label>

              <div className="defi-grow-percent-row defi-grow-percent-row-near" role="group" aria-label="Quick amount selectors">
                <button type="button" aria-label="Use 25 percent of available balance" onClick={() => setPercentAmount(0.25)}>25%</button>
                <button type="button" aria-label="Use 50 percent of available balance" onClick={() => setPercentAmount(0.5)}>50%</button>
                <button type="button" aria-label="Use 75 percent of available balance" onClick={() => setPercentAmount(0.75)}>75%</button>
                <button type="button" className="is-max" aria-label="Use maximum available balance" onClick={() => setPercentAmount(1)}>MAX</button>
              </div>

              <div className="defi-grow-strategy-field" ref={strategyPickerRef}>
                <span id="grow-strategy-label">Grow with</span>
                <button
                  type="button"
                  className="defi-grow-strategy-trigger"
                  aria-labelledby="grow-strategy-label grow-selected-strategy"
                  aria-haspopup="listbox"
                  aria-expanded={isStrategyMenuOpen}
                  onClick={() => setStrategyMenuOpen((value) => !value)}
                >
                  <span className="material-symbols-outlined defi-grow-strategy-icon" aria-hidden>
                    {selected?.icon || "account_balance"}
                  </span>
                  <strong id="grow-selected-strategy">{selected?.name || "Select strategy"}</strong>
                  <em>{selected ? `${selected.estimatedApy.toFixed(1)}% APY` : "Select"}</em>
                  <span className="material-symbols-outlined defi-grow-strategy-chevron" aria-hidden>
                    expand_more
                  </span>
                </button>
                {isStrategyMenuOpen && (
                  <div className="defi-grow-strategy-menu" role="listbox" aria-labelledby="grow-strategy-label">
                    {options.map((option) => {
                      const isSelected = option.id === selectedId;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          className={isSelected ? "is-selected" : ""}
                          onClick={() => {
                            setSelectedId(option.id);
                            setStrategyMenuOpen(false);
                          }}
                        >
                          <span className="material-symbols-outlined defi-grow-strategy-icon" aria-hidden>
                            {option.icon || "account_balance"}
                          </span>
                          <span>
                            <strong>{option.name}</strong>
                            <small>{option.description}</small>
                          </span>
                          <em>{option.estimatedApy.toFixed(1)}% APY</em>
                        </button>
                      );
                    })}
                  </div>
                )}
                {selected?.description && <small className="defi-grow-strategy-description">{selected.description}</small>}
              </div>

              <div className="defi-grow-controls">
                <div className="defi-grow-preview-action">
                  <div>
                    <span>Estimated yearly</span>
                    <strong>+{moneyFromUsd(estimatedYearly)}</strong>
                  </div>
                  <span className="defi-grow-preview-badge">Planning only</span>
                  <button type="button" className="defi-grow-primary" onClick={() => setPreviewPlanOpen(true)}>
                    Plan Growth
                    <span className="material-symbols-outlined" aria-hidden>arrow_forward</span>
                  </button>
                </div>
              </div>
            </section>

            <section className="defi-grow-snapshot">
              <div className="defi-grow-section-head">
                <h2>Growth Snapshot</h2>
                <div className="defi-grow-range" role="group" aria-label="Growth chart range">
                  {(["7D", "30D", "90D"] as const).map((item) => (
                    <button key={item} type="button" className={range === item ? "is-active" : ""} aria-pressed={range === item} onClick={() => setRange(item)}>
                      {item}
                    </button>
                  ))}
                </div>
              </div>
              <GrowthSnapshot points={chartPoints} tooltipValue={money(chartEndRaw)} />
              <div className="defi-chart-axis" aria-hidden>
                <span>May 15</span>
                <span>May 30</span>
                <span>Jun 15</span>
              </div>
            </section>

            <section className="defi-grow-activity">
              <div className="defi-grow-section-head">
                <h2>Growth Activity</h2>
                <button type="button" className="defi-grow-download" aria-label="Download Grow Tips activity CSV" onClick={downloadActivityCsv}>
                  Download CSV
                  <span className="material-symbols-outlined" aria-hidden>download</span>
                </button>
              </div>
              <div className="defi-activity-table">
                <div className="defi-activity-row is-head" aria-hidden>
                  <span>Date</span>
                  <span>Action</span>
                  <span>Strategy</span>
                  <span>Amount</span>
                </div>
                {shownActivity.map((record) => (
                  <div className="defi-activity-row" key={record.id}>
                    <span className="defi-activity-date">{formatDate(record.timestamp)}</span>
                    <span className="defi-activity-action">
                      <i className={`defi-activity-icon is-${record.action}`}>
                        <span className="material-symbols-outlined" aria-hidden>{actionIcon(record.action)}</span>
                      </i>
                      <strong>{actionLabel(record.action)}</strong>
                    </span>
                    <span>{record.strategyName}</span>
                    <strong className={`defi-activity-amount is-${record.direction}`}>{activityAmount(record)}</strong>
                  </div>
                ))}
              </div>
              {activity.length > 3 && (
                <button type="button" className="defi-grow-history" onClick={() => setShowAllActivity((value) => !value)}>
                  {showAllActivity ? "Show less" : "View full history"}
                  <span className="material-symbols-outlined" aria-hidden>{showAllActivity ? "expand_less" : "arrow_forward"}</span>
                </button>
              )}
            </section>
          </div>

          <aside className="defi-grow-side">
            <section className="defi-side-section defi-side-section-positions">
              <h3><span className="defi-section-dot is-owned" />Active positions</h3>
              <div className="defi-position-list">
                {activePositions.map((position) => {
                  const strategy = position.strategy;
                  return (
                    <button
                      key={position.strategyId}
                      type="button"
                      className="defi-position-row"
                      onClick={() => {
                        setPositionControlMode("add");
                        setPositionControlAmount("");
                        setPositionDetail(position);
                      }}
                    >
                      <span>
                        <span className="defi-position-title">
                          {normalizeStrategyName(strategy?.name || position.strategyId)}
                          <em>{(strategy?.estimatedApy || 0).toFixed(1)}% APY</em>
                        </span>
                        <strong>{money(position.currentValueRaw)}</strong>
                        <small className="defi-position-meta">Active balance</small>
                      </span>
                      <span className="defi-position-action">
                        View
                        <span className="material-symbols-outlined" aria-hidden>chevron_right</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="defi-side-section defi-side-section-strategies">
              <h3><span className="defi-section-dot is-choice" />Available strategies</h3>
              <div className="defi-strategy-list">
                {options.map((option) => {
                  const isSelected = selected?.id === option.id;
                  return (
                    <div key={option.id} className={`defi-strategy-row${isSelected ? " is-selected" : ""}`}>
                      <button
                        type="button"
                        className="defi-strategy-select-button"
                        aria-pressed={isSelected}
                        onClick={() => setSelectedId(option.id)}
                      >
                        <span className="defi-strategy-icon material-symbols-outlined" aria-hidden>{option.icon || "account_balance"}</span>
                        <span>
                          <strong>{option.name}</strong>
                          <small>{option.description}</small>
                        </span>
                        <span className="defi-strategy-choice">{isSelected ? "Selected" : "Choose"}</span>
                      </button>
                      <button
                        type="button"
                        className="defi-strategy-details-button"
                        title={`View ${option.name} details`}
                        aria-label={`View ${option.name} details`}
                        onClick={() => {
                          setSelectedId(option.id);
                          openStrategyDetails(option.id);
                        }}
                      >
                        <span className="material-symbols-outlined" aria-hidden>info</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="defi-side-section defi-side-section-community">
              <h3><span className="defi-section-dot is-context" />Growing together</h3>
              <div className="defi-community-row">
                <div className="defi-avatar-stack" aria-hidden>
                  <span />
                  <span />
                  <span />
                  <strong>+{Math.max(communityCount - 3, 0)}</strong>
                </div>
                <p><strong>{communityCount} creators</strong> growing with these strategies</p>
              </div>
              <div className="defi-collective">
                <span>Collective value</span>
                <strong>{money(collectiveValueRaw, 0)}</strong>
              </div>
            </section>

            <Link to="/creator/grow/learn" className="defi-learn-card">
              <span className="defi-learn-book material-symbols-outlined" aria-hidden>auto_stories</span>
              <span>
                <strong>New to growing tips?</strong>
                <small>Learn how the yield mechanics work in under 3 minutes.</small>
                <em>
                  <span className="material-symbols-outlined" aria-hidden>play_circle</span>
                  Start learning
                </em>
              </span>
            </Link>
          </aside>
        </div>

        <footer className="defi-grow-footer">
          Yield rates are dynamic and subject to protocol risk. Teep interacts with non-custodial smart contracts on Ethereum and Base networks. Always perform your own research before growing assets.
        </footer>
      </main>

      {previewPlanOpen && selected && (
        <div className="defi-modal-layer" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setPreviewPlanOpen(false);
        }}>
          <section className="defi-modal defi-preview-modal" role="dialog" aria-modal="true" aria-labelledby="defi-preview-title">
            <header>
              <div>
                <span className="defi-modal-kicker">Growth plan</span>
                <h2 id="defi-preview-title">{selected.name}</h2>
                <p>Planning estimate for the selected amount and strategy. Live deposits stay locked until provider routes and contracts are verified.</p>
              </div>
              <button type="button" aria-label="Close growth plan" onClick={() => setPreviewPlanOpen(false)}>
                <span className="material-symbols-outlined" aria-hidden>close</span>
              </button>
            </header>

            <div className="defi-preview-summary">
              <div>
                <span>Amount to grow</span>
                <strong>{moneyFromUsd(amountUsd)}</strong>
              </div>
              <div>
                <span>Estimated yearly</span>
                <strong className="is-positive">+{moneyFromUsd(estimatedYearly)}</strong>
              </div>
              <div>
                <span>Projected value</span>
                <strong>{moneyFromUsd(estimatedEndValue)}</strong>
              </div>
            </div>

            <div className="defi-modal-grid defi-preview-modal-grid">
              <div><span>Strategy</span><strong>{selected.name}</strong></div>
              <div><span>APY</span><strong>{selected.estimatedApy.toFixed(1)}%</strong></div>
              <div><span>Risk</span><strong>{selected.riskLevel}</strong></div>
              <div><span>Route</span><strong>{selectedRoute}</strong></div>
              <div><span>Access back</span><strong>{selected.exitTimeEstimate}</strong></div>
              <div><span>Monthly estimate</span><strong>+{moneyFromUsd(estimatedMonthly)}</strong></div>
            </div>

            <div className="defi-modal-disclosures">
              <p>This is planning-only. It does not deposit, bridge, withdraw, approve, or sign anything.</p>
              {(selected.disclosures || []).map((item) => <p key={item}>{item}</p>)}
            </div>

            <div className="defi-preview-actions">
              <button type="button" className="btn-secondary" onClick={() => setPreviewPlanOpen(false)}>Keep editing</button>
              <button type="button" className="defi-position-control-submit" disabled>
                Transactions locked
                <span className="material-symbols-outlined" aria-hidden>lock</span>
              </button>
            </div>
          </section>
        </div>
      )}

      {positionDetail && (() => {
        const strategy = positionDetail.strategy || strategyById.get(positionDetail.strategyId);
        const strategyName = normalizeStrategyName(strategy?.name || positionDetail.strategyId);
        const route = strategy?.destinationChainName
          ? `${strategy.sourceChainName} to ${strategy.destinationChainName}`
          : strategy?.sourceChainName || "Planning route";
        const controls = strategy?.controls?.length ? strategy.controls : ["add", "withdraw_partial", "withdraw_all"] as PositionControl[];
        const activeControl = controls.includes(positionControlMode) ? positionControlMode : controls[0] || "add";
        const controlsEnabled = Boolean(summary.transactionEnabled && strategy?.transactionEnabled);
        const controlLimitRaw = activeControl === "add" ? displayBalanceRaw : positionDetail.currentValueRaw;
        const controlAmountValue = activeControl === "withdraw_all"
          ? formatInputAmount(rawToUsd(positionDetail.currentValueRaw))
          : positionControlAmount;
        const controlLimitLabel = activeControl === "add" ? "Available tips" : "Available in position";
        return (
          <div className="defi-modal-layer" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPositionDetail(null);
          }}>
            <section className="defi-modal defi-position-modal" role="dialog" aria-modal="true" aria-labelledby="defi-position-title">
              <header>
                <div>
                  <span className="defi-modal-kicker">Active position</span>
                  <h2 id="defi-position-title">{strategyName}</h2>
                  <p>Your current balance, growth, and route for this selected strategy.</p>
                </div>
                <button type="button" aria-label="Close position details" onClick={() => setPositionDetail(null)}>
                  <span className="material-symbols-outlined" aria-hidden>close</span>
                </button>
              </header>

              <div className="defi-position-modal-summary">
                <div className="defi-position-modal-hero">
                  <span>Current value</span>
                  <strong>{money(positionDetail.currentValueRaw)}</strong>
                  <small>{formatChainState(positionDetail.chainState)}</small>
                </div>
                <div>
                  <span>Growth earned</span>
                  <strong className="is-positive">+{money(positionDetail.yieldEarnedRaw)}</strong>
                </div>
                <div>
                  <span>Return</span>
                  <strong>{positionRoi(positionDetail)}</strong>
                </div>
              </div>

              <div className="defi-position-controls">
                <div className="defi-position-controls-head">
                  <div>
                    <h3>Position controls</h3>
                    <p>Add to this strategy, withdraw part of it, or exit the position when the live contract route supports it.</p>
                  </div>
                  <span className={controlsEnabled ? "is-ready" : ""}>{controlsEnabled ? "Contract ready" : "Planning only"}</span>
                </div>

                <div className="defi-position-control-tabs" role="group" aria-label="Position control actions">
                  {(["add", "withdraw_partial", "withdraw_all"] as PositionControl[]).map((control) => {
                    const isSupported = controls.includes(control);
                    return (
                      <button
                        key={control}
                        type="button"
                        className={activeControl === control ? "is-active" : ""}
                        disabled={!isSupported}
                        onClick={() => {
                          if (!isSupported) return;
                          setPositionControlMode(control);
                          setPositionControlAmount(control === "withdraw_all" ? formatInputAmount(rawToUsd(positionDetail.currentValueRaw)) : "");
                        }}
                      >
                        <span className="material-symbols-outlined" aria-hidden>{positionControlIcon(control)}</span>
                        {positionControlLabel(control)}
                      </button>
                    );
                  })}
                </div>

                <div className="defi-position-control-panel">
                  <label className="defi-position-control-input">
                    <span>{activeControl === "add" ? "Amount to add" : "Amount to withdraw"}</span>
                    <div>
                      <em>$</em>
                      <input
                        aria-label={activeControl === "add" ? "Amount to add to position" : "Amount to withdraw from position"}
                        type="number"
                        min="0"
                        step="1"
                        value={controlAmountValue}
                        disabled={activeControl === "withdraw_all"}
                        onChange={(event) => setPositionControlAmount(event.target.value)}
                      />
                    </div>
                    <small>{controlLimitLabel}: <strong>{money(controlLimitRaw)}</strong></small>
                  </label>

                  <div className="defi-position-control-presets" role="group" aria-label="Position amount presets">
                    {[0.25, 0.5, 0.75, 1].map((percent) => (
                      <button
                        key={percent}
                        type="button"
                        disabled={activeControl === "withdraw_all"}
                        onClick={() => setPositionControlAmount(formatInputAmount(rawToUsd(controlLimitRaw) * percent))}
                      >
                        {percent === 1 ? "MAX" : `${Math.round(percent * 100)}%`}
                      </button>
                    ))}
                  </div>

                  <button type="button" className="defi-position-control-submit" disabled={!controlsEnabled}>
                    {controlsEnabled ? positionControlLabel(activeControl) : "Planning only"}
                    <span className="material-symbols-outlined" aria-hidden>{controlsEnabled ? "arrow_forward" : "lock"}</span>
                  </button>
                </div>

                <p className="defi-position-control-note">
                  {controlsEnabled
                    ? "Submitting will create the wallet transaction flow for this position."
                    : "Controls are shown for the beta flow, but deposits, partial withdrawals, and exits stay locked until verified provider contracts are enabled."}
                </p>
              </div>

              <div className="defi-modal-grid defi-position-modal-grid">
                <div><span>Starting amount</span><strong>{money(positionDetail.principalRaw)}</strong></div>
                <div><span>Current value</span><strong>{money(positionDetail.currentValueRaw)}</strong></div>
                <div><span>Growth earned</span><strong>{money(positionDetail.yieldEarnedRaw)}</strong></div>
                <div><span>Strategy APY</span><strong>{strategy ? `${strategy.estimatedApy.toFixed(1)}%` : "Planning only"}</strong></div>
                <div><span>Risk</span><strong>{strategy?.riskLevel || "Planning only"}</strong></div>
                <div><span>Access back</span><strong>{strategy?.exitTimeEstimate || "Planning only"}</strong></div>
                <div><span>Provider</span><strong>{strategy?.provider || "Strategy provider"}</strong></div>
                <div><span>Asset</span><strong>{strategy?.assetSymbol || "USDC"}</strong></div>
                <div><span>Route</span><strong>{route}</strong></div>
                <div><span>Bridge</span><strong>{strategy?.bridgeProvider || "Not required"}</strong></div>
                <div><span>Position status</span><strong>{positionDetail.status ? formatChainState(positionDetail.status) : "Planning only"}</strong></div>
                <div><span>Updated</span><strong>{formatDateTime(positionDetail.updatedAt)}</strong></div>
              </div>

              <div className="defi-modal-disclosures">
                <p>This modal shows the creator's position in the strategy, not the provider's full vault metadata.</p>
                {!summary.transactionEnabled && <p>Planning only. Deposits, withdrawals, bridging, and provider transactions remain disabled.</p>}
              </div>
            </section>
          </div>
        );
      })()}

      {detailStrategy && (
        <div className="defi-modal-layer" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setDetailStrategy(null);
        }}>
          <section className="defi-modal" role="dialog" aria-modal="true" aria-labelledby="defi-strategy-title">
            <header>
              <div>
                <span className="defi-modal-kicker">{statusLabel(detailStrategy.status)}</span>
                <h2 id="defi-strategy-title">{detailStrategy.name}</h2>
                <p>{detailStrategy.details?.objective || detailStrategy.description}</p>
              </div>
              <button type="button" aria-label="Close strategy details" onClick={() => setDetailStrategy(null)}>
                <span className="material-symbols-outlined" aria-hidden>close</span>
              </button>
            </header>

            <div className="defi-modal-grid">
              <div><span>Provider</span><strong>{detailStrategy.provider}</strong></div>
              <div><span>APY</span><strong>{detailStrategy.estimatedApy.toFixed(1)}%</strong></div>
              <div><span>Asset</span><strong>{detailStrategy.assetSymbol}</strong></div>
              <div><span>Risk</span><strong>{detailStrategy.riskLevel}</strong></div>
              <div><span>Minimum</span><strong>{formatRawUsdc(detailStrategy.minDepositRaw)} {detailStrategy.assetSymbol}</strong></div>
              <div><span>Access back</span><strong>{detailStrategy.exitTimeEstimate}</strong></div>
            </div>

            {detailStrategy.details && riskVisibilityLevel !== "minimal" && (
              <div className="defi-modal-sections">
                {riskVisibilityLevel === "detailed" && (
                  <article>
                    <h3>Route</h3>
                    {detailStrategy.details.route.map((item) => (
                      <p key={`${item.label}-${item.value}`}><span>{item.label}</span><strong>{item.value}</strong></p>
                    ))}
                  </article>
                )}
                <article>
                  <h3>Risk</h3>
                  {detailStrategy.details.risk.map((item) => (
                    <p key={`${item.label}-${item.value}`}><span>{item.label}</span><strong>{item.value}</strong></p>
                  ))}
                </article>
                {riskVisibilityLevel === "detailed" && (
                  <article>
                    <h3>Provider addresses</h3>
                    {detailStrategy.details.addresses.map((item) => (
                      <p key={`${item.label}-${item.value}`}><span>{item.label}</span><strong>{item.value}</strong></p>
                    ))}
                  </article>
                )}
              </div>
            )}

            <div className="defi-modal-disclosures">
              {riskVisibilityLevel !== "minimal" && (detailStrategy.disclosures || []).map((item) => <p key={item}>{item}</p>)}
              {!summary.transactionEnabled && <p>Transactions remain disabled until provider addresses and bridge routes are verified.</p>}
            </div>
          </section>
        </div>
      )}
    </CreatorDashboardShell>
  );
}

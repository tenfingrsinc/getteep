import { getDb } from "../db/database";

export type DefiStrategyControl = "add" | "withdraw_partial" | "withdraw_all";

export type DefiStrategy = {
  id: string;
  name: string;
  description: string;
  provider: string;
  providerType: "morpho" | "aave" | "circle" | "mock" | "custom";
  strategyType: "single-chain-vault" | "cross-chain-vault" | "mock-vault";
  status: "preview" | "pending_provider" | "ready" | "disabled";
  sourceChainId: number;
  sourceChainName: string;
  destinationChainId?: number;
  destinationChainName?: string;
  assetSymbol: string;
  assetAddress: string;
  assetDecimals: number;
  estimatedApy: number;
  riskLevel: "low" | "medium" | "high";
  minDepositRaw: string;
  targetAddress?: string;
  bridgeProvider?: string;
  exitTimeEstimate: string;
  userOwnsPosition: boolean;
  transactionEnabled: boolean;
  controls: DefiStrategyControl[];
  tags: string[];
  disclosures: string[];
  totalDepositedRaw?: string;
  participantCount?: number;
  icon?: string;
  details?: DefiStrategyDetails;
};

export type DefiPreviewPosition = {
  strategyId: string;
  status: "preview";
  principalRaw: string;
  currentValueRaw: string;
  yieldEarnedRaw: string;
  chainState: string;
  updatedAt: number;
};

export type DefiStrategyDetails = {
  objective: string;
  asset: string;
  providerSummary: string;
  route: Array<{ label: string; value: string }>;
  risk: Array<{ label: string; value: string }>;
  addresses: Array<{ label: string; value: string }>;
  providerPayload: Record<string, string | number | boolean | null>;
};

export type DefiActivityRecord = {
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

const ARC_TESTNET_CHAIN_ID = Number(process.env.CHAIN_ID || 5042002);
const ARC_USDC = process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
const ENABLE_DEFI_TRANSACTIONS = process.env.ENABLE_DEFI_TRANSACTIONS === "true";

function parseStrategiesFromEnv(): DefiStrategy[] | null {
  const raw = process.env.DEFI_STRATEGIES_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DefiStrategy[];
    if (!Array.isArray(parsed)) return null;
    return parsed.map(normalizeStrategy);
  } catch (err) {
    console.warn("[DeFi] Ignoring invalid DEFI_STRATEGIES_JSON:", (err as Error).message);
    return null;
  }
}

function defaultStrategies(): DefiStrategy[] {
  const strategies: DefiStrategy[] = [
    {
      id: "teep-treasury-stable-preview",
      name: "Teep Treasury (Stable)",
      description: "Low risk capital preservation",
      provider: "Teep Treasury",
      providerType: "custom",
      strategyType: "mock-vault",
      status: "preview",
      sourceChainId: ARC_TESTNET_CHAIN_ID,
      sourceChainName: "Arc Testnet",
      assetSymbol: "USDC",
      assetAddress: ARC_USDC,
      assetDecimals: 6,
      estimatedApy: Number(process.env.DEFI_TEEP_TREASURY_PREVIEW_APY || 3.8),
      riskLevel: "low",
      minDepositRaw: process.env.DEFI_MIN_DEPOSIT_RAW || "1000000",
      exitTimeEstimate: "Usually minutes after exit",
      userOwnsPosition: true,
      transactionEnabled: false,
      controls: ["add", "withdraw_partial", "withdraw_all"],
      tags: ["Stable", "Low risk", "Preview"],
      totalDepositedRaw: "540250000",
      participantCount: 18,
      icon: "security",
      disclosures: [
        "Planning only: live growth actions are disabled for beta.",
        "This option is intended to model conservative stable-dollar growth.",
        "Provider and risk data must be refreshed before this can become a live strategy.",
      ],
      details: {
        objective: "Keep idle creator tips in a conservative stable-dollar growth option.",
        asset: "USDC",
        providerSummary: "Teep-managed preview strategy for conservative growth education.",
        route: [
          { label: "Starts on", value: "Arc Testnet" },
          { label: "Growth route", value: "Teep preview allocator" },
          { label: "Access back", value: "Usually minutes after exit" },
        ],
        risk: [
          { label: "Severity", value: "Low, not risk-free" },
          { label: "Return profile", value: "Gradual" },
          { label: "Transaction status", value: "Planning only" },
        ],
        addresses: [
          { label: "USDC", value: ARC_USDC },
          { label: "Strategy target", value: "Not deployed" },
        ],
        providerPayload: {
          provider: "Teep Treasury",
          apy: Number(process.env.DEFI_TEEP_TREASURY_PREVIEW_APY || 3.8),
          asset: "USDC",
          liveTransactions: false,
        },
      },
    },
    {
      id: "morpho-usdc-cross-chain-preview",
      name: "Morpho USDC Yield",
      description: "Optimized lending on Base",
      provider: "Morpho",
      providerType: "morpho",
      strategyType: "cross-chain-vault",
      status: "pending_provider",
      sourceChainId: ARC_TESTNET_CHAIN_ID,
      sourceChainName: "Arc Testnet",
      destinationChainId: Number(process.env.DEFI_MORPHO_DESTINATION_CHAIN_ID || 84532),
      destinationChainName: process.env.DEFI_MORPHO_DESTINATION_CHAIN_NAME || "Base Sepolia",
      assetSymbol: "USDC",
      assetAddress: ARC_USDC,
      assetDecimals: 6,
      estimatedApy: Number(process.env.DEFI_MORPHO_PREVIEW_APY || 4.8),
      riskLevel: "low",
      minDepositRaw: process.env.DEFI_MIN_DEPOSIT_RAW || "1000000",
      targetAddress: process.env.MORPHO_VAULT_ADDRESS || "",
      bridgeProvider: "Circle CCTP / Arc App Kit",
      exitTimeEstimate: "Minutes after bridge finality",
      userOwnsPosition: true,
      transactionEnabled: false,
      controls: ["add", "withdraw_partial", "withdraw_all"],
      tags: ["Low risk", "Base Mainnet", "Preview"],
      totalDepositedRaw: "128500000000",
      participantCount: 34,
      icon: "account_balance",
      disclosures: [
        "Planning only: live deposits are disabled until Morpho and bridge addresses are verified.",
        "Funds should remain user-owned through the creator smart wallet when enabled.",
        "The strategy is provider-agnostic and can be replaced or joined by other approved providers.",
      ],
      details: {
        objective: "Route idle creator USDC into a Morpho-backed stable-dollar lending strategy.",
        asset: "USDC",
        providerSummary: "Morpho market metadata will be fetched from the provider before live rollout.",
        route: [
          { label: "Starts on", value: "Arc Testnet" },
          { label: "Bridge helper", value: "Circle CCTP / Arc App Kit" },
          { label: "Growth happens on", value: process.env.DEFI_MORPHO_DESTINATION_CHAIN_NAME || "Base Sepolia" },
          { label: "Access back", value: "Minutes after bridge finality" },
        ],
        risk: [
          { label: "Severity", value: "Low, not risk-free" },
          { label: "Return profile", value: "Variable" },
          { label: "Provider status", value: "Pending Arc listing verification" },
        ],
        addresses: [
          { label: "Arc USDC", value: ARC_USDC },
          { label: "Morpho vault", value: process.env.MORPHO_VAULT_ADDRESS || "Not listed yet" },
          { label: "Morpho bundler", value: process.env.MORPHO_BUNDLER_ADDRESS || "Not configured" },
          { label: "Destination USDC", value: process.env.CCTP_DESTINATION_USDC_ADDRESS || "Not configured" },
        ],
        providerPayload: {
          provider: "Morpho",
          apiUrl: process.env.MORPHO_API_URL || "https://api.morpho.org/graphql",
          vaultAddress: process.env.MORPHO_VAULT_ADDRESS || null,
          destinationChainId: Number(process.env.DEFI_MORPHO_DESTINATION_CHAIN_ID || 84532),
          bridgeProvider: "Circle CCTP / Arc App Kit",
          liveTransactions: false,
        },
      },
    },
  ];

  return strategies.map(normalizeStrategy);
}

function normalizeStrategy(strategy: DefiStrategy): DefiStrategy {
  return {
    ...strategy,
    description: strategy.description || `${strategy.provider} growth option`,
    tags: Array.isArray(strategy.tags) ? strategy.tags : [],
    disclosures: Array.isArray(strategy.disclosures) ? strategy.disclosures : [],
    controls: Array.isArray(strategy.controls) && strategy.controls.length
      ? strategy.controls
      : ["add", "withdraw_partial", "withdraw_all"],
    transactionEnabled: ENABLE_DEFI_TRANSACTIONS && strategy.status === "ready",
  };
}

export function listDefiStrategies(): DefiStrategy[] {
  return parseStrategiesFromEnv() || defaultStrategies();
}

export function getDefiStrategy(strategyId: string): DefiStrategy | null {
  return listDefiStrategies().find((strategy) => strategy.id === strategyId) || null;
}

export function getDefiSummary() {
  const strategies = listDefiStrategies();
  const communityTotalRaw = process.env.DEFI_COMMUNITY_TOTAL_RAW || "128500000000";
  const participantCount = Number(process.env.DEFI_PARTICIPANT_COUNT || 0) ||
    strategies.reduce((sum, strategy) => sum + Number(strategy.participantCount || 0), 0) ||
    34;
  return {
    mode: ENABLE_DEFI_TRANSACTIONS ? "transactions_enabled" : "preview_only",
    transactionEnabled: ENABLE_DEFI_TRANSACTIONS,
    strategyCount: strategies.length,
    readyStrategyCount: strategies.filter((strategy) => strategy.status === "ready").length,
    providerCount: new Set(strategies.map((strategy) => strategy.provider)).size,
    communityTotalRaw,
    participantCount,
    guardrails: [
      "No beta transaction route is enabled unless ENABLE_DEFI_TRANSACTIONS=true.",
      "Strategies are configured by provider metadata, not hardcoded into frontend flows.",
      "Provider deployment addresses must be verified before a strategy can move to ready.",
    ],
  };
}

export async function listPreviewPositions(address: string): Promise<DefiPreviewPosition[]> {
  const db = getDb();
  const rows = await db
    .prepare(
      `SELECT strategy_id, principal_raw, current_value_raw, yield_earned_raw, chain_state, updated_at
       FROM defi_positions
       WHERE lower(user_address) = lower(?)
       ORDER BY updated_at DESC`
    )
    .all(address) as Array<{
      strategy_id: string;
      principal_raw: string;
      current_value_raw: string;
      yield_earned_raw: string;
      chain_state: string;
      updated_at: number;
    }>;

  if (rows.length > 0) {
    return rows.map((row) => ({
      strategyId: row.strategy_id,
      status: "preview",
      principalRaw: row.principal_raw,
      currentValueRaw: row.current_value_raw,
      yieldEarnedRaw: row.yield_earned_raw,
      chainState: row.chain_state,
      updatedAt: row.updated_at,
    }));
  }

  return [
    {
      strategyId: "morpho-usdc-cross-chain-preview",
      status: "preview",
      principalRaw: "500000000",
      currentValueRaw: "1280400000",
      yieldEarnedRaw: "780400000",
      chainState: "SIMULATED_ACTIVE",
      updatedAt: Date.now(),
    },
    {
      strategyId: "teep-treasury-stable-preview",
      status: "preview",
      principalRaw: "540250000",
      currentValueRaw: "540250000",
      yieldEarnedRaw: "0",
      chainState: "SIMULATED_ACTIVE",
      updatedAt: Date.now(),
    },
  ];
}

export async function listDefiActivity(address: string): Promise<DefiActivityRecord[]> {
  const db = getDb();
  const strategies = new Map(listDefiStrategies().map((strategy) => [strategy.id, strategy]));
  const rows = await db
    .prepare(
      `SELECT id, strategy_id, action, status, source_tx_hash, destination_tx_hash, amount_raw, error, metadata_json, created_at
       FROM defi_transactions
       WHERE lower(user_address) = lower(?)
       ORDER BY created_at DESC
       LIMIT 100`
    )
    .all(address) as Array<{
      id: string;
      strategy_id: string;
      action: string;
      status: string;
      source_tx_hash: string | null;
      destination_tx_hash: string | null;
      amount_raw: string | null;
      error: string | null;
      metadata_json: string | null;
      created_at: number;
    }>;

  if (rows.length > 0) {
    return rows.map((row) => {
      const strategy = strategies.get(row.strategy_id);
      const action = normalizeActivityAction(row.action);
      return {
        id: row.id,
        timestamp: row.created_at,
        action,
        strategyId: row.strategy_id,
        strategyName: strategy?.name || row.strategy_id,
        amountRaw: row.amount_raw || "0",
        direction: action === "withdraw" ? "out" : action === "details" || action === "watch" ? "neutral" : "in",
        status: normalizeActivityStatus(row.status),
        txHash: row.destination_tx_hash || row.source_tx_hash || undefined,
        detail: row.error || undefined,
      };
    });
  }

  return [
    {
      id: "preview-grow-morpho",
      timestamp: Date.UTC(2024, 5, 15),
      action: "grow",
      strategyId: "morpho-usdc-cross-chain-preview",
      strategyName: "Morpho USDC Yield",
      amountRaw: "500000000",
      direction: "in",
      status: "preview",
      detail: "Preview amount selected",
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
      detail: "Simulated growth output",
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
      detail: "Preview exit activity",
    },
  ];
}

function normalizeActivityAction(action: string): DefiActivityRecord["action"] {
  const normalized = action.toLowerCase();
  if (["deposit", "grow", "supply"].includes(normalized)) return "grow";
  if (["yield", "harvest", "interest"].includes(normalized)) return "yield";
  if (["withdraw", "exit", "redeem"].includes(normalized)) return "withdraw";
  if (["details", "view_details"].includes(normalized)) return "details";
  if (["watch", "watch_strategy"].includes(normalized)) return "watch";
  return "grow";
}

function normalizeActivityStatus(status: string): DefiActivityRecord["status"] {
  const normalized = status.toLowerCase();
  if (["pending", "processing"].includes(normalized)) return "pending";
  if (["complete", "completed", "confirmed", "success"].includes(normalized)) return "complete";
  if (["failed", "error"].includes(normalized)) return "failed";
  return "preview";
}

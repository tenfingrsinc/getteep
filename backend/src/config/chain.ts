import { defineChain } from "viem";
import { base, baseSepolia } from "viem/chains";

const DEFAULT_ARC_FALLBACK_RPC_URL = "https://rpc.testnet.arc.network";
const configuredArcRpcUrl = process.env.ARC_RPC_URL || process.env.RPC_URL || "";
const configuredArcFallbackRpcUrl = process.env.ARC_FALLBACK_RPC_URL || process.env.RPC_FALLBACK_URL || DEFAULT_ARC_FALLBACK_RPC_URL;
const configuredArcWebSocketUrl = process.env.ARC_WS_URL || "";

export const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: Array.from(new Set([configuredArcRpcUrl, configuredArcFallbackRpcUrl].filter(Boolean))),
      ...(configuredArcWebSocketUrl ? { webSocket: [configuredArcWebSocketUrl] } : {}),
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: "https://testnet.arcscan.app",
    },
  },
  testnet: true,
});

export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000" as const;

export function getConfiguredChain() {
  const chainName = process.env.CHAIN || "arcTestnet";
  if (chainName === "base") return base;
  if (chainName === "baseSepolia") return baseSepolia;
  return arcTestnet;
}

export function getRpcUrl() {
  const chainName = process.env.CHAIN || "arcTestnet";
  const url = chainName === "base"
    ? process.env.BASE_RPC_URL
    : chainName === "baseSepolia"
      ? process.env.BASE_SEPOLIA_RPC_URL
      : process.env.ARC_RPC_URL || process.env.RPC_URL;
  if (!url) throw new Error(`Missing RPC URL for ${chainName}`);
  return url;
}

export function getRpcUrls(primaryUrl = getRpcUrl()) {
  const chainName = process.env.CHAIN || "arcTestnet";
  const fallbackUrl = chainName === "base"
    ? process.env.BASE_FALLBACK_RPC_URL
    : chainName === "baseSepolia"
      ? process.env.BASE_SEPOLIA_FALLBACK_RPC_URL
      : process.env.ARC_FALLBACK_RPC_URL || process.env.RPC_FALLBACK_URL || DEFAULT_ARC_FALLBACK_RPC_URL;
  return Array.from(new Set([primaryUrl, fallbackUrl].filter((value): value is string => Boolean(value))));
}

export function getChainId() {
  return Number(process.env.CHAIN_ID || getConfiguredChain().id);
}

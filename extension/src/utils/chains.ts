import { defineChain } from "viem";

const DEFAULT_ARC_FALLBACK_RPC_URL = "https://rpc.testnet.arc.network";
const configuredArcRpcUrl = process.env.ARC_RPC_URL || process.env.RPC_URL;
const configuredArcFallbackRpcUrl = process.env.ARC_FALLBACK_RPC_URL || process.env.RPC_FALLBACK_URL || DEFAULT_ARC_FALLBACK_RPC_URL;

if (!configuredArcRpcUrl) {
  throw new Error("Missing ARC_RPC_URL or RPC_URL for the Teep extension");
}

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
      http: Array.from(new Set([configuredArcRpcUrl, configuredArcFallbackRpcUrl])),
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

import { defineChain } from "viem";

const DEFAULT_ARC_FALLBACK_RPC_URL = "https://rpc.testnet.arc.network";

function validNetworkUrl(value: string | undefined, protocols: string[]): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const isNetworkHost = parsed.hostname.includes(".") || parsed.hostname.includes(":") || parsed.hostname === "localhost";
    return protocols.includes(parsed.protocol) && isNetworkHost ? parsed.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

const configuredArcRpcUrl = import.meta.env.VITE_ARC_RPC_URL;
const configuredArcFallbackRpcUrl = import.meta.env.VITE_ARC_FALLBACK_RPC_URL;
const configuredArcWebSocketUrl = import.meta.env.VITE_ARC_WS_URL;
const arcRpcUrl = validNetworkUrl(configuredArcRpcUrl, ["https:", "http:"]);
const arcFallbackRpcUrl = configuredArcFallbackRpcUrl
  ? validNetworkUrl(configuredArcFallbackRpcUrl, ["https:", "http:"])
  : DEFAULT_ARC_FALLBACK_RPC_URL;
const arcWebSocketUrl = validNetworkUrl(configuredArcWebSocketUrl, ["wss:", "ws:"]);

if (!arcRpcUrl) {
  throw new Error("Missing or invalid VITE_ARC_RPC_URL for the Teep web app");
}
if (!arcFallbackRpcUrl) {
  throw new Error("Invalid VITE_ARC_FALLBACK_RPC_URL for the Teep web app");
}
if (configuredArcWebSocketUrl && !arcWebSocketUrl) {
  throw new Error("Invalid VITE_ARC_WS_URL for the Teep web app");
}

export const ARC_RPC_URL = arcRpcUrl;
export const ARC_RPC_URLS = Array.from(new Set([arcRpcUrl, arcFallbackRpcUrl]));

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
      http: ARC_RPC_URLS,
      ...(arcWebSocketUrl ? { webSocket: [arcWebSocketUrl] } : {}),
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

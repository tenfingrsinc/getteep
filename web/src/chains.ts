import { defineChain } from "viem";

const arcRpcUrl = import.meta.env.VITE_ARC_RPC_URL;
const arcWebSocketUrl = import.meta.env.VITE_ARC_WS_URL;

if (!arcRpcUrl) {
  throw new Error("Missing VITE_ARC_RPC_URL for the Teep web app");
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
      http: [arcRpcUrl],
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

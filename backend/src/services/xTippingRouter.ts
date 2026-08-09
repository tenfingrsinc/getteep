import { createWalletClient, erc20Abi, keccak256, parseAbi, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getConfiguredChain, getRpcUrl } from "../config/chain";
import { createBackendHttpTransport, createBackendPublicClient } from "./rpcClient";
import { recordServiceFailure, recordServiceSuccess } from "./serviceHealth";
import { getDefaultTokenAddress } from "./teepBalance";

const ROUTER_ABI = parseAbi([
  "function permissions(address user) view returns (bool enabled, uint256 maxPerTip, uint256 maxDaily, uint256 spentToday, uint64 day)",
  "function tipFromX(address sender, bytes32 commandId, bytes32 contentId, uint256 authorId, uint256 amount)",
]);

const FACTORY_ABI = parseAbi([
  "function computeClaimWallet(uint256 authorId) view returns (address)",
]);

const X_TIP_CONFIRMATION_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.X_TIP_CONFIRMATION_TIMEOUT_MS || 20_000)
);

export type XTipSubmission = {
  txHash: `0x${string}`;
  claimWallet: `0x${string}`;
  commandId: Hex;
  contentId: Hex;
};

export class XTipConfirmationPendingError extends Error {
  readonly code = "X_TIP_CONFIRMATION_PENDING";
  constructor(readonly submission: XTipSubmission, readonly causeValue: unknown) {
    super("X_TIP_CONFIRMATION_PENDING");
    this.name = "XTipConfirmationPendingError";
  }
}

export class XTipRevertedError extends Error {
  readonly code = "X_TIP_REVERTED";
  constructor(readonly submission: XTipSubmission) {
    super("X_TIP_REVERTED");
    this.name = "XTipRevertedError";
  }
}

async function trackedArcRpc<T>(operation: string, request: () => Promise<T>): Promise<T> {
  try {
    const value = await request();
    await recordServiceSuccess("arc_rpc", { operation }).catch(() => undefined);
    return value;
  } catch (error) {
    await recordServiceFailure("arc_rpc", error, { operation }).catch(() => undefined);
    throw error;
  }
}

export function getXTippingRouterAddress(): `0x${string}` | null {
  const value = process.env.X_TIPPING_ROUTER_ADDRESS;
  return value && /^0x[a-fA-F0-9]{40}$/.test(value) ? (value as `0x${string}`) : null;
}

export function isXTippingRouterConfigured() {
  return Boolean(getXTippingRouterAddress() && process.env.X_TIPPING_RELAYER_PRIVATE_KEY && process.env.FACTORY_ADDRESS);
}

export function buildXCommandId(sourceTweetId: string): Hex {
  return keccak256(toBytes(`teep:x-command:${sourceTweetId}`));
}

export function buildXDirectCreatorContentId(recipientXUserId: string): Hex {
  return keccak256(toBytes(`teep:direct:x:${recipientXUserId}`));
}

export function buildXPostContentId(authorHandle: string, tweetId: string): Hex {
  const handle = authorHandle.replace(/^@/, "").toLowerCase();
  return keccak256(toBytes(`x.com/${handle}/status/${tweetId}`));
}

export function buildXContentId(recipientXUserId: string, sourceTweetId: string): Hex {
  return keccak256(toBytes(`teep:x-tip:${recipientXUserId}:${sourceTweetId}`));
}

export async function getOnchainXTippingReadiness(params: {
  senderAddress: string;
  totalRaw: bigint;
}) {
  const routerAddress = getXTippingRouterAddress();
  if (!routerAddress) {
    return { ok: false as const, code: "X_ROUTER_NOT_CONFIGURED", reason: "X tipping is not ready yet." };
  }

  const tokenAddress = getDefaultTokenAddress() as `0x${string}`;
  const publicClient = createBackendPublicClient();
  const sender = params.senderAddress as `0x${string}`;

  const [permission, balance, allowance] = await trackedArcRpc("x_tip_readiness", () => Promise.all([
      publicClient.readContract({
        address: routerAddress,
        abi: ROUTER_ABI,
        functionName: "permissions",
        args: [sender],
      }),
      publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [sender],
      }),
      publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [sender, routerAddress],
      }),
    ]));

  const [enabled] = permission;
  if (!enabled) {
    return { ok: false as const, code: "X_TIPPING_DISABLED", reason: "X tip commands are paused for this account. Open Teep settings to enable them." };
  }
  if (balance < params.totalRaw) {
    return { ok: false as const, code: "INSUFFICIENT_BALANCE", reason: "Insufficient Teep balance." };
  }
  if (allowance < params.totalRaw) {
    return { ok: false as const, code: "INSUFFICIENT_ALLOWANCE", reason: "X tipping needs reactivation in Teep settings." };
  }

  return { ok: true as const, balance, allowance };
}

export async function getOnchainTeepBalance(userAddress: string): Promise<bigint> {
  const publicClient = createBackendPublicClient();
  return trackedArcRpc("x_balance", () => publicClient.readContract({
    address: getDefaultTokenAddress() as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [userAddress as `0x${string}`],
  }));
}

export async function computeClaimWallet(authorId: string): Promise<`0x${string}`> {
  const factoryAddress = process.env.FACTORY_ADDRESS as `0x${string}` | undefined;
  if (!factoryAddress || !/^0x[a-fA-F0-9]{40}$/.test(factoryAddress)) {
    throw new Error("FACTORY_ADDRESS_NOT_CONFIGURED");
  }
  const publicClient = createBackendPublicClient();
  return trackedArcRpc("compute_claim_wallet", () => publicClient.readContract({
    address: factoryAddress,
    abi: FACTORY_ABI,
    functionName: "computeClaimWallet",
    args: [BigInt(authorId)],
  }));
}

export async function relayXTip(params: {
  senderAddress: string;
  recipientXUserId: string;
  commandTweetId: string;
  contentId: Hex;
  amountRaw: bigint;
}, hooks?: {
  onSubmitted?: (submission: XTipSubmission) => Promise<void>;
}) {
  const routerAddress = getXTippingRouterAddress();
  const privateKey = process.env.X_TIPPING_RELAYER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!routerAddress || !privateKey) throw new Error("X_ROUTER_NOT_CONFIGURED");

  const account = privateKeyToAccount(privateKey);
  const chain = getConfiguredChain();
  const walletClient = createWalletClient({
    account,
    chain,
    transport: createBackendHttpTransport(getRpcUrl()),
  });
  const publicClient = createBackendPublicClient();

  const commandId = buildXCommandId(params.commandTweetId);
  const contentId = params.contentId;
  const authorId = BigInt(params.recipientXUserId);
  // Resolve the deterministic destination before broadcast so no additional
  // address lookup can turn an accepted transaction into a reported failure.
  const claimWallet = await computeClaimWallet(params.recipientXUserId);

  const txHash = await trackedArcRpc("x_tip_submit", () => walletClient.writeContract({
      address: routerAddress,
      abi: ROUTER_ABI,
      functionName: "tipFromX",
      args: [params.senderAddress as `0x${string}`, commandId, contentId, authorId, params.amountRaw],
    }));
  const submission: XTipSubmission = {
    txHash: txHash.toLowerCase() as `0x${string}`,
    claimWallet: claimWallet.toLowerCase() as `0x${string}`,
    commandId,
    contentId,
  };

  try {
    await hooks?.onSubmitted?.(submission);
  } catch (error) {
    throw new XTipConfirmationPendingError(submission, error);
  }

  let receipt;
  try {
    receipt = await trackedArcRpc("x_tip_receipt", () => publicClient.waitForTransactionReceipt({
      hash: submission.txHash,
      timeout: X_TIP_CONFIRMATION_TIMEOUT_MS,
    }));
  } catch (error) {
    throw new XTipConfirmationPendingError(submission, error);
  }

  if (receipt.status !== "success") {
    throw new XTipRevertedError(submission);
  }

  return submission;
}

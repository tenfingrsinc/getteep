import React, { useCallback, useEffect, useRef, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  http,
  isAddressEqual,
  parseUnits,
  toFunctionSelector,
} from "viem";
import { CONFIG, TIP_CONTRACT_ABI, USDC_ABI } from "../utils/config";
import { debugLog } from "../utils/debug";
import { rememberLocalTipSent } from "../utils/localTipLedger";
import { getTipIntent, updateTipIntent } from "../utils/tipIntent";

type PendingTip = {
  requestId?: string;
  intentKey?: string;
  requestKey?: string;
  contentId: string;
  authorHandle: string;
  authorId?: string;
  from?: string;
  tweetId?: string;
  amount: number | string;
  rawAmount?: string;
  receiptPreferences?: {
    shareAmountEnabled?: boolean;
    shareLinksEnabled?: boolean;
    postAwareCopyEnabled?: boolean;
  };
  needsApproval?: boolean;
  approveData?: { to: string; data: string } | null;
  tipData: { to: string; data: string };
};

type SignStatus = "loading" | "preparing" | "ready" | "sending" | "confirming" | "pending" | "success" | "error";

class TipPreparationError extends Error {
  constructor() {
    super("Tip preparation failed");
    this.name = "TipPreparationError";
  }
}

class TipValidationError extends Error {
  constructor(message = "This tip could not be verified. Close this window and try again.") {
    super(message);
    this.name = "TipValidationError";
  }
}

class TipReceiptError extends Error {
  constructor(message: string, readonly final: boolean) {
    super(message);
    this.name = "TipReceiptError";
  }
}

const APPROVE_SELECTOR = toFunctionSelector("approve(address,uint256)");
const TIP_SELECTOR = toFunctionSelector("tip(bytes32,uint256,uint256)");
const receiptClient = createPublicClient({
  chain: CONFIG.CHAIN,
  transport: http(CONFIG.RPC_URL),
});

function sameHex(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function requireSameAddress(actual: string | undefined, expected: `0x${string}`) {
  if (!actual) throw new TipValidationError();
  try {
    if (!isAddressEqual(actual as `0x${string}`, expected)) throw new TipValidationError();
  } catch {
    throw new TipValidationError();
  }
}

async function validateTipCalls(params: {
  pendingTip: PendingTip;
  requestId: string;
  smartClient: any;
}) {
  const { pendingTip, requestId, smartClient } = params;
  const intentKey = pendingTip.intentKey || pendingTip.requestKey;
  if (!intentKey || !requestId) throw new TipValidationError();

  const intent = await getTipIntent(intentKey);
  if (
    !intent ||
    intent.attemptId !== requestId ||
    intent.status !== "signing" ||
    intent.chainId !== CONFIG.CHAIN_ID ||
    !intent.authorId ||
    typeof intent.needsApproval !== "boolean"
  ) {
    throw new TipValidationError();
  }

  const clientChainId = Number(await smartClient.getChainId());
  if (clientChainId !== CONFIG.CHAIN_ID) throw new TipValidationError();
  requireSameAddress(smartClient.account?.address, intent.from as `0x${string}`);

  const pendingRawAmount =
    pendingTip.rawAmount ?? parseUnits(String(pendingTip.amount), CONFIG.USDC_DECIMALS).toString();
  if (
    pendingTip.contentId.toLowerCase() !== intent.contentId ||
    pendingTip.authorHandle.replace(/^@/, "").toLowerCase() !== intent.authorHandle ||
    pendingTip.authorId !== intent.authorId ||
    pendingRawAmount !== intent.rawAmount ||
    pendingTip.from?.toLowerCase() !== intent.from
  ) {
    throw new TipValidationError();
  }

  const amount = BigInt(intent.rawAmount);
  const authorId = BigInt(intent.authorId);
  const calls: Array<{ to: `0x${string}`; data: `0x${string}` }> = [];

  if (intent.needsApproval) {
    const approval = pendingTip.approveData;
    if (!approval || approval.data.slice(0, 10).toLowerCase() !== APPROVE_SELECTOR.toLowerCase()) {
      throw new TipValidationError();
    }
    requireSameAddress(approval.to, CONFIG.USDC_ADDRESS);
    const decoded = decodeFunctionData({ abi: USDC_ABI, data: approval.data as `0x${string}` });
    if (decoded.functionName !== "approve") throw new TipValidationError();
    const [spender, decodedAmount] = decoded.args as readonly [`0x${string}`, bigint];
    requireSameAddress(spender, CONFIG.TIP_CONTRACT_ADDRESS);
    if (decodedAmount !== amount) throw new TipValidationError();
    const expectedApproval = encodeFunctionData({
      abi: USDC_ABI,
      functionName: "approve",
      args: [CONFIG.TIP_CONTRACT_ADDRESS, amount],
    });
    if (!sameHex(approval.data, expectedApproval)) throw new TipValidationError();
    calls.push({ to: CONFIG.USDC_ADDRESS, data: expectedApproval });
  } else if (pendingTip.approveData) {
    throw new TipValidationError();
  }

  if (
    !pendingTip.tipData ||
    pendingTip.tipData.data.slice(0, 10).toLowerCase() !== TIP_SELECTOR.toLowerCase()
  ) {
    throw new TipValidationError();
  }
  requireSameAddress(pendingTip.tipData.to, CONFIG.TIP_CONTRACT_ADDRESS);
  const decodedTip = decodeFunctionData({
    abi: TIP_CONTRACT_ABI,
    data: pendingTip.tipData.data as `0x${string}`,
  });
  if (decodedTip.functionName !== "tip") throw new TipValidationError();
  const [decodedContentId, decodedAuthorId, decodedAmount] = decodedTip.args as readonly [
    `0x${string}`,
    bigint,
    bigint,
  ];
  if (
    decodedContentId.toLowerCase() !== intent.contentId ||
    decodedAuthorId !== authorId ||
    decodedAmount !== amount
  ) {
    throw new TipValidationError();
  }
  const expectedTip = encodeFunctionData({
    abi: TIP_CONTRACT_ABI,
    functionName: "tip",
    args: [intent.contentId as `0x${string}`, authorId, amount],
  });
  if (!sameHex(pendingTip.tipData.data, expectedTip)) throw new TipValidationError();
  calls.push({ to: CONFIG.TIP_CONTRACT_ADDRESS, data: expectedTip });

  return { calls, intentKey };
}

function compactError(err: unknown) {
  const e = err as any;
  return {
    name: e?.name,
    message: e?.message ?? String(err),
    shortMessage: e?.shortMessage,
    details: e?.details,
    code: e?.code,
    cause: e?.cause
      ? {
          name: e.cause?.name,
          message: e.cause?.message,
          shortMessage: e.cause?.shortMessage,
          details: e.cause?.details,
          code: e.cause?.code,
        }
      : undefined,
  };
}

function getTipErrorMessage(err: unknown): string {
  if (err instanceof TipReceiptError) return err.message;
  const e = err as any;
  const msg = String(e?.shortMessage ?? e?.message ?? e?.details ?? "").toLowerCase();
  if (msg.includes("user rejected") || msg.includes("user denied") || msg.includes("rejected the request")) {
    return "You cancelled the confirmation.";
  }
  if (
    msg.includes("insufficient") ||
    msg.includes("exceeds balance") ||
    msg.includes("transfer amount") ||
    msg.includes("execution reverted") ||
    msg.includes("unknown reason") ||
    msg.includes("revert")
  ) {
    return "Insufficient funds to tip";
  }
  return "We couldn't send this tip. Please try again.";
}

function receiptTweet(params: { amount: string; authorHandle: string; tweetId?: string; txHash?: string; receiptPreferences?: { shareAmountEnabled?: boolean; shareLinksEnabled?: boolean; postAwareCopyEnabled?: boolean } }) {
  const handle = params.authorHandle.replace(/^@/, "");
  const postUrl = params.tweetId ? `https://x.com/${handle}/status/${params.tweetId}` : "";
  const receiptUrl = params.txHash ? `${CONFIG.RECEIPT_BASE_URL}/tx/${params.txHash}` : CONFIG.WEB_APP_URL;
  const amountPart = params.receiptPreferences?.shareAmountEnabled === false ? "" : ` $${params.amount}`;
  const receiptPart = `\n\nReceipt: ${receiptUrl}`;
  const firstLine = postUrl
    ? `Hey @${handle}, just tipped you${amountPart} via Teep for this wonderful piece: ${postUrl}`
    : `Hey @${handle}, just tipped you${amountPart} via Teep`;
  return `${firstLine}${receiptPart}\nSupport creators directly via @teepxyz.`;
}

function formatTipAmount(amount: number | string | undefined) {
  const numeric = Number(amount ?? 0);
  if (!Number.isFinite(numeric)) return `$${amount ?? "0"}`;
  return `$${numeric.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Preparation timed out")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function getRequestIdFromUrl() {
  return new URLSearchParams(window.location.search).get("requestId") || "";
}

function storageKeys(requestId?: string) {
  return {
    pendingKey: requestId ? `pendingTip:${requestId}` : "pendingTip",
    resultKey: requestId ? `tipResult:${requestId}` : "tipResult",
  };
}

const S = {
  app: {
    width: "360px",
    height: "440px",
    minHeight: "0",
    overflow: "hidden",
    background: "#161121",
    color: "#fff",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    display: "flex",
    flexDirection: "column" as const,
  },
  header: {
    height: "54px",
    padding: "0 16px",
    borderBottom: "1px solid #2d2839",
    display: "flex",
    alignItems: "center",
    gap: "9px",
    flexShrink: 0,
  },
  main: {
    padding: "14px 16px 16px",
    flex: 1,
    minHeight: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  card: {
    width: "100%",
    maxWidth: "328px",
    border: "1px solid #2d2839",
    borderRadius: "16px",
    background: "#11121a",
    padding: "16px",
  },
  label: {
    color: "#8b97aa",
    fontSize: "12px",
    fontWeight: 800,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
  },
  primaryBtn: {
    width: "100%",
    border: "none",
    borderRadius: "10px",
    minHeight: "42px",
    background: "#6d28d9",
    color: "#fff",
    fontSize: "14px",
    fontWeight: 800,
    cursor: "pointer",
  },
  ghostBtn: {
    width: "100%",
    border: "1px solid #2d2839",
    borderRadius: "10px",
    minHeight: "40px",
    background: "transparent",
    color: "#8b97aa",
    fontSize: "13px",
    fontWeight: 700,
    cursor: "pointer",
  },
  amount: {
    fontSize: "40px",
    lineHeight: 1,
    fontWeight: 900,
    textAlign: "center" as const,
    margin: "12px 0 8px",
  },
  helper: {
    color: "#8b97aa",
    fontSize: "12px",
    lineHeight: 1.45,
    textAlign: "center" as const,
    margin: "0",
  },
  summaryBox: {
    border: "1px solid #252b3a",
    borderRadius: "12px",
    padding: "11px 12px",
    background: "#0d111a",
    marginBottom: "10px",
  },
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    minHeight: "22px",
  },
};

export function SignTipApp() {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { client, getClientForChain } = useSmartWallets();
  const [pendingTip, setPendingTip] = useState<PendingTip | null>(null);
  const [status, setStatus] = useState<SignStatus>("loading");
  const [error, setError] = useState("");
  const [diagnostic, setDiagnostic] = useState("");
  const [txHash, setTxHash] = useState("");
  const [preparationSlow, setPreparationSlow] = useState(false);
  const [canRetryPreparation, setCanRetryPreparation] = useState(false);
  const clientRef = useRef<any>(client);
  const preparationPromiseRef = useRef<Promise<any> | null>(null);
  const preparationRunRef = useRef(0);
  const submissionStartedRef = useRef(false);

  const embeddedWallet = wallets.find((wallet) => wallet.walletClientType === "privy");
  const amountLabel = formatTipAmount(pendingTip?.amount);
  const recipientLabel = pendingTip?.authorHandle ? `@${pendingTip.authorHandle.replace(/^@/, "")}` : "this creator";
  const requestId = getRequestIdFromUrl();
  const { pendingKey } = storageKeys(requestId);

  useEffect(() => {
    if (client?.account?.address) clientRef.current = client;
  }, [client]);

  const createActivityProof = useCallback(async (smartClient: any) => {
    const address = smartClient?.account?.address;
    if (!address) throw new Error("Wallet not ready");
    const challengeRes = await fetch(`${CONFIG.API_BASE_URL}/auth/wallet/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, purpose: "activity-write" }),
    });
    const challenge = await challengeRes.json();
    if (!challengeRes.ok || !challenge.message) throw new Error(challenge.error || "Could not verify wallet");
    const signature = await smartClient.signMessage({
      account: smartClient.account,
      message: challenge.message,
    } as any);
    return { message: challenge.message, signature };
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousWidth = document.body.style.width;
    const previousHeight = document.body.style.height;
    const previousMinHeight = document.body.style.minHeight;
    const root = document.getElementById("root");
    const previousRootHeight = root?.style.height;
    const previousRootMinHeight = root?.style.minHeight;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    document.body.style.width = "360px";
    document.body.style.height = "440px";
    document.body.style.minHeight = "0";
    if (root) {
      root.style.height = "440px";
      root.style.minHeight = "0";
    }
    return () => {
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.width = previousWidth;
      document.body.style.height = previousHeight;
      document.body.style.minHeight = previousMinHeight;
      if (root) {
        root.style.height = previousRootHeight || "";
        root.style.minHeight = previousRootMinHeight || "";
      }
    };
  }, []);

  useEffect(() => {
    chrome.storage.local.get([pendingKey, "pendingTip"], (stored) => {
      const scopedPending = stored[pendingKey] as PendingTip | undefined;
      const legacyPending = stored.pendingTip as PendingTip | undefined;
      const nextPending = scopedPending || (!requestId || legacyPending?.requestId === requestId ? legacyPending : undefined);
      if (nextPending) {
        setPendingTip(nextPending);
        setStatus("ready");
      } else {
        setStatus("error");
        setError("There isn't a tip ready to confirm.");
      }
    });
  }, [pendingKey, requestId]);

  const prepareClient = useCallback(async (force = false) => {
    if (clientRef.current?.account?.address && !force) return clientRef.current;
    if (preparationPromiseRef.current && !force) return preparationPromiseRef.current;

    const runId = preparationRunRef.current + 1;
    preparationRunRef.current = runId;
    setStatus("preparing");
    setError("");
    setDiagnostic("");
    setCanRetryPreparation(false);
    setPreparationSlow(false);

    const slowTimer = window.setTimeout(() => {
      if (preparationRunRef.current === runId) setPreparationSlow(true);
    }, 8000);

    const preparation = (async () => {
      let lastError: unknown;
      const delays = [0, 600, 1200, 2200, 3400];
      for (let attempt = 0; attempt < delays.length; attempt += 1) {
        if (preparationRunRef.current !== runId) throw new Error("Preparation replaced");
        if (delays[attempt] > 0) await wait(delays[attempt]);
        if (clientRef.current?.account?.address && !force) return clientRef.current;

        try {
          const preparedClient = await withTimeout(
            getClientForChain({ id: CONFIG.CHAIN_ID }),
            5000
          );
          if (preparedClient?.account?.address) {
            clientRef.current = preparedClient;
            return preparedClient;
          }
          lastError = new Error("No client returned");
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError || new Error("Preparation failed");
    })();

    preparationPromiseRef.current = preparation;
    try {
      const preparedClient = await preparation;
      if (preparationRunRef.current === runId) {
        setPreparationSlow(false);
        setStatus("ready");
      }
      return preparedClient;
    } catch (err) {
      if (preparationRunRef.current === runId) {
        setPreparationSlow(false);
        setCanRetryPreparation(true);
        setError("We couldn't get your tip ready. Please try again.");
        setDiagnostic(JSON.stringify(compactError(err), null, 2));
        setStatus("error");
      }
      throw new TipPreparationError();
    } finally {
      window.clearTimeout(slowTimer);
      if (preparationRunRef.current === runId) preparationPromiseRef.current = null;
    }
  }, [getClientForChain]);

  useEffect(() => {
    if (!ready || !authenticated || !pendingTip || !embeddedWallet?.address) return;
    if (status !== "ready" && status !== "loading") return;
    void prepareClient().catch(() => {});
  }, [
    authenticated,
    embeddedWallet?.address,
    pendingTip,
    prepareClient,
    ready,
    status,
  ]);

  const retryPreparation = useCallback(() => {
    preparationRunRef.current += 1;
    preparationPromiseRef.current = null;
    void prepareClient(true).catch(() => {});
  }, [prepareClient]);

  const executeTip = useCallback(async () => {
    if (submissionStartedRef.current) return;
    if (!pendingTip) {
      setStatus("error");
      setError("No pending tip. Close and try again from the tweet.");
      return;
    }
    if (!authenticated) {
      await login();
      return;
    }
    if (status === "preparing") return;

    setError("");
    setDiagnostic("");

    let submittedHash = "";
    let receiptConfirmed = false;
    try {
      const smartClient = clientRef.current?.account?.address
        ? clientRef.current
        : await prepareClient();
      const resolvedRequestId = pendingTip.requestId || requestId;
      const { calls, intentKey } = await validateTipCalls({
        pendingTip,
        requestId: resolvedRequestId,
        smartClient,
      });

      submissionStartedRef.current = true;
      setStatus("sending");
      const hash = await smartClient.sendTransaction({
        calls,
        account: smartClient.account,
      } as any, {
        uiOptions: { showWalletUIs: false },
      });
      submittedHash = hash;

      await updateTipIntent(intentKey, resolvedRequestId, {
        status: "submitted",
        txHash: hash,
        error: undefined,
        windowId: undefined,
      });

      setStatus("confirming");
      let receipt;
      try {
        receipt = await receiptClient.waitForTransactionReceipt({
          hash: hash as `0x${string}`,
          confirmations: 1,
          timeout: 120_000,
        });
      } catch (err) {
        throw new TipReceiptError("Your tip was submitted and is still confirming.", false);
      }
      if (receipt.status !== "success") {
        await updateTipIntent(intentKey, resolvedRequestId, {
          status: "failed",
          txHash: hash,
          error: "Transaction reverted",
          windowId: undefined,
        });
        throw new TipReceiptError("The network did not complete this tip.", true);
      }
      receiptConfirmed = true;
      await updateTipIntent(intentKey, resolvedRequestId, {
        status: "confirmed",
        txHash: hash,
        error: undefined,
        windowId: undefined,
      });

      const rawAmount = pendingTip.rawAmount ?? parseUnits(String(pendingTip.amount), CONFIG.USDC_DECIMALS).toString();
      const resolvedResultKey = storageKeys(resolvedRequestId).resultKey;
      const resultPayload = {
        requestId: resolvedRequestId,
        contentId: pendingTip.contentId,
        success: true,
        txHash: hash,
        amount: pendingTip.amount,
        timestamp: Date.now(),
      };
      await chrome.storage.local.set({
        [resolvedResultKey]: resultPayload,
        tipResult: resultPayload,
      });
      await rememberLocalTipSent({
        type: "tip_sent",
        fromAddress: smartClient.account.address.toLowerCase(),
        amount: rawAmount,
        tx_hash: hash.toLowerCase(),
        timestamp: Date.now(),
        author_handle: pendingTip.authorHandle,
        tweet_id: pendingTip.tweetId,
        detail: pendingTip.authorHandle ? `Tipped @${pendingTip.authorHandle}` : "Tip sent",
        local: true,
      });
      const keysToRemove = [storageKeys(resolvedRequestId).pendingKey];
      if (pendingTip.requestId) keysToRemove.push("pendingTip");
      await chrome.storage.local.remove(keysToRemove);
      chrome.runtime.sendMessage({
        type: "TIP_TX_COMPLETE",
        payload: {
          success: true,
          intentStatus: "confirmed",
          txHash: hash,
          requestId: resolvedRequestId,
          intentKey,
        },
      }).catch(() => {});
      setTxHash(hash);
      setStatus("success");

      await fetch(`${CONFIG.API_BASE_URL}/tips/metadata`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contentId: pendingTip.contentId,
          authorHandle: pendingTip.authorHandle,
          tweetId: pendingTip.tweetId,
        }),
      }).catch(() => {});
      await fetch(`${CONFIG.API_BASE_URL}/tips/activity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "tip_sent",
          fromAddress: smartClient.account.address.toLowerCase(),
          amount: rawAmount,
          txHash: hash,
          authorHandle: pendingTip.authorHandle,
          tweetId: pendingTip.tweetId,
          detail: pendingTip.authorHandle ? `Tipped @${pendingTip.authorHandle}` : "Tip sent",
          sourceMethod: "extension",
          walletProof: await createActivityProof(smartClient),
        }),
      }).catch(() => {});

      debugLog("SignTip", "tx success", {
        txHash: hash,
        smartWallet: smartClient.account.address,
        embeddedWallet: embeddedWallet?.address,
      });
    } catch (err) {
      submissionStartedRef.current = false;
      if (err instanceof TipPreparationError) return;
      if (submittedHash && !receiptConfirmed && err instanceof TipReceiptError && !err.final) {
        const resolvedRequestId = pendingTip.requestId || requestId;
        const intentKey = pendingTip.intentKey || pendingTip.requestKey;
        const pendingResult = {
          requestId: resolvedRequestId,
          contentId: pendingTip.contentId,
          success: false,
          pending: true,
          txHash: submittedHash,
          amount: pendingTip.amount,
          error: err.message,
          timestamp: Date.now(),
        };
        await chrome.storage.local.set({
          [storageKeys(resolvedRequestId).resultKey]: pendingResult,
          tipResult: pendingResult,
        }).catch(() => {});
        chrome.runtime.sendMessage({
          type: "TIP_TX_COMPLETE",
          payload: {
            success: false,
            pending: true,
            intentStatus: "submitted",
            txHash: submittedHash,
            requestId: resolvedRequestId,
            intentKey,
            error: err.message,
          },
        }).catch(() => {});
        setTxHash(submittedHash);
        setError(err.message);
        setStatus("pending");
        debugLog("SignTip", "tx submitted and awaiting receipt", compactError(err));
        return;
      }
      if (submittedHash && receiptConfirmed) {
        const resolvedRequestId = pendingTip.requestId || requestId;
        const intentKey = pendingTip.intentKey || pendingTip.requestKey;
        if (intentKey) {
          await updateTipIntent(intentKey, resolvedRequestId, {
            status: "submitted",
            txHash: submittedHash,
            error: undefined,
            windowId: undefined,
          }).catch(() => null);
        }
        const recoveredResult = {
          requestId: resolvedRequestId,
          contentId: pendingTip.contentId,
          success: true,
          txHash: submittedHash,
          amount: pendingTip.amount,
          timestamp: Date.now(),
        };
        await chrome.storage.local.set({
          [storageKeys(resolvedRequestId).resultKey]: recoveredResult,
          tipResult: recoveredResult,
        }).catch(() => {});
        chrome.runtime.sendMessage({
          type: "TIP_TX_COMPLETE",
          payload: {
            success: true,
            intentStatus: "confirmed",
            txHash: submittedHash,
            requestId: resolvedRequestId,
            intentKey,
          },
        }).catch(() => {});
        setTxHash(submittedHash);
        setStatus("success");
        debugLog("SignTip", "tx submitted; recovered after local finalization error", compactError(err));
        return;
      }
      const compact = compactError(err);
      const message = getTipErrorMessage(err);
      const resolvedRequestId = pendingTip.requestId || requestId;
      const intentKey = pendingTip.intentKey || pendingTip.requestKey;
      const intentStatus = message === "You cancelled the confirmation." ? "cancelled" : "failed";
      const failurePayload = {
        requestId: resolvedRequestId,
        contentId: pendingTip.contentId,
        success: false,
        error: message,
        timestamp: Date.now(),
      };
      setStatus("error");
      setCanRetryPreparation(false);
      setError(message);
      setDiagnostic(JSON.stringify(compact, null, 2));
      await chrome.storage.local.set({
        [storageKeys(resolvedRequestId).resultKey]: failurePayload,
        tipResult: failurePayload,
      });
      if (intentKey) {
        await updateTipIntent(intentKey, resolvedRequestId, {
          status: intentStatus,
          txHash: submittedHash || undefined,
          error: message,
          windowId: undefined,
        });
      }
      chrome.runtime.sendMessage({
        type: "TIP_TX_COMPLETE",
        payload: {
          success: false,
          intentStatus,
          error: message,
          requestId: resolvedRequestId,
          intentKey,
        },
      }).catch(() => {});
      debugLog("SignTip", "tx failed", compact);
    }
  }, [authenticated, createActivityProof, embeddedWallet?.address, login, pendingTip, prepareClient, requestId, status]);

  return (
    <div style={S.app}>
      <style>{`
        @keyframes teep-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      <header style={S.header}>
        <span style={{ fontSize: "20px" }}>$</span>
        <span style={{ fontSize: "18px", fontWeight: 800 }}>Confirm Tip</span>
      </header>
      <main style={S.main}>
        {!ready ? (
          <p style={{ color: "#8b97aa" }}>Preparing Teep...</p>
        ) : status === "error" ? (
          <div style={{ ...S.card, borderColor: "rgba(244,33,46,0.45)" }}>
            <div style={{ ...S.label, color: "#ff4d5d" }}>
              {canRetryPreparation ? "Tip isn't ready yet" : "Tip not sent"}
            </div>
            <p style={{ fontSize: "14px", lineHeight: 1.5 }}>{error}</p>
            {canRetryPreparation && (
              <button onClick={retryPreparation} style={{ ...S.primaryBtn, marginTop: "12px" }}>
                Try again
              </button>
            )}
            <button onClick={() => window.close()} style={{ ...S.ghostBtn, marginTop: "8px" }}>Close</button>
          </div>
        ) : status === "pending" ? (
          <div style={{ ...S.card, borderColor: "rgba(246,166,35,0.45)", textAlign: "center" }}>
            <div
              aria-hidden="true"
              style={{
                width: "40px",
                height: "40px",
                border: "3px solid rgba(246,166,35,0.25)",
                borderTopColor: "#f6a623",
                borderRadius: "50%",
                animation: "teep-spin 0.9s linear infinite",
                margin: "0 auto 12px",
              }}
            />
            <h2 style={{ margin: "6px 0 8px", color: "#f6a623", fontSize: "20px" }}>Tip is confirming</h2>
            <p style={S.helper}>Your confirmation was received. Teep will update the post when the network finishes.</p>
            {txHash && (
              <a
                href={`${CONFIG.EXPLORER_TX_URL}/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: "block", marginTop: "14px", color: "#a78bfa", fontWeight: 800, textDecoration: "none" }}
              >
                View progress
              </a>
            )}
            <button onClick={() => window.close()} style={{ ...S.ghostBtn, marginTop: "12px" }}>Close</button>
          </div>
        ) : status === "success" ? (
          <div style={{ ...S.card, borderColor: "rgba(34,197,94,0.45)", textAlign: "center" }}>
            <div style={{ width: "52px", height: "52px", borderRadius: "50%", background: "rgba(34,197,94,0.16)", color: "#22c55e", display: "grid", placeItems: "center", margin: "0 auto 10px", fontSize: "24px", fontWeight: 900 }}>✓</div>
            <h2 style={{ margin: "6px 0 8px", color: "#22c55e", fontSize: "22px" }}>Tip sent</h2>
            <p style={{ color: "#f8fafc", fontSize: "15px", margin: "0 0 4px", fontWeight: 800 }}>You tipped {recipientLabel}</p>
            <p style={{ color: "#8b97aa", fontSize: "13px", margin: "0" }}>{amountLabel} has been sent.</p>
            <a
              href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
                receiptTweet({
                  amount: String(pendingTip?.amount || "0"),
                  authorHandle: pendingTip?.authorHandle || "",
                  tweetId: pendingTip?.tweetId,
                  txHash,
                  receiptPreferences: pendingTip?.receiptPreferences,
                })
              )}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: "block", marginTop: "14px", color: "#9f7aea", fontWeight: 800, textDecoration: "none" }}
            >
              Share on X
            </a>
            <button onClick={() => window.close()} style={{ ...S.ghostBtn, marginTop: "12px" }}>Close</button>
          </div>
        ) : pendingTip ? (
          <div style={S.card}>
            <div style={{ ...S.label, textAlign: "center" }}>Confirm tip</div>
            <div style={S.amount}>{amountLabel}</div>
            <p style={{ ...S.helper, marginBottom: "14px" }}>
              You are about to send a tip to <span style={{ color: "#f8fafc", fontWeight: 900 }}>{recipientLabel}</span>.
            </p>
            <div style={S.summaryBox}>
              <div style={{ ...S.summaryRow, marginBottom: "6px" }}>
                <span style={{ color: "#8b97aa", fontSize: "12px" }}>Creator</span>
                <span style={{ color: "#fff", fontSize: "12px", fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis" }}>{recipientLabel}</span>
              </div>
              <div style={S.summaryRow}>
                <span style={{ color: "#8b97aa", fontSize: "12px" }}>Amount</span>
                <span style={{ color: "#fff", fontSize: "12px", fontWeight: 800 }}>{amountLabel}</span>
              </div>
            </div>
            {pendingTip.needsApproval && (
              <p style={{ ...S.helper, color: "#f6a623", marginBottom: "10px" }}>First-time setup is included. You only confirm once.</p>
            )}
            <div style={{ display: "grid", gap: "8px", marginTop: "14px" }}>
              <button
                onClick={executeTip}
                disabled={status === "preparing" || status === "sending" || status === "confirming"}
                style={{
                  ...S.primaryBtn,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                  opacity: status === "preparing" || status === "sending" || status === "confirming" ? 0.72 : 1,
                  cursor: status === "preparing" || status === "sending" || status === "confirming" ? "default" : "pointer",
                }}
              >
                {(status === "preparing" || status === "sending" || status === "confirming") && (
                  <span
                    aria-hidden="true"
                    style={{
                      width: "14px",
                      height: "14px",
                      border: "2px solid rgba(255,255,255,0.38)",
                      borderTopColor: "#fff",
                      borderRadius: "50%",
                      animation: "teep-spin 0.8s linear infinite",
                      flexShrink: 0,
                    }}
                  />
                )}
                <span>
                  {status === "preparing"
                    ? "Getting things ready..."
                    : status === "sending"
                      ? "Waiting for confirmation..."
                      : status === "confirming"
                        ? "Confirming tip..."
                        : "Send Tip"}
                </span>
              </button>
              {status === "preparing" && (
                <p style={{ ...S.helper, margin: "0" }}>
                  {preparationSlow ? "This is taking longer than expected." : "This usually takes a moment."}
                </p>
              )}
              <button onClick={() => window.close()} style={S.ghostBtn}>Cancel</button>
            </div>
          </div>
        ) : (
          <p style={{ color: "#8b97aa" }}>Loading tip...</p>
        )}
      </main>
    </div>
  );
}

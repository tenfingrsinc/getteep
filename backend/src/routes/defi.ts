import { Router, Request, Response } from "express";
import { isAddress, isBytes32 } from "../utils/security";
import { createDefiIntent, DefiIntentError, type DefiIntentAction } from "../services/defiIntents";
import { getDefiStrategy, getDefiSummary, listDefiActivity, listDefiStrategies, listDefiStrategyEvidence, listPreviewPositions } from "../services/defi";
import { verifyWalletProof } from "../services/walletAuth";

const router = Router();

async function getStrategyEvidenceSafely() {
  try {
    return await listDefiStrategyEvidence();
  } catch (error) {
    console.warn("[DeFi] Strategy evidence is unavailable; omitting social proof:", error instanceof Error ? error.message : error);
    return {};
  }
}

router.get("/summary", (_req: Request, res: Response) => {
  res.set("Cache-Control", "public, max-age=30");
  res.json(getDefiSummary());
});

router.get("/strategies", async (_req: Request, res: Response) => {
  const evidence = await getStrategyEvidenceSafely();
  res.set("Cache-Control", "public, max-age=30");
  res.json({
    strategies: listDefiStrategies().map((strategy) => ({
      ...strategy,
      evidence: evidence[strategy.id],
    })),
  });
});

router.get("/strategies/:strategyId", async (req: Request, res: Response) => {
  const strategyId = String(req.params.strategyId || "").trim();
  const strategy = getDefiStrategy(strategyId);
  if (!strategy) {
    res.status(404).json({ error: "Strategy not found" });
    return;
  }

  res.set("Cache-Control", "public, max-age=30");
  const evidence = await getStrategyEvidenceSafely();
  res.json({ strategy: { ...strategy, evidence: evidence[strategy.id] } });
});

router.get("/positions/:address", async (req: Request, res: Response) => {
  const address = String(req.params.address || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    res.status(400).json({ error: "Invalid address" });
    return;
  }

  res.set("Cache-Control", "private, max-age=15");
  res.json({
    address,
    mode: getDefiSummary().mode,
    positions: await listPreviewPositions(address),
  });
});

router.get("/activity/:address", async (req: Request, res: Response) => {
  const address = String(req.params.address || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    res.status(400).json({ error: "Invalid address" });
    return;
  }

  res.set("Cache-Control", "private, max-age=15");
  res.json({
    address,
    mode: getDefiSummary().mode,
    records: await listDefiActivity(address),
  });
});

router.post("/intents", async (req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  const ownerAddress = typeof req.body?.address === "string" ? req.body.address.toLowerCase() : "";
  const strategyId = typeof req.body?.strategyId === "string" ? req.body.strategyId.toLowerCase() : "";
  const action = req.body?.action as DefiIntentAction | undefined;
  const allowedActions = new Set<DefiIntentAction>(["add", "withdraw_partial", "withdraw_all"]);

  if (!isAddress(ownerAddress) || !isBytes32(strategyId) || !action || !allowedActions.has(action)) {
    res.status(400).json({ error: "Valid address, strategyId, and action are required.", code: "INVALID_INTENT" });
    return;
  }
  const verified = await verifyWalletProof(ownerAddress, "defi-intent", req.body?.walletProof);
  if (!verified) {
    res.status(401).json({ error: "Wallet verification failed or expired.", code: "WALLET_PROOF_REQUIRED" });
    return;
  }

  try {
    const intent = await createDefiIntent({
      ownerAddress,
      strategyId,
      action,
      amountRaw: req.body?.amountRaw,
      positionId: req.body?.positionId,
    });
    res.json(intent);
  } catch (error) {
    if (error instanceof DefiIntentError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    console.error("[DeFi] Intent preparation failed:", error instanceof Error ? error.message : "unknown error");
    res.status(409).json({
      error: "The transaction could not be safely prepared from the current on-chain state.",
      code: "INTENT_SIMULATION_FAILED",
    });
  }
});

export default router;

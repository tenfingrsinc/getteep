import { Router, Request, Response } from "express";
import { getDefiStrategy, getDefiSummary, listDefiActivity, listDefiStrategies, listPreviewPositions } from "../services/defi";

const router = Router();

router.get("/summary", (_req: Request, res: Response) => {
  res.set("Cache-Control", "public, max-age=30");
  res.json(getDefiSummary());
});

router.get("/strategies", (_req: Request, res: Response) => {
  res.set("Cache-Control", "public, max-age=30");
  res.json({
    strategies: listDefiStrategies(),
  });
});

router.get("/strategies/:strategyId", (req: Request, res: Response) => {
  const strategyId = String(req.params.strategyId || "").trim();
  const strategy = getDefiStrategy(strategyId);
  if (!strategy) {
    res.status(404).json({ error: "Strategy not found" });
    return;
  }

  res.set("Cache-Control", "public, max-age=30");
  res.json({ strategy });
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
    mode: "preview_only",
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
    mode: "preview_only",
    records: await listDefiActivity(address),
  });
});

router.post("/intents", (_req: Request, res: Response) => {
  res.status(423).json({
    error: "DeFi transactions are disabled for beta preview.",
    code: "DEFI_TRANSACTIONS_DISABLED",
  });
});

export default router;

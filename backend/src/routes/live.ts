import { Router, type Request, type Response } from "express";
import { isAddress } from "../utils/security";
import { canSubscribeToDashboard, subscribeToDashboard } from "../services/dashboardUpdates";

const router = Router();

router.get("/dashboard", (req: Request, res: Response) => {
  const address = String(req.query.address || "").trim().toLowerCase();
  if (!isAddress(address)) {
    res.status(400).json({ error: "Valid dashboard address required" });
    return;
  }
  if (!canSubscribeToDashboard(address)) {
    res.status(429).json({ error: "Too many live dashboard connections" });
    return;
  }

  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 5000\nevent: ready\ndata: {}\n\n");

  const unsubscribe = subscribeToDashboard(address, res);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 25_000);
  heartbeat.unref?.();

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

export default router;

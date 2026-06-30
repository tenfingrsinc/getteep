import { Router, Request, Response } from "express";
import { getPublicCreatorProfileByUsername } from "../services/publicProfile";
import { getUnifiedTipperStats } from "../services/tipperStats";
import { getUserSettings, publicIdentity, resolveTipperIdentifier } from "../services/userSettings";

const router = Router();

/**
 * GET /profile/username/:username
 * Public creator profile by X username (verified claims only).
 * Returns creator stats: totalReceived, tipCount, topPosts.
 */
router.get("/username/:username", async (req: Request, res: Response) => {
  const profile = await getPublicCreatorProfileByUsername(req.params.username as string);
  if (!profile) {
    res.status(404).json({ error: "Creator not found or not verified" });
    return;
  }

  res.set("Cache-Control", "public, max-age=60");
  res.json(profile);
});

/**
 * GET /profile/tipper/:address
 * Public tipper profile: total sent, creators supported, etc.
 */
router.get("/tipper/:address", async (req: Request, res: Response) => {
  const address = await resolveTipperIdentifier(req.params.address as string);
  if (!address) {
    res.status(404).json({ error: "Tipper not found" });
    return;
  }
  const settings = await getUserSettings(address);
  const identity = await publicIdentity(address);
  if (settings.privacy.privateActivity) {
    res.json({
      address: settings.privacy.hideAddress ? null : address,
      identity: identity.label,
      privateActivity: true,
      totalSent: "0",
      tipCount: 0,
      thankYouReceivedCount: 0,
      recentTips: [],
      creatorsSupported: [],
    });
    return;
  }
  const stats = await getUnifiedTipperStats(address);

  res.json({
    address: settings.privacy.hideAddress ? null : address,
    identity: identity.label,
    privateActivity: false,
    totalSent: stats.totalSent,
    tipCount: stats.tipCount,
    thankYouReceivedCount: stats.thankYouReceivedCount,
    recentTips: stats.recentTips,
    creatorsSupported: stats.creatorsSupported,
  });
});

export default router;

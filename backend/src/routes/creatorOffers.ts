import { Router, type Request, type Response } from "express";
import { verifyWalletProof } from "../services/walletAuth";
import {
  CreatorOfferError,
  addOfferCodes,
  changeOfferStatus,
  claimOffer,
  createOfferReadSession,
  createCreatorOffer,
  exportOfferCodes,
  generateOfferCodes,
  getClaimPreview,
  getCreatorOffer,
  listCreatorOffers,
  listPublicOffers,
  listSupporterEntitlements,
  updateCreatorOffer,
  verifyOfferReadSession,
} from "../services/creatorOffers";
import { isAddress } from "../utils/security";

const router = Router();

function sendError(res: Response, error: unknown) {
  if (error instanceof CreatorOfferError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  console.error("[Creator offers] Route failed:", error);
  res.status(500).json({ error: "Creator Offers is temporarily unavailable.", code: "OFFER_INTERNAL_ERROR" });
}

async function requireProof(req: Request, res: Response, address: string, purpose: "creator-offers" | "offer-claim") {
  if (!isAddress(address)) {
    res.status(400).json({ error: "Invalid account address.", code: "INVALID_ADDRESS" });
    return false;
  }
  const verified = await verifyWalletProof(address, purpose, req.body?.walletProof);
  if (!verified) {
    res.status(401).json({ error: "Account verification failed.", code: "WALLET_PROOF_FAILED" });
    return false;
  }
  return true;
}

function requireReadSession(req: Request, res: Response, address: string, scope: "creator" | "supporter") {
  const authorization = String(req.headers.authorization || "");
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!verifyOfferReadSession(token, address, scope)) {
    res.status(401).json({ error: "Verify the connected Teep account to continue.", code: "OFFER_SESSION_REQUIRED" });
    return false;
  }
  return true;
}

router.get("/public/:username", async (req, res) => {
  try {
    res.set("Cache-Control", "public, max-age=30");
    res.json({ offers: await listPublicOffers(String(req.params.username || "")) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/creator/:ownerAddress/session", async (req, res) => {
  const ownerAddress = String(req.params.ownerAddress || "").toLowerCase();
  if (!(await requireProof(req, res, ownerAddress, "creator-offers"))) return;
  try {
    res.set("Cache-Control", "private, no-store");
    res.json(createOfferReadSession(ownerAddress, "creator"));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/creator/:ownerAddress", async (req, res) => {
  const ownerAddress = String(req.params.ownerAddress || "").toLowerCase();
  if (!requireReadSession(req, res, ownerAddress, "creator")) return;
  try {
    res.set("Cache-Control", "private, no-store");
    res.json(await listCreatorOffers(ownerAddress));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/creator/:ownerAddress/:offerId", async (req, res) => {
  const ownerAddress = String(req.params.ownerAddress || "").toLowerCase();
  if (!requireReadSession(req, res, ownerAddress, "creator")) return;
  try {
    res.set("Cache-Control", "private, no-store");
    res.json(await getCreatorOffer(ownerAddress, String(req.params.offerId || "")));
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/creator/:ownerAddress", async (req, res) => {
  const ownerAddress = String(req.params.ownerAddress || "").toLowerCase();
  if (!(await requireProof(req, res, ownerAddress, "creator-offers"))) return;
  try {
    res.status(201).json(await createCreatorOffer(ownerAddress, req.body?.offer || req.body));
  } catch (error) {
    sendError(res, error);
  }
});

router.patch("/creator/:ownerAddress/:offerId", async (req, res) => {
  const ownerAddress = String(req.params.ownerAddress || "").toLowerCase();
  if (!(await requireProof(req, res, ownerAddress, "creator-offers"))) return;
  try {
    res.json(await updateCreatorOffer(ownerAddress, String(req.params.offerId || ""), req.body?.offer || req.body));
  } catch (error) {
    sendError(res, error);
  }
});

function offerStatusHandler(action: "activate" | "pause" | "archive") {
  return async (req: Request, res: Response) => {
    const ownerAddress = String(req.params.ownerAddress || "").toLowerCase();
    if (!(await requireProof(req, res, ownerAddress, "creator-offers"))) return;
    try {
      res.json(await changeOfferStatus(ownerAddress, String(req.params.offerId || ""), action));
    } catch (error) {
      sendError(res, error);
    }
  };
}

router.post("/creator/:ownerAddress/:offerId/activate", offerStatusHandler("activate"));
router.post("/creator/:ownerAddress/:offerId/pause", offerStatusHandler("pause"));
router.post("/creator/:ownerAddress/:offerId/archive", offerStatusHandler("archive"));

router.post("/creator/:ownerAddress/:offerId/codes", async (req, res) => {
  const ownerAddress = String(req.params.ownerAddress || "").toLowerCase();
  if (!(await requireProof(req, res, ownerAddress, "creator-offers"))) return;
  try {
    res.json(await addOfferCodes(ownerAddress, String(req.params.offerId || ""), req.body?.codes));
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/creator/:ownerAddress/:offerId/codes/generate", async (req, res) => {
  const ownerAddress = String(req.params.ownerAddress || "").toLowerCase();
  if (!(await requireProof(req, res, ownerAddress, "creator-offers"))) return;
  try {
    res.json(await generateOfferCodes(ownerAddress, String(req.params.offerId || ""), req.body?.count));
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/creator/:ownerAddress/:offerId/codes/export", async (req, res) => {
  const ownerAddress = String(req.params.ownerAddress || "").toLowerCase();
  if (!(await requireProof(req, res, ownerAddress, "creator-offers"))) return;
  try {
    const exported = await exportOfferCodes(ownerAddress, String(req.params.offerId || ""));
    res.set("Cache-Control", "private, no-store");
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${exported.filename}"`);
    res.send(exported.csv);
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/supporter/:address/session", async (req, res) => {
  const address = String(req.params.address || "").toLowerCase();
  if (!(await requireProof(req, res, address, "offer-claim"))) return;
  try {
    res.set("Cache-Control", "private, no-store");
    res.json(createOfferReadSession(address, "supporter"));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/supporter/:address", async (req, res) => {
  const address = String(req.params.address || "").toLowerCase();
  if (!requireReadSession(req, res, address, "supporter")) return;
  try {
    res.set("Cache-Control", "private, no-store");
    res.json({ entitlements: await listSupporterEntitlements(address) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/supporter/:address/claim-links", async (req, res) => {
  const address = String(req.params.address || "").toLowerCase();
  if (!(await requireProof(req, res, address, "offer-claim"))) return;
  try {
    res.set("Cache-Control", "private, no-store");
    res.json({ entitlements: await listSupporterEntitlements(address, true) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/claim/:token", async (req, res) => {
  try {
    res.set("Cache-Control", "private, no-store");
    res.json(await getClaimPreview(String(req.params.token || "")));
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/claim/:token", async (req, res) => {
  const supporterAddress = String(req.body?.supporterAddress || "").toLowerCase();
  if (!(await requireProof(req, res, supporterAddress, "offer-claim"))) return;
  try {
    res.set("Cache-Control", "private, no-store");
    res.json(await claimOffer(String(req.params.token || ""), supporterAddress));
  } catch (error) {
    sendError(res, error);
  }
});

export default router;

export type CreatorOffer = {
  id: string;
  creator: { authorId: string; ownerAddress: string; username: string };
  name: string;
  description: string;
  offerType: "ACCESS" | "CODE" | "LINK" | "CUSTOM";
  status: "DRAFT" | "SCHEDULED" | "ACTIVE" | "PAUSED" | "CLAIMED_OUT" | "ENDED" | "ARCHIVED";
  visibility: "PUBLIC" | "HIDDEN";
  condition: {
    type: "SINGLE_TIP_MINIMUM" | "CUMULATIVE_TIPS_MINIMUM" | "SPECIFIC_X_POST_MINIMUM";
    thresholdUsd: string;
    amountRaw: string;
    currency: "USDC";
    postId: string | null;
  };
  inventory: {
    maximum: number | null;
    reserved: number;
    claimed: number;
    remaining: number | null;
    availableCodes: number | null;
  };
  onePerSupporter: boolean;
  startsAt: number;
  endsAt: number | null;
  claimWindowSeconds: number | null;
  fulfillmentType: "PROTECTED_LINK" | "SHARED_CODE" | "UNIQUE_CODE" | "INSTRUCTIONS" | "CUSTOM";
  generatedByTeep: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export function offerTypeLabel(type: CreatorOffer["offerType"]) {
  if (type === "CODE") return "Code";
  if (type === "LINK") return "Access";
  if (type === "CUSTOM") return "Custom access";
  return "Access";
}

export function conditionLabel(offer: CreatorOffer) {
  const amount = `$${Number(offer.condition.thresholdUsd).toFixed(2)}`;
  if (offer.condition.type === "CUMULATIVE_TIPS_MINIMUM") return `${amount} supported over time`;
  if (offer.condition.type === "SPECIFIC_X_POST_MINIMUM") return `${amount}+ on one X post`;
  return `One tip of ${amount}+`;
}

export function statusLabel(status: CreatorOffer["status"]) {
  return status === "CLAIMED_OUT" ? "Claimed out" : status.charAt(0) + status.slice(1).toLowerCase();
}

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

const X_SHARE_TEXT_LIMIT = 260;

export type CreatorOfferShareInput = {
  creatorUsername: string;
  name: string;
  visibility: CreatorOffer["visibility"];
  conditionType: CreatorOffer["condition"]["type"];
  thresholdUsd: string;
  webAppUrl: string;
};

function publicShareText(value: string, limit: number) {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(cleaned);
  return characters.length <= limit ? cleaned : `${characters.slice(0, Math.max(1, limit - 1)).join("")}…`;
}

function publicCreatorUrl(webAppUrl: string, creatorUsername: string) {
  const username = creatorUsername.replace(/^@/, "").trim();
  try {
    const base = new URL(webAppUrl);
    if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(base.hostname))) {
      throw new Error("Unsupported web app URL");
    }
    return new URL(`/creator/${encodeURIComponent(username)}`, `${base.origin}/`).toString();
  } catch {
    return `https://getteep.xyz/creator/${encodeURIComponent(username)}`;
  }
}

function publicUnlockPrompt(conditionType: CreatorOfferShareInput["conditionType"], thresholdUsd: string) {
  const amount = Number(thresholdUsd);
  const formattedAmount = Number.isFinite(amount) && amount > 0 ? `$${amount.toFixed(2)}` : "the qualifying amount";
  if (conditionType === "CUMULATIVE_TIPS_MINIMUM") return `Reach ${formattedAmount} in total support to qualify.`;
  if (conditionType === "SPECIFIC_X_POST_MINIMUM") return `Tip ${formattedAmount} or more on my qualifying X post to qualify.`;
  return `Tip ${formattedAmount} or more to qualify.`;
}

/**
 * Builds a public-safe X post from an explicit allowlist of offer fields.
 * Private fulfillment data is deliberately absent from the input contract.
 */
export function buildCreatorOfferShareText(input: CreatorOfferShareInput) {
  const profileUrl = publicCreatorUrl(input.webAppUrl, input.creatorUsername);
  const unlockPrompt = publicUnlockPrompt(input.conditionType, input.thresholdUsd);
  const publicName = input.visibility === "PUBLIC" ? publicShareText(input.name, 72) : "";
  const benefit = publicName ? `"${publicName}"` : "a private supporter benefit";
  const finalLine = input.visibility === "PUBLIC"
    ? `View the offer and support me: ${profileUrl}`
    : `Support me securely here: ${profileUrl}`;

  let tweet = `Tip me on Teep and unlock ${benefit}.\n\n${unlockPrompt}\n\n${finalLine}`;
  if (tweet.length <= X_SHARE_TEXT_LIMIT) return tweet;

  // Long public names are the only variable prose included. Reduce them before
  // falling back to a fully generic benefit label.
  const fixedLength = tweet.length - publicName.length;
  const availableNameLength = Math.max(0, X_SHARE_TEXT_LIMIT - fixedLength);
  if (publicName && availableNameLength >= 8) {
    const shorterName = publicShareText(publicName, availableNameLength);
    tweet = `Tip me on Teep and unlock "${shorterName}".\n\n${unlockPrompt}\n\n${finalLine}`;
  }
  if (tweet.length <= X_SHARE_TEXT_LIMIT) return tweet;
  const genericTweet = `Tip me on Teep and unlock a supporter benefit.\n\n${unlockPrompt}\n\nSupport me here: ${profileUrl}`;
  if (genericTweet.length <= X_SHARE_TEXT_LIMIT) return genericTweet;

  // Preserve a complete, trusted destination even if an unusually long custom
  // app origin was configured. Never truncate a URL into a misleading link.
  const fallbackProfileUrl = publicCreatorUrl("https://getteep.xyz", input.creatorUsername);
  return `Tip me on Teep and unlock a supporter benefit.\n\n${unlockPrompt}\n\nSupport me here: ${fallbackProfileUrl}`;
}

export function creatorOfferXIntentUrl(input: CreatorOfferShareInput) {
  const intent = new URL("https://x.com/intent/tweet");
  intent.searchParams.set("text", buildCreatorOfferShareText(input));
  return intent.toString();
}

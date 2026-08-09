import assert from "node:assert/strict";
import test from "node:test";
import {
  amountFromRaw,
  amountToRaw,
  buildOfferXNotificationReply,
  createOfferReadSession,
  safeDestination,
  verifyOfferReadSession,
} from "./creatorOffers";

process.env.CREATOR_OFFERS_ENCRYPTION_KEY = "creator-offers-test-key-that-is-not-used-outside-tests";

test("creator offer amounts preserve six-decimal USDC precision", () => {
  assert.equal(amountToRaw("$2"), "2000000");
  assert.equal(amountToRaw("2.5"), "2500000");
  assert.equal(amountToRaw("0.010001"), "10001");
  assert.equal(amountFromRaw("2500000"), "2.50");
});

test("creator offer amounts reject ambiguous or unsafe values", () => {
  for (const value of ["", "0", "0.001", "2e3", "-2", "2.0000001", "02"]) {
    assert.throws(() => amountToRaw(value));
  }
});

test("creator offer destinations allow normal web links", () => {
  assert.equal(safeDestination("https://example.com/private?offer=1"), "https://example.com/private?offer=1");
  assert.equal(safeDestination("http://example.com/path"), "http://example.com/path");
});

test("creator offer destinations reject credentials, local hosts, and non-web protocols", () => {
  for (const value of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:password@example.com/",
    "http://localhost:3000/private",
    "http://127.0.0.1/private",
    "http://internal.local/private",
  ]) {
    assert.throws(() => safeDestination(value));
  }
});

test("creator offer read sessions are bound to account and scope", () => {
  const address = "0x1111111111111111111111111111111111111111";
  const other = "0x2222222222222222222222222222222222222222";
  const session = createOfferReadSession(address, "creator");
  assert.equal(verifyOfferReadSession(session.token, address, "creator"), true);
  assert.equal(verifyOfferReadSession(session.token, address, "supporter"), false);
  assert.equal(verifyOfferReadSession(session.token, other, "creator"), false);
  assert.equal(verifyOfferReadSession(`${session.token.slice(0, -1)}x`, address, "creator"), false);
});

test("creator offer X replies stay within 280 characters without cutting the claim URL", () => {
  const token = "a".repeat(43);
  const reply = buildOfferXNotificationReply([{
    offerName: "🎁".repeat(100),
    creatorUsername: "creatorhandle15",
    claimToken: token,
  }], "https://getteep.xyz");
  assert.ok(reply.length <= 280);
  assert.ok(reply.endsWith(`https://getteep.xyz/offers/claim/${token}`));
});

test("multiple-offer X replies use the short inbox URL", () => {
  const reply = buildOfferXNotificationReply([
    { offerName: "One", creatorUsername: "creator", claimToken: "a" },
    { offerName: "Two", creatorUsername: "creator", claimToken: "b" },
  ], "https://getteep.xyz");
  assert.ok(reply.length <= 280);
  assert.ok(reply.endsWith("https://getteep.xyz/dashboard/offers"));
});

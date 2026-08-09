import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  buildCrossmintOnrampPayload,
  normalizeCrossmintStatus,
  parseCrossmintWebhook,
  verifyCrossmintWebhook,
} from "./crossmint";

const secretBytes = Buffer.from("teep-crossmint-webhook-test-secret");
const signingSecret = `whsec_${secretBytes.toString("base64")}`;

function signed(body: Buffer, id = "msg_teep_1", timestamp = 1_800_000_000) {
  const signature = crypto
    .createHmac("sha256", secretBytes)
    .update(`${id}.${timestamp}.${body.toString("utf8")}`)
    .digest("base64");
  return { id, timestamp: String(timestamp), signature: `v1,${signature}` };
}

test("normalizes payment and delivery lifecycle without treating payment as delivery", () => {
  assert.equal(normalizeCrossmintStatus("succeeded", "orders.payment.succeeded"), "processing");
  assert.equal(normalizeCrossmintStatus(null, "orders.delivery.completed"), "completed");
  assert.equal(normalizeCrossmintStatus("declined", "orders.payment.failed"), "failed");
  assert.equal(normalizeCrossmintStatus("expired"), "expired");
});

test("verifies Crossmint Svix signature and extracts identifiers", () => {
  process.env.CROSSMINT_WEBHOOK_SIGNING_SECRET = signingSecret;
  process.env.CROSSMINT_WEBHOOK_TOLERANCE_SECONDS = "300";
  const body = Buffer.from(JSON.stringify({
    type: "orders.delivery.completed",
    orderId: "order_123",
    data: { metadata: { sessionId: "crossmint_onramp_123" } },
  }));
  const verified = verifyCrossmintWebhook(body, signed(body), 1_800_000_100);
  const event = parseCrossmintWebhook(JSON.parse(body.toString("utf8")), verified);
  assert.equal(event.eventId, "msg_teep_1");
  assert.equal(event.providerOrderId, "order_123");
  assert.equal(event.sessionId, "crossmint_onramp_123");
  assert.equal(event.status, "completed");
});

test("rejects tampered and stale webhook deliveries", () => {
  process.env.CROSSMINT_WEBHOOK_SIGNING_SECRET = signingSecret;
  process.env.CROSSMINT_WEBHOOK_TOLERANCE_SECONDS = "300";
  const original = Buffer.from('{"type":"orders.payment.succeeded"}');
  assert.throws(
    () => verifyCrossmintWebhook(Buffer.from('{"type":"orders.payment.failed"}'), signed(original), 1_800_000_100),
    /Invalid Crossmint webhook signature/
  );
  assert.throws(
    () => verifyCrossmintWebhook(original, signed(original), 1_800_000_301),
    /outside the allowed window/
  );
});

test("adds only same-origin hosted-checkout callbacks to Crossmint orders", () => {
  const keys = [
    "CROSSMINT_ENABLE_ONRAMP",
    "CROSSMINT_ENV",
    "CROSSMINT_SERVER_API_KEY",
    "CROSSMINT_API_BASE_URL",
    "WEB_APP_URL",
    "CROSSMINT_SUCCESS_CALLBACK_URL",
    "CROSSMINT_FAILURE_CALLBACK_URL",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  try {
    process.env.CROSSMINT_ENABLE_ONRAMP = "true";
    process.env.CROSSMINT_ENV = "staging";
    process.env.CROSSMINT_SERVER_API_KEY = "test_server_key";
    process.env.CROSSMINT_API_BASE_URL = "https://staging.crossmint.com";
    process.env.WEB_APP_URL = "https://getteep.xyz";
    process.env.CROSSMINT_SUCCESS_CALLBACK_URL = "https://getteep.xyz/fund?provider=crossmint&result=success";
    process.env.CROSSMINT_FAILURE_CALLBACK_URL = "https://getteep.xyz/fund?provider=crossmint&result=failure";

    const payload = buildCrossmintOnrampPayload({
      walletAddress: "0x1111111111111111111111111111111111111111",
      ownerAddress: "0x2222222222222222222222222222222222222222",
      amountRaw: 10_000_000n,
      sessionId: "crossmint_onramp_test",
    });
    assert.equal(payload.successCallbackURL, "https://getteep.xyz/fund?provider=crossmint&result=success");
    assert.equal(payload.failureCallbackURL, "https://getteep.xyz/fund?provider=crossmint&result=failure");

    process.env.CROSSMINT_FAILURE_CALLBACK_URL = "https://lookalike.example/fund";
    assert.throws(
      () => buildCrossmintOnrampPayload({
        walletAddress: "0x1111111111111111111111111111111111111111",
        ownerAddress: "0x2222222222222222222222222222222222222222",
        amountRaw: 10_000_000n,
        sessionId: "crossmint_onramp_test_2",
      }),
      /configured WEB_APP_URL origin/,
    );
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

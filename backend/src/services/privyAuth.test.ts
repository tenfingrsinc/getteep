import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import jwt from "jsonwebtoken";
import { PrivyAuthError, bearerToken, verifyPrivyAccessToken, verifyPrivyUserOwnsAddress } from "./privyAuth";

const APP_ID = "teep-privy-auth-test";
const USER_ID = "did:privy:teep_test_user";
const SESSION_ID = "teep-test-session";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

process.env.PRIVY_APP_ID = APP_ID;
process.env.PRIVY_APP_SECRET = "test-secret";
process.env.PRIVY_JWT_VERIFICATION_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();

function accessToken(overrides: { audience?: string; expiresIn?: number } = {}) {
  return jwt.sign(
    { sid: SESSION_ID },
    privateKey,
    {
      algorithm: "ES256",
      issuer: "privy.io",
      audience: overrides.audience || APP_ID,
      subject: USER_ID,
      expiresIn: overrides.expiresIn ?? 60,
      keyid: "teep-test-key",
    }
  );
}

test("extracts only an exact bearer token", () => {
  assert.equal(bearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(bearerToken("bearer abc.def.ghi"), "");
  assert.equal(bearerToken("Bearer abc def"), "");
  assert.equal(bearerToken(undefined), "");
});

test("verifies a Privy ES256 access token and required claims", async () => {
  const claims = await verifyPrivyAccessToken(accessToken());
  assert.equal(claims.userId, USER_ID);
  assert.equal(claims.sessionId, SESSION_ID);
  assert.equal(claims.appId, APP_ID);
  assert.ok(claims.expiration > Math.floor(Date.now() / 1000));
});

test("rejects a token issued for another Privy app", async () => {
  await assert.rejects(
    verifyPrivyAccessToken(accessToken({ audience: "another-app" })),
    (error: unknown) => error instanceof PrivyAuthError && error.status === 401 && error.code === "INVALID_PRIVY_TOKEN"
  );
});

test("rejects an expired access token", async () => {
  await assert.rejects(
    verifyPrivyAccessToken(accessToken({ expiresIn: -10 })),
    (error: unknown) => error instanceof PrivyAuthError && error.status === 401 && error.code === "INVALID_PRIVY_TOKEN"
  );
});

test("authorizes only wallet addresses linked to the authenticated Privy user", async () => {
  const linkedAddress = "0x1111111111111111111111111111111111111111";
  const unlinkedAddress = "0x2222222222222222222222222222222222222222";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: USER_ID,
    linked_accounts: [
      { type: "email", address: linkedAddress },
      { type: "smart_wallet", address: linkedAddress },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    await verifyPrivyUserOwnsAddress(USER_ID, linkedAddress);
    await assert.rejects(
      verifyPrivyUserOwnsAddress(USER_ID, unlinkedAddress),
      (error: unknown) => error instanceof PrivyAuthError && error.status === 403 && error.code === "WALLET_NOT_LINKED"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

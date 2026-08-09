import test from "node:test";
import assert from "node:assert/strict";
import { applyServiceHealthFreshness, type ServiceHealthRecord } from "./serviceHealth";

const healthy: ServiceHealthRecord = {
  service: "arc_rpc",
  status: "healthy",
  lastSuccessAt: 1_000,
  lastFailureAt: null,
  lastError: null,
  metadata: null,
  updatedAt: 1_000,
};

test("stale healthy RPC state is exposed as degraded", () => {
  const effective = applyServiceHealthFreshness(healthy, 101_001, 90_000);
  assert.equal(effective.status, "degraded");
  assert.equal(effective.stale, true);
  assert.equal(effective.ageMs, 100_001);
});

test("fresh healthy RPC state remains healthy", () => {
  const effective = applyServiceHealthFreshness(healthy, 80_000, 90_000);
  assert.equal(effective.status, "healthy");
  assert.equal(effective.stale, false);
});

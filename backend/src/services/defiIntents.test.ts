import assert from "node:assert/strict";
import test from "node:test";
import {
  DefiIntentError,
  applySlippageFloor,
  parsePositionReference,
  parsePositiveUint,
  proportionalSharesCeil,
} from "./defiIntents";

test("parses positive uint256 amounts and rejects ambiguous input", () => {
  assert.equal(parsePositiveUint("1000000"), 1_000_000n);
  for (const value of ["0", "01", "1.0", "-1", 1, null]) {
    assert.throws(() => parsePositiveUint(value), DefiIntentError);
  }
  assert.throws(() => parsePositiveUint((1n << 256n).toString()), DefiIntentError);
});

test("applies a bounded floor to server quotes", () => {
  assert.equal(applySlippageFloor(1_000_000n, 100), 990_000n);
  assert.equal(applySlippageFloor(1_000_001n, 100), 990_000n);
});

test("rounds partial withdrawal shares upward", () => {
  assert.equal(proportionalSharesCeil(25n, 100n, 11n), 3n);
  assert.equal(proportionalSharesCeil(50n, 100n, 10n), 5n);
  assert.throws(() => proportionalSharesCeil(1n, 0n, 10n), DefiIntentError);
});

test("accepts only canonical indexed position references", () => {
  const parsed = parsePositionReference("0xFC9cDD6B53f46e9b879506d92A988eC967691002:42");
  assert.equal(parsed.claimWallet, "0xFC9cDD6B53f46e9b879506d92A988eC967691002");
  assert.equal(parsed.positionId, 42n);
  for (const value of ["42", "0xFC9cDD6B53f46e9b879506d92A988eC967691002:0", "0x1234:1", null]) {
    assert.throws(() => parsePositionReference(value), DefiIntentError);
  }
});

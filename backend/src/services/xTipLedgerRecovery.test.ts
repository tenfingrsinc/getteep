import assert from "node:assert/strict";
import test from "node:test";
import { __xTipLedgerRecoveryTest } from "./xTipLedgerRecovery";

test("parses a completed X-tip reply without depending on the sender handle", () => {
  assert.deepEqual(
    __xTipLedgerRecoveryTest.parseCompletedReply(
      "Tip sent\n\n@to_bbhie tipped @pipsandbills 3 USD through Teep.\n\nReceipt: https://getteep.xyz/x/df8c3e76163b4952"
    ),
    { recipientHandle: "pipsandbills", amountRaw: "3000000" }
  );
});

test("rejects replies that do not contain an exact completed-tip statement", () => {
  assert.equal(__xTipLedgerRecoveryTest.parseCompletedReply("This command was already completed."), null);
  assert.equal(__xTipLedgerRecoveryTest.parseCompletedReply("Tip status uncertain"), null);
});

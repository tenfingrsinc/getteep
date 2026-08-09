import test from "node:test";
import assert from "node:assert/strict";
import { buildAlreadyProcessedReply, buildSubmittedReply, buildUncertainSubmissionReply } from "./replies";

test("submitted X-tip reply does not tell the user the tip failed", () => {
  const reply = buildSubmittedReply({
    recipientHandle: "creator",
    amountRaw: 1_000_000n,
    receiptId: "0123456789abcdef",
  });
  assert.match(reply, /^Tip submitted/);
  assert.match(reply, /Don't send this command again/);
  assert.match(reply, /0123456789abcdef/);
  assert.doesNotMatch(reply, /failed|couldn't send/i);
});

test("already-processed submitted command remains pending rather than completed", () => {
  const reply = buildAlreadyProcessedReply({
    status: "submitted",
    reason: "CONFIRMATION_PENDING",
    receiptId: "0123456789abcdef",
  });
  assert.match(reply, /already submitted/i);
  assert.match(reply, /confirmation is still pending/i);
  assert.doesNotMatch(reply, /already completed/i);
});

test("only a completed command is described as completed", () => {
  const reply = buildAlreadyProcessedReply({
    status: "completed",
    receiptId: "0123456789abcdef",
  });
  assert.match(reply, /already completed/i);
});

test("unknown broadcast outcome asks the user to check before retrying", () => {
  const reply = buildUncertainSubmissionReply();
  assert.match(reply, /^Tip status uncertain/);
  assert.match(reply, /Don't send it again yet/);
  assert.doesNotMatch(reply, /tip failed|was not sent/i);
});

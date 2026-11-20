import assert from "node:assert/strict";
import test from "node:test";

import { NodeWorkspaceError } from "../src/errors.js";
import {
  RECEIPT_QUOTA,
  RECEIPT_RETENTION_MS,
  assertReceiptQuota,
  liveReceipts,
  makeReceipt,
  receiptState,
} from "../src/receipts.js";

const BASE = 1_800_000_000_000;

function receipt(index: number, now = BASE) {
  return makeReceipt({
    operationId: index.toString(16).padStart(32, "0"),
    fingerprint: `fp-${index}`,
    outcome: "committed",
    revision: index,
    digest: "0".repeat(64),
    planDigest: "1".repeat(64),
    counts: { add: 1, change: 0, delete: 0, mode: 0, restore: 0, adopt: 0, conflicts: 0, unchanged: 0, untracked: 0, released: 0 },
    now,
  });
}

test("a receipt is live strictly before expiry and expired at the boundary", () => {
  const entry = receipt(1);
  assert.equal(Date.parse(entry.expiresAt) - Date.parse(entry.at), RECEIPT_RETENTION_MS);
  assert.equal(receiptState({ [entry.operationId]: entry }, entry.operationId, BASE + RECEIPT_RETENTION_MS - 1), "active");
  assert.equal(receiptState({ [entry.operationId]: entry }, entry.operationId, BASE + RECEIPT_RETENTION_MS), "expired");
  assert.equal(receiptState({}, "missing", BASE), "missing");
});

test("expired receipts are pruned and do not consume the quota", () => {
  const receipts: Record<string, ReturnType<typeof receipt>> = {};
  for (let index = 0; index < 3; index += 1) {
    const entry = receipt(index);
    receipts[entry.operationId] = entry;
  }
  const expired = receipt(4, BASE - RECEIPT_RETENTION_MS - 1);
  receipts[expired.operationId] = expired;

  assert.equal(Object.keys(liveReceipts(receipts, BASE)).length, 3);
  assert.doesNotThrow(() => assertReceiptQuota(receipts, BASE));
});

test("interrupted receipts do not consume the committed quota", () => {
  const receipts: Record<string, ReturnType<typeof receipt>> = {};
  for (let index = 0; index < 3; index += 1) {
    const entry = { ...receipt(index), outcome: "interrupted" as const };
    receipts[entry.operationId] = entry;
  }
  process.env.NODE_WORKSPACE_TEST_RECEIPT_QUOTA = "2";
  try {
    assert.doesNotThrow(() => assertReceiptQuota(receipts, BASE));
    for (let index = 10; index < 12; index += 1) {
      const entry = receipt(index);
      receipts[entry.operationId] = entry;
    }
    assert.throws(
      () => assertReceiptQuota(receipts, BASE),
      (error: unknown) => error instanceof NodeWorkspaceError && error.code === "receipt-quota-exceeded",
    );
    assert.doesNotThrow(() => assertReceiptQuota(receipts, BASE + RECEIPT_RETENTION_MS));
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_RECEIPT_QUOTA;
  }
});

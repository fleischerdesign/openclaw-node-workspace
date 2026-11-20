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
  for (let index = 0; index < RECEIPT_QUOTA - 1; index += 1) {
    const entry = receipt(index);
    receipts[entry.operationId] = entry;
  }
  const expired = receipt(RECEIPT_QUOTA, BASE - RECEIPT_RETENTION_MS - 1);
  receipts[expired.operationId] = expired;

  assert.equal(Object.keys(liveReceipts(receipts, BASE)).length, RECEIPT_QUOTA - 1);
  assert.doesNotThrow(() => assertReceiptQuota(receipts, BASE));
});

test("a full quota of unexpired receipts refuses new work instead of evicting", () => {
  const receipts: Record<string, ReturnType<typeof receipt>> = {};
  for (let index = 0; index < RECEIPT_QUOTA; index += 1) {
    const entry = receipt(index);
    receipts[entry.operationId] = entry;
  }
  assert.throws(
    () => assertReceiptQuota(receipts, BASE),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "receipt-quota-exceeded",
  );
  assert.doesNotThrow(() => assertReceiptQuota(receipts, BASE + RECEIPT_RETENTION_MS));
});

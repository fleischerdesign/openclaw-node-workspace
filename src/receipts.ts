import { nowMs } from "./clock.js";
import { NodeWorkspaceError } from "./errors.js";

export const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const RECEIPT_QUOTA = 4096;
export const RECEIPT_MAX_BYTES = 2 * 1024 * 1024;

export interface Receipt {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly outcome: "committed" | "interrupted" | "rejected";
  readonly revision: number;
  readonly digest: string;
  readonly planDigest: string;
  readonly counts: import("./managed-plan.js").PlanCounts;
  readonly at: string;
  readonly expiresAt: string;
}

export function makeReceipt(input: {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly outcome: Receipt["outcome"];
  readonly revision: number;
  readonly digest: string;
  readonly planDigest: string;
  readonly counts: import("./managed-plan.js").PlanCounts;
  readonly now?: number;
}): Receipt {
  const now = input.now ?? nowMs();
  return {
    operationId: input.operationId,
    fingerprint: input.fingerprint,
    outcome: input.outcome,
    revision: input.revision,
    digest: input.digest,
    planDigest: input.planDigest,
    counts: input.counts,
    at: new Date(now).toISOString(),
    expiresAt: new Date(now + RECEIPT_RETENTION_MS).toISOString(),
  };
}

/** A receipt is live only while its expiry is strictly in the future. */
export function receiptIsLive(receipt: Receipt, now: number): boolean {
  return Date.parse(receipt.expiresAt) > now;
}

export function liveReceipts(
  receipts: Readonly<Record<string, Receipt>>,
  now: number,
): Record<string, Receipt> {
  const kept: Record<string, Receipt> = {};
  for (const [id, receipt] of Object.entries(receipts)) {
    if (receiptIsLive(receipt, now)) kept[id] = receipt;
  }
  return kept;
}

export type ReceiptState = "missing" | "active" | "expired";

export function receiptState(
  receipts: Readonly<Record<string, Receipt>>,
  operationId: string,
  now: number,
): ReceiptState {
  const receipt = receipts[operationId];
  if (receipt === undefined) return "missing";
  return receiptIsLive(receipt, now) ? "active" : "expired";
}

/**
 * Refuse new work when the quota is full of unexpired receipts.
 *
 * Expired entries never block; they are dropped by the next write. Evicting a
 * live receipt would silently turn a retry into a second apply.
 */
function receiptQuota(): number {
  const raw = process.env.NODE_WORKSPACE_TEST_RECEIPT_QUOTA;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return RECEIPT_QUOTA;
}

export function assertReceiptQuota(
  receipts: Readonly<Record<string, Receipt>>,
  now: number,
): void {
  const live = liveReceipts(receipts, now);
  // A rolled-back or interrupted attempt is not a committed update and must
  // not consume the committed-operation budget.
  const committedReceipts = Object.values(live).filter((receipt) => receipt.outcome === "committed");
  const committed = committedReceipts.length;
  const bytes = Buffer.byteLength(JSON.stringify(committedReceipts), "utf8");
  const quota = receiptQuota();
  if (committed >= quota || bytes >= RECEIPT_MAX_BYTES) {
    throw new NodeWorkspaceError(
      "receipt-quota-exceeded",
      `the workspace holds ${committed} unexpired committed receipts (${bytes} bytes); wait for expiry or run the documented maintenance instead of evicting live receipts`,
    );
  }
}

/**
 * Bound the live receipt ledger on every write.
 *
 * Committed receipts are protected by the quota before a mutation, so the byte
 * overflow here is normally interrupted history. Drop the oldest interrupted
 * receipts, never the one that belongs to the journal being written, until the
 * live set fits the byte cap.
 */
export function boundReceipts(
  receipts: Readonly<Record<string, Receipt>>,
  now: number,
  keepOperationId?: string,
): Record<string, Receipt> {
  const live = liveReceipts(receipts, now);
  let bytes = Buffer.byteLength(JSON.stringify(live), "utf8");
  if (bytes <= RECEIPT_MAX_BYTES) return live;

  const removable = () =>
    Object.values(live)
      .filter((receipt) => receipt.outcome !== "committed" && receipt.operationId !== keepOperationId)
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));

  for (const receipt of removable()) {
    if (bytes <= RECEIPT_MAX_BYTES) break;
    bytes -= Buffer.byteLength(JSON.stringify(receipt), "utf8") + 1;
    delete live[receipt.operationId];
  }
  // The estimate above can be a byte or two off; verify once and drop more if
  // needed. Committed receipts and the active recovery id are never removed.
  while (Buffer.byteLength(JSON.stringify(live), "utf8") > RECEIPT_MAX_BYTES) {
    const next = removable()[0];
    if (next === undefined) break;
    delete live[next.operationId];
  }
  return live;
}

import { nowMs } from "./clock.js";
import { NodeWorkspaceError } from "./errors.js";

export const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const RECEIPT_QUOTA = 64;

export interface Receipt {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly outcome: "committed" | "interrupted" | "rejected";
  readonly revision: number;
  readonly digest: string;
  readonly at: string;
  readonly expiresAt: string;
}

export function makeReceipt(input: {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly outcome: Receipt["outcome"];
  readonly revision: number;
  readonly digest: string;
  readonly now?: number;
}): Receipt {
  const now = input.now ?? nowMs();
  return {
    operationId: input.operationId,
    fingerprint: input.fingerprint,
    outcome: input.outcome,
    revision: input.revision,
    digest: input.digest,
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
export function assertReceiptQuota(
  receipts: Readonly<Record<string, Receipt>>,
  now: number,
): void {
  const live = Object.keys(liveReceipts(receipts, now));
  if (live.length >= RECEIPT_QUOTA) {
    throw new NodeWorkspaceError(
      "receipt-quota-exceeded",
      `the workspace holds ${live.length} unexpired operation receipts; wait for expiry instead of evicting them`,
    );
  }
}

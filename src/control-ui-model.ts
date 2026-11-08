// Pure presentation model for the dashboard progress widget.
//
// The store prunes only when a snapshot is requested, and the client never asks
// again after a terminal event. Without the filtering here a finished transfer
// would stay on screen forever. No DOM and no timer globals in this file so the
// expiry decision can be tested with a fake clock.

export type TransferKind = "push" | "fetch" | "return";
export type TransferPhase =
  | "scanning"
  | "sending"
  | "publishing"
  | "fetching"
  | "receiving"
  | "applying";
export type TransferState = "running" | "completed" | "failed" | "unknown" | "cancelled";

export interface Transfer {
  transferId: string;
  kind: TransferKind;
  phase: TransferPhase;
  state: TransferState;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  reasonCode?: string;
}

export const COMPLETED_TTL_MS = 8_000;
export const ABNORMAL_TTL_MS = 60_000;
export const MAX_ROWS = 3;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

export function fraction(entry: Transfer): number {
  if (entry.bytesTotal > 0) return Math.min(1, entry.bytesDone / entry.bytesTotal);
  if (entry.filesTotal > 0) return Math.min(1, entry.filesDone / entry.filesTotal);
  return 0;
}

export function rowText(entry: Transfer): string {
  const files = entry.filesTotal > 0 ? `${entry.filesDone}/${entry.filesTotal}` : `${entry.filesDone}`;
  const bytes = `${formatBytes(entry.bytesDone)} / ${formatBytes(entry.bytesTotal)}`;
  if (entry.state === "running") {
    if (entry.kind === "fetch") return `fetching ${bytes}`;
    if (entry.kind === "return") return `returning ${files} · ${formatBytes(entry.bytesDone)}`;
    if (entry.phase === "scanning" && entry.filesTotal === 0) return "scanning";
    if (entry.phase === "publishing") return `publishing ${files} · ${formatBytes(entry.bytesTotal)}`;
    return `${entry.phase} ${files} · ${formatBytes(entry.bytesDone)}`;
  }
  if (entry.state === "completed") {
    return `✓ ${entry.filesTotal > 0 ? `${entry.filesTotal} files · ` : ""}${formatBytes(entry.bytesTotal > 0 ? entry.bytesTotal : entry.bytesDone)}`;
  }
  if (entry.state === "unknown") return "unknown outcome";
  if (entry.state === "cancelled") return "cancelled";
  return entry.reasonCode ? `failed · ${entry.reasonCode}` : "failed";
}

export function rowLabel(entry: Transfer): string {
  if (entry.kind === "push") return "Publish";
  return entry.kind === "fetch" ? "Fetch" : "Return";
}

/** Time a terminal entry stays visible: completed 8 s, abnormal 60 s. */
export function terminalTtlMs(state: TransferState): number | null {
  if (state === "running") return null;
  return state === "completed" ? COMPLETED_TTL_MS : ABNORMAL_TTL_MS;
}

/** Absolute expiry time of a terminal entry, or null while running. */
export function transferExpiryAt(entry: Transfer): number | null {
  const ttl = terminalTtlMs(entry.state);
  if (ttl === null) return null;
  return (entry.finishedAt ?? entry.updatedAt) + ttl;
}

export function isExpired(entry: Transfer, now: number): boolean {
  const expiry = transferExpiryAt(entry);
  return expiry !== null && now >= expiry;
}

/** Entries the widget may still show at `now`; expired terminal entries are gone. */
export function visibleTransfers(transfers: readonly Transfer[], now: number): Transfer[] {
  return transfers.filter((entry) => !isExpired(entry, now));
}

/** Earliest future expiry among the given entries, or null when none is pending. */
export function nextExpiryAt(transfers: readonly Transfer[], now: number): number | null {
  let next: number | null = null;
  for (const entry of transfers) {
    const expiry = transferExpiryAt(entry);
    if (expiry === null || expiry <= now) continue;
    if (next === null || expiry < next) next = expiry;
  }
  return next;
}

/**
 * Schedules exactly one re-render for the next terminal expiry. Repeated calls
 * replace the pending timer, so a burst of events never accumulates timers.
 */
export class ExpiryScheduler {
  readonly #now: () => number;
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  #handle: unknown;
  #armed = false;

  constructor(
    now: () => number,
    setTimer: (callback: () => void, delayMs: number) => unknown = (callback, delayMs) =>
      setTimeout(callback, delayMs),
    clearTimer: (handle: unknown) => void = (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  ) {
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  schedule(transfers: readonly Transfer[], onDue: () => void): void {
    this.cancel();
    const now = this.#now();
    const at = nextExpiryAt(transfers, now);
    if (at === null) return;
    this.#armed = true;
    this.#handle = this.#setTimer(onDue, Math.max(1, at - now));
  }

  cancel(): void {
    if (!this.#armed) return;
    this.#armed = false;
    this.#clearTimer(this.#handle);
    this.#handle = undefined;
  }
}

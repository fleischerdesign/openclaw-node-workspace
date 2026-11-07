import type { PushProgress } from "./push.js";
import type { ReturnProgress } from "./return.js";

export type TransferKind = "push" | "fetch" | "return";
export type TransferPhase = PushProgress["phase"] | ReturnProgress["phase"] | "fetching";
export type TransferState = "running" | "completed" | "failed" | "unknown" | "cancelled";

export interface TransferScope {
  readonly sessionKey: string;
  readonly agentId?: string;
}

export interface TransferProgress {
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
}

const RUNNING_TTL_MS = 15 * 60 * 1000;
const COMPLETED_TTL_MS = 8_000;
const ABNORMAL_TTL_MS = 60_000;
const MAX_TRANSFERS_PER_SCOPE = 8;

function scopeKey(scope: TransferScope): string {
  return `${scope.agentId ?? ""}\u0000${scope.sessionKey}`;
}

function clone(entry: TransferProgress): TransferProgress {
  return { ...entry };
}

/**
 * In-memory, session-scoped transfer progress.
 *
 * It is intentionally not persisted: a process restart loses in-flight
 * counters, and the accessory treats an empty snapshot after reconnect as
 * "nothing measurable now" rather than inventing a completed transfer.
 * Terminal entries stay briefly so a client that reconnects just after the
 * transfer ends can still distinguish completion from an unknown outcome.
 */
export class TransferProgressStore {
  readonly #scopes = new Map<string, Map<string, TransferProgress>>();
  #clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.#clock = clock;
  }

  begin(scope: TransferScope, transferId: string, kind: TransferKind): void {
    this.prune();
    const now = this.#clock();
    const key = scopeKey(scope);
    let entries = this.#scopes.get(key);
    if (!entries) {
      entries = new Map();
      this.#scopes.set(key, entries);
    }
    entries.set(transferId, {
      transferId,
      kind,
      phase: kind === "fetch" ? "fetching" : "scanning",
      state: "running",
      filesDone: 0,
      filesTotal: 0,
      bytesDone: 0,
      bytesTotal: 0,
      startedAt: now,
      updatedAt: now,
    });
    this.#trim(entries);
  }

  update(scope: TransferScope, transferId: string, patch: Partial<TransferProgress>): void {
    const entry = this.#scopes.get(scopeKey(scope))?.get(transferId);
    if (!entry || entry.state !== "running") return;
    Object.assign(entry, patch, { updatedAt: this.#clock() });
  }

  updateFromPush(scope: TransferScope, transferId: string, progress: PushProgress): void {
    this.update(scope, transferId, {
      phase: progress.phase,
      filesDone: progress.filesDone,
      filesTotal: progress.filesTotal,
      bytesDone: progress.bytesDone,
      bytesTotal: progress.bytesTotal,
    });
  }

  updateReturn(scope: TransferScope, transferId: string, progress: ReturnProgress): void {
    this.update(scope, transferId, {
      phase: progress.phase,
      filesDone: progress.filesDone,
      filesTotal: progress.filesTotal,
      bytesDone: progress.bytesDone,
      bytesTotal: progress.bytesTotal,
    });
  }

  updateFetch(scope: TransferScope, transferId: string, bytesDone: number, bytesTotal: number): void {
    this.update(scope, transferId, {
      phase: "fetching",
      filesDone: 0,
      filesTotal: 1,
      bytesDone,
      bytesTotal,
    });
  }

  finish(scope: TransferScope, transferId: string, state: Exclude<TransferState, "running">): void {
    const entry = this.#scopes.get(scopeKey(scope))?.get(transferId);
    if (!entry || entry.state !== "running") return;
    const now = this.#clock();
    entry.state = state;
    entry.updatedAt = now;
    entry.finishedAt = now;
    if (state === "completed" && entry.filesTotal === 0) {
      // A completed snapshot with no counters is still useful as a terminal
      // signal, but must not claim a file count it never measured.
      entry.filesDone = 0;
    }
  }

  snapshot(scope: TransferScope): TransferProgress[] {
    this.prune();
    const entries = this.#scopes.get(scopeKey(scope));
    if (!entries) return [];
    return [...entries.values()]
      .sort((left, right) => left.startedAt - right.startedAt || left.transferId.localeCompare(right.transferId))
      .map(clone);
  }

  clearScope(scope: TransferScope): boolean {
    return this.#scopes.delete(scopeKey(scope));
  }

  clearAll(): void {
    this.#scopes.clear();
  }

  prune(): void {
    const now = this.#clock();
    for (const [key, entries] of this.#scopes) {
      for (const [id, entry] of entries) {
        const age = now - entry.updatedAt;
        const ttl =
          entry.state === "running"
            ? RUNNING_TTL_MS
            : entry.state === "completed"
              ? COMPLETED_TTL_MS
              : ABNORMAL_TTL_MS;
        if (age > ttl) entries.delete(id);
      }
      if (entries.size === 0) this.#scopes.delete(key);
    }
  }

  #trim(entries: Map<string, TransferProgress>): void {
    if (entries.size <= MAX_TRANSFERS_PER_SCOPE) return;
    const ordered = [...entries.values()].sort((left, right) => left.startedAt - right.startedAt);
    const excess = ordered.length - MAX_TRANSFERS_PER_SCOPE;
    for (let index = 0; index < excess; index += 1) {
      const candidate = ordered[index];
      if (!candidate) break;
      const terminal = candidate.state !== "running";
      if (terminal) entries.delete(candidate.transferId);
    }
    if (entries.size > MAX_TRANSFERS_PER_SCOPE) {
      const oldest = [...entries.values()].sort((left, right) => left.startedAt - right.startedAt)[0];
      if (oldest) entries.delete(oldest.transferId);
    }
  }
}

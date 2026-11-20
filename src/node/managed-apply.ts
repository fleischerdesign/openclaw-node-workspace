import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { nowIso, nowMs } from "../clock.js";
import { sortEntries, treeDigest, type ManifestEntry } from "../digest.js";
import { NodeWorkspaceError, errorMessage, isErrno } from "../errors.js";
import type { ManifestEntry as Entry } from "../digest.js";
import type { ManagedPlan, ReleasedEntry } from "../managed-plan.js";
import { liveReceipts, makeReceipt } from "../receipts.js";
import type { ResolvedPolicy } from "../policy.js";
import {
  assertFence,
  ensureTransactionDirs,
  fsyncDirectory,
  readJournal,
  workspaceKey,
  readRecord,
  removeJournal,
  writeJournal,
  writeRecord,
  type Journal,
  type JournalCommit,
  type JournalEntry,
  type LockHandle,
  type StatePaths,
  type WorkspaceRecord,
} from "./managed-store.js";

export class InjectedCrash extends Error {
  constructor(phase: string) {
    super(`injected crash at ${phase}`);
    this.name = "InjectedCrash";
  }
}

function injectedCrash(phase: string): void {
  if (process.env.NODE_WORKSPACE_TEST_CRASH === phase) throw new InjectedCrash(phase);
}

function injectedStageFailure(): Error | undefined {
  if (process.env.NODE_WORKSPACE_TEST_FAIL === "stage") {
    return Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  }
  return undefined;
}

export function stagedFileName(index: number): string {
  return `${index}.bin`;
}

async function lstatOrUndefined(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw new NodeWorkspaceError("io", `cannot inspect ${target}: ${errorMessage(error)}`, {}, { cause: error });
  }
}

function absolute(destination: string, relativePath: string): string {
  return path.join(destination, ...relativePath.split("/"));
}

async function hashMatches(target: string, expected: Entry, checkMode = true): Promise<boolean> {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw new NodeWorkspaceError("io", `cannot inspect ${target}: ${errorMessage(error)}`, {}, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  if (stat.size !== expected.size) return false;
  if (checkMode && (((stat.mode & 0o111) !== 0) !== expected.executable)) return false;
  const hash = createHash("sha256");
  const handle = await fs.open(target, "r");
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return hash.digest("hex") === expected.sha256;
}

async function assertPathMissing(target: string, relativePath: string): Promise<void> {
  if ((await lstatOrUndefined(target)) !== undefined) {
    throw new NodeWorkspaceError(
      "destination-drifted",
      `an unmanaged entry appeared at ${relativePath}; nothing was overwritten`,
      { path: relativePath },
    );
  }
}

async function ensureSafeParent(destination: string, relativePath: string): Promise<void> {
  const rootStat = await fs.lstat(destination);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new NodeWorkspaceError("symlink-rejected", "the managed workspace was replaced during the transaction");
  }
  const segments = relativePath.split("/");
  segments.pop();
  let current = destination;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new NodeWorkspaceError(
          "destination-drifted",
          `a parent directory disappeared during the transaction: ${relativePath}`,
          { path: relativePath },
        );
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new NodeWorkspaceError(
        "symlink-rejected",
        `a parent became a symlink during the transaction: ${relativePath}`,
        { path: relativePath },
      );
    }
    if (!stat.isDirectory()) {
      throw new NodeWorkspaceError(
        "destination-drifted",
        `a parent is not a directory during the transaction: ${relativePath}`,
        { path: relativePath },
      );
    }
  }
}

export interface ApplyOptions {
  readonly destination: string;
  readonly root: string;
  readonly paths: StatePaths;
  readonly lock: LockHandle;
  readonly plan: ManagedPlan;
  readonly policy: ResolvedPolicy;
  readonly previous: WorkspaceRecord | undefined;
  readonly workspaceId: string;
  readonly localProject: string;
  readonly owner: { readonly agentId: string; readonly sessionKey: string | null; readonly assertedBy: "gateway" };
  readonly epoch: number;
  readonly rebind: boolean;
  readonly fingerprint: string;
  readonly deadline: number;
  readonly onMutationStart?: (() => void) | undefined;
  readonly staged: ReadonlyMap<string, string>;
}

export interface CommitResult {
  readonly revision: number;
  readonly digest: string;
  readonly files: readonly ManifestEntry[];
  readonly directories: readonly string[];
}

function buildCommitResult(options: ApplyOptions): CommitResult {
  const files = new Map<string, ManifestEntry>((options.previous?.files ?? []).map((entry) => [entry.path, entry]));
  for (const entry of options.plan.entries) {
    if (entry.kind === "delete") files.delete(entry.path);
    else if (entry.after !== null) files.set(entry.path, entry.after);
  }
  const directories = new Set<string>(options.plan.directories);
  const sortedFiles = sortEntries([...files.values()]);
  const sortedDirectories = [...directories].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  return {
    revision: (options.previous?.revision ?? 0) + 1,
    digest: treeDigest({ version: 1, files: sortedFiles, directories: sortedDirectories }),
    files: sortedFiles,
    directories: sortedDirectories,
  };
}

function journalEntries(plan: ManagedPlan): JournalEntry[] {
  let index = 0;
  return plan.entries.map((entry) => {
    const base: JournalEntry = {
      kind: entry.kind,
      path: entry.path,
      before: entry.before,
      after: entry.after,
    };
    if (entry.kind === "add" || entry.kind === "change" || entry.kind === "restore") {
      index += 1;
      return { ...base, staged: stagedFileName(index - 1) };
    }
    return base;
  });
}

function backupName(index: number): string {
  return `${index}.bak`;
}

/**
 * Apply one already-staged plan.
 *
 * Crash ordering: the prepared journal is durable before staging, the journal
 * is durably marked `applying` before the first source mutation, and the
 * committed journal is durable before the registry advertises the new
 * revision. This is not multi-file atomicity; the journal is what repairs a
 * partial commit group.
 */
export async function applyTransaction(options: ApplyOptions): Promise<CommitResult> {
  const commit = buildCommitResult(options);
  const entries = journalEntries(options.plan);
  const createdAt = nowIso();

  await ensureTransactionDirs(options.paths);
  const prepared: Journal = {
    version: 1,
    operationId: options.lock.operationId,
    fingerprint: options.fingerprint,
    remotePath: options.plan.remotePath,
    workspaceId: options.workspaceId,
    baseRevision: options.plan.baseRevision,
    planDigest: options.plan.digest,
    counts: options.plan.counts,
    phase: "prepared",
    entries,
    createdAt,
    updatedAt: createdAt,
  };
  await writeJournal(options.paths, prepared);
  injectedCrash("after-journal");

  // The staging files are written and fsynced by the caller before this point;
  // re-verify them, because staging and apply are separated by a network round
  // trip and the stage directory is writable by the same user.
  for (const entry of entries) {
    if (entry.staged === undefined || entry.after === null) continue;
    const stagedPath = path.join(options.paths.stageDir, entry.staged);
    if (!(await hashMatches(stagedPath, entry.after, false))) {
      throw new NodeWorkspaceError("integrity", `staged bytes changed before apply: ${entry.path}`);
    }
  }

  // Durable per-path intent before any project mutation.
  await fsyncDirectory(options.paths.stageDir);
  await writeJournal(options.paths, { ...prepared, phase: "applying", updatedAt: nowIso() });
  if (process.env.NODE_WORKSPACE_TEST_FENCE === "after-journal") {
    await fs.writeFile(
      options.lock.file,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        processStart: null,
        host: "test",
        token: "replacement",
        operationId: "replacement",
        acquiredAt: Date.now(),
      }),
    );
  }
  await assertFence(options.lock);
  injectedCrash("after-applying-journal");

  if (options.previous !== undefined) {
    await writeRecord(options.paths.stateDir, workspaceKey(options.plan.remotePath), {
      ...options.previous,
      readiness: "applying",
      updatedAt: nowIso(),
    });
  }

  // Create missing directories first, with the claimed workspace as the only
  // root. A file or symlink in the chain is a conflict.
  if (options.previous === undefined && (await lstatOrUndefined(options.destination)) === undefined) {
    try {
      await fs.mkdir(options.destination, { mode: 0o700 });
    } catch (error) {
      throw new NodeWorkspaceError("io", `cannot create ${options.destination}: ${errorMessage(error)}`, {}, {
        cause: error,
      });
    }
  }
  for (const directory of options.plan.directories) {
    const target = absolute(options.destination, directory);
    const stat = await lstatOrUndefined(target);
    if (stat === undefined) {
      await fs.mkdir(target, { mode: 0o700 });
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new NodeWorkspaceError("destination-drifted", `cannot create directory ${directory}: a non-directory exists`);
    }
  }

  let index = 0;
  let applied = 0;
  let mutated = false;
  try {
    for (const entry of entries) {
      await assertFence(options.lock);
      if (Date.now() > options.deadline) {
        throw new NodeWorkspaceError("timeout", "the apply phase exceeded the operation deadline");
      }
      await ensureSafeParent(options.destination, entry.path);
      if (!mutated && entry.kind !== "adopt") {
        options.onMutationStart?.();
        mutated = true;
      }
      const target = absolute(options.destination, entry.path);
      if (entry.kind === "adopt") {
        if (entry.after === null) throw new NodeWorkspaceError("protocol", `incomplete adopt entry for ${entry.path}`);
        if (!(await hashMatches(target, entry.after))) {
          throw new NodeWorkspaceError("destination-drifted", `${entry.path} changed before adoption`, { path: entry.path });
        }
      } else if (entry.kind === "add" || entry.kind === "restore") {
        await assertPathMissing(target, entry.path);
        if (entry.after === null || entry.staged === undefined) {
          throw new NodeWorkspaceError("protocol", `missing staged payload for ${entry.path}`);
        }
        await fs.rename(path.join(options.paths.stageDir, entry.staged), target);
        await fs.chmod(target, entry.after.executable ? 0o700 : 0o600);
      } else if (entry.kind === "change") {
        if (entry.before === null || entry.after === null || entry.staged === undefined) {
          throw new NodeWorkspaceError("protocol", `incomplete change entry for ${entry.path}`);
        }
        if (!(await hashMatches(target, entry.before))) {
          throw new NodeWorkspaceError(
            "destination-drifted",
            `${entry.path} changed on the node after the plan was computed`,
            { path: entry.path },
          );
        }
        const backup = backupName(index);
        index += 1;
        await fs.rename(target, path.join(options.paths.backupDir, backup));
        try {
          await fs.rename(path.join(options.paths.stageDir, entry.staged), target);
        } catch (error) {
          await fs.rename(path.join(options.paths.backupDir, backup), target).catch(() => undefined);
          throw error;
        }
        await fs.chmod(target, entry.after.executable ? 0o700 : 0o600);
      } else if (entry.kind === "delete") {
        if (entry.before === null) throw new NodeWorkspaceError("protocol", `incomplete delete entry for ${entry.path}`);
        if (!(await hashMatches(target, entry.before))) {
          throw new NodeWorkspaceError(
            "destination-drifted",
            `${entry.path} changed on the node before it could be deleted`,
            { path: entry.path },
          );
        }
        const backup = backupName(index);
        index += 1;
        await fs.rename(target, path.join(options.paths.backupDir, backup));
      } else if (entry.kind === "mode") {
        if (entry.before === null || entry.after === null) {
          throw new NodeWorkspaceError("protocol", `incomplete mode entry for ${entry.path}`);
        }
        if (!(await hashMatches(target, entry.before))) {
          throw new NodeWorkspaceError(
            "destination-drifted",
            `${entry.path} changed on the node before its mode could change`,
            { path: entry.path },
          );
        }
        await fs.chmod(target, entry.after.executable ? 0o700 : 0o600);
      }
      applied += 1;
      if (mutated && process.env.NODE_WORKSPACE_TEST_FAIL === "apply") {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      }
      injectedCrash(applied === 1 ? "during-apply" : "during-apply-never");
    }

    // Verify every destination before the commit record is exposed.
    for (const entry of entries) {
      const target = absolute(options.destination, entry.path);
      if (entry.kind === "delete") {
        if ((await lstatOrUndefined(target)) !== undefined) {
          throw new NodeWorkspaceError("integrity", `delete did not remove ${entry.path}`);
        }
      } else if (entry.after !== null && !(await hashMatches(target, entry.after))) {
        throw new NodeWorkspaceError("integrity", `destination verification failed at ${entry.path}`);
      }
    }

    const touchedDirectories = new Set<string>([options.destination]);
    for (const directory of options.plan.directories) touchedDirectories.add(absolute(options.destination, directory));
    for (const entry of entries) {
      const parent = path.dirname(absolute(options.destination, entry.path));
      touchedDirectories.add(parent);
    }
    for (const directory of touchedDirectories) {
      await fsyncDirectory(directory);
    }
    await fsyncDirectory(options.paths.backupDir);
    injectedCrash("after-apply");
  } catch (error) {
    if (error instanceof InjectedCrash) throw error;
    try {
      await rollbackJournal(options.destination, options.paths, entries);
      await finishInterrupted(
        options.paths,
        options.previous,
        options.lock,
        options.fingerprint,
        options.plan.digest,
        options.plan.counts,
      );
    } catch {
      // A failed rollback leaves the journal in place so the next operation
      // reports recovery-blocked instead of pretending the base is intact.
      throw error;
    }
    const failure =
      error instanceof NodeWorkspaceError
        ? error
        : new NodeWorkspaceError("io", errorMessage(error), {}, { cause: error });
    throw new NodeWorkspaceError(
      failure.code,
      `${failure.message} (the transaction was rolled back)`,
      { ...failure.details, rolledBack: true },
      { cause: error },
    );
  }

  const previous = options.previous;
  const stateStat = await fs.stat(options.paths.stateDir);
  const reboundFrom =
    options.rebind && previous !== undefined && previous.localProject !== options.localProject
      ? [...(previous.reboundFrom ?? []), previous.localProject]
      : previous?.reboundFrom;
  const commitJournal: Journal = {
    ...prepared,
    phase: "committed",
    commit: {
      revision: commit.revision,
      digest: commit.digest,
      files: commit.files,
      directories: commit.directories,
      policy: options.policy,
      released: options.plan.releasedAfter as ReleasedEntry[],
      operationId: options.lock.operationId,
      fingerprint: options.fingerprint,
      planDigest: options.plan.digest,
      counts: options.plan.counts,
      root: options.root,
      localProject: options.localProject,
      owner: options.owner,
      epoch: options.epoch,
      rebind: options.rebind,
      ...(reboundFrom !== undefined ? { reboundFrom } : {}),
      stateDir: previous?.stateDir ?? {
        path: options.paths.stateDir,
        dev: stateStat.dev,
        ino: stateStat.ino,
      },
      createdAt: previous?.createdAt ?? createdAt,
    } satisfies JournalCommit,
    updatedAt: nowIso(),
  };
  await writeJournal(options.paths, commitJournal);
  injectedCrash("after-commit");

  await finalizeCommitted(options, commitJournal);
  injectedCrash("after-record");
  await cleanupTransaction(options.paths);
  injectedCrash("after-cleanup");
  return commit;
}

async function finishInterrupted(
  paths: StatePaths,
  previous: WorkspaceRecord | undefined,
  lock: LockHandle,
  fingerprint: string,
  planDigest: string,
  counts: import("../managed-plan.js").PlanCounts,
): Promise<void> {
  const now = nowIso();
  if (previous !== undefined) {
    const receipt = makeReceipt({
      operationId: lock.operationId,
      fingerprint,
      outcome: "interrupted",
      revision: previous.revision,
      digest: previous.digest,
      planDigest,
      counts,
    });
    await writeRecord(paths.stateDir, workspaceKey(previous.remotePath), {
      ...previous,
      readiness: "ready",
      receipts: { ...previous.receipts, [lock.operationId]: receipt },
      updatedAt: now,
    });
  }
  await cleanupTransaction(paths);
}

async function finalizeCommitted(
  options: ApplyOptions,
  journal: Journal,
): Promise<void> {
  const committed = journal.commit;
  if (committed === undefined) throw new NodeWorkspaceError("protocol", "committed journal has no commit record");
  const now = nowIso();
  const receipt = makeReceipt({
    operationId: committed.operationId,
    fingerprint: committed.fingerprint,
    outcome: "committed",
    revision: committed.revision,
    digest: committed.digest,
    planDigest: committed.planDigest,
    counts: committed.counts,
  });
  const previous = options.previous;
  const live = options.rebind ? {} : liveReceipts(previous?.receipts ?? {}, nowMs());
  const record: WorkspaceRecord = {
    version: 1,
    workspaceId: journal.workspaceId,
    remotePath: journal.remotePath,
    root: committed.root,
    localProject: committed.localProject,
    owner: committed.owner,
    epoch: committed.epoch,
    revision: committed.revision,
    digest: committed.digest,
    files: committed.files,
    directories: committed.directories,
    policy: committed.policy,
    released: committed.released,
    readiness: "ready",
    stateDir: committed.stateDir,
    receipts: { ...live, [committed.operationId]: receipt },
    ...(committed.reboundFrom ? { reboundFrom: committed.reboundFrom } : {}),
    createdAt: committed.createdAt,
    updatedAt: now,
  };
  await writeRecord(options.paths.stateDir, workspaceKey(journal.remotePath), record);
  await fsyncDirectory(options.destination).catch(() => undefined);
  await assertFence(options.lock).catch(() => undefined);
}

async function cleanupTransaction(paths: StatePaths): Promise<void> {
  // Cleanup failure never turns a committed update into a failure: the
  // committed journal remains and the next operation finishes the cleanup.
  await fs.rm(paths.stageDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(paths.backupDir, { recursive: true, force: true }).catch(() => undefined);
  await removeJournal(paths).catch(() => undefined);
}

/**
 * Roll one uncommitted journal back to the base revision.
 *
 * Current bytes are inspected rather than a per-entry flag: a crash can happen
 * between a rename and any bookkeeping write.
 */
async function rollbackJournal(
  destination: string,
  paths: StatePaths,
  entries: readonly JournalEntry[],
): Promise<void> {
  let backupIndex = 0;
  for (const entry of entries) {
    const target = absolute(destination, entry.path);
    const current = await lstatOrUndefined(target);
    const matchesAfter =
      entry.after !== null && current !== undefined
        ? await hashMatches(target, entry.after)
        : entry.after === null
          ? current === undefined
          : false;
    const matchesBefore =
      entry.before !== null && current !== undefined
        ? await hashMatches(target, entry.before)
        : entry.before === null
          ? current === undefined
          : false;

    if (entry.kind === "mode") {
      if (matchesAfter && entry.before !== null) {
        await fs.chmod(target, entry.before.executable ? 0o700 : 0o600).catch(() => undefined);
      }
      continue;
    }

    if (entry.kind === "add" || entry.kind === "restore") {
      if (current === undefined) continue;
      if (matchesAfter) {
        await fs.rm(target, { force: true });
        continue;
      }
      if (matchesBefore) continue;
      throw new NodeWorkspaceError(
        "recovery-blocked",
        `cannot roll back ${entry.path}: the node holds unknown bytes`,
        { path: entry.path },
      );
    }

    // change and delete own a backup slot, in journal order.
    const backupPath = path.join(paths.backupDir, backupName(backupIndex));
    backupIndex += 1;
    const backup = await lstatOrUndefined(backupPath);

    if (backup !== undefined) {
      if (current === undefined) {
        await fs.rename(backupPath, target);
        await fs.chmod(target, entry.before?.executable ? 0o700 : 0o600).catch(() => undefined);
        continue;
      }
      if (matchesBefore) {
        // Already back at the base; the backup is redundant.
        await fs.rm(backupPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (entry.kind === "change" && matchesAfter) {
        await fs.rm(target, { force: true });
        await fs.rename(backupPath, target);
        await fs.chmod(target, entry.before?.executable ? 0o700 : 0o600).catch(() => undefined);
        continue;
      }
      throw new NodeWorkspaceError(
        "recovery-blocked",
        `cannot restore ${entry.path}: the node holds bytes that match neither the base nor the target`,
        { path: entry.path },
      );
    }

    if (matchesBefore) continue;
    throw new NodeWorkspaceError(
      "recovery-blocked",
      `cannot roll back ${entry.path}: the pre-transaction bytes were not retained`,
      { path: entry.path },
    );
  }
}

export interface RecoveryResult {
  readonly status: "clean" | "recovered" | "rolled-back" | "committed" | "blocked";
  readonly revision?: number;
  readonly digest?: string;
  readonly affected?: readonly string[];
  readonly operationId?: string;
}

/**
 * Resolve a journal left by a crash before any new work proceeds.
 *
 * A committed journal is rolled forward into the registry; an applying journal
 * is rolled back; a prepared journal never reached source mutation. External
 * drift stops recovery with recovery-blocked and preserves the backups.
 */
export async function recoverTransaction(
  destination: string,
  paths: StatePaths,
  key: string,
  lock: LockHandle,
): Promise<RecoveryResult> {
  const journal = await readJournal(paths);
  if (journal === undefined) {
    // A stale stage without a journal never reached the mutation phase.
    await fs.rm(paths.stageDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(paths.backupDir, { recursive: true, force: true }).catch(() => undefined);
    return { status: "clean" };
  }
  if (journal.remotePath !== destination) {
    throw new NodeWorkspaceError(
      "recovery-blocked",
      `journal at ${paths.journalFile} belongs to ${journal.remotePath}, not ${destination}`,
    );
  }
  await assertFence(lock);
  const record = await readRecord(paths.stateDir, key);
  if (journal.phase === "committed") {
    const committed = journal.commit;
    if (
      committed === undefined ||
      typeof committed.localProject !== "string" ||
      committed.localProject.length === 0 ||
      committed.owner === undefined ||
      typeof committed.owner.agentId !== "string" ||
      committed.owner.agentId.length === 0 ||
      committed.stateDir === undefined ||
      typeof committed.stateDir.path !== "string" ||
      typeof committed.epoch !== "number"
    ) {
      throw new NodeWorkspaceError(
        "recovery-blocked",
        "the committed journal does not carry the full owner, project, epoch and state-directory binding; an operator must reconcile it",
      );
    }
    const now = nowIso();
    const receipt = makeReceipt({
      operationId: committed.operationId,
      fingerprint: committed.fingerprint,
      outcome: "committed",
      revision: committed.revision,
      digest: committed.digest,
      planDigest: committed.planDigest,
      counts: committed.counts,
    });
    const restored: WorkspaceRecord = {
      version: 1,
      workspaceId: journal.workspaceId,
      remotePath: journal.remotePath,
      root: committed.root,
      localProject: committed.localProject,
      owner: committed.owner,
      epoch: committed.epoch,
      revision: committed.revision,
      digest: committed.digest,
      files: committed.files,
      directories: committed.directories,
      policy: committed.policy,
      released: committed.released,
      readiness: "ready",
      stateDir: committed.stateDir,
      receipts: committed.rebind
        ? { [committed.operationId]: receipt }
        : { ...(record?.receipts ?? {}), [committed.operationId]: receipt },
      ...(committed.reboundFrom ? { reboundFrom: committed.reboundFrom } : {}),
      createdAt: committed.createdAt,
      updatedAt: now,
    };
    await writeRecord(paths.stateDir, key, restored);
    await cleanupTransaction(paths);
    return {
      status: "committed",
      revision: committed.revision,
      digest: committed.digest,
      operationId: committed.operationId,
    };
  }
  if (journal.phase === "prepared") {
    await cleanupTransaction(paths);
    if (record !== undefined) {
      await writeRecord(paths.stateDir, key, { ...record, readiness: "ready", updatedAt: nowIso() });
    }
    return { status: "recovered", operationId: journal.operationId };
  }
  try {
    await rollbackJournal(destination, paths, journal.entries);
  } catch (error) {
    if (error instanceof NodeWorkspaceError && error.code === "recovery-blocked") {
      if (record !== undefined) {
        await writeRecord(paths.stateDir, key, {
          ...record,
          readiness: "recovery-blocked",
          updatedAt: nowIso(),
        });
      }
      return { status: "blocked", affected: [String(error.details.path ?? "unknown")], operationId: journal.operationId };
    }
    throw error;
  }
  const now = nowIso();
  const receipt = makeReceipt({
    operationId: journal.operationId,
    fingerprint: journal.fingerprint,
    outcome: "interrupted",
    revision: record?.revision ?? 0,
    digest: record?.digest ?? "",
    planDigest: journal.planDigest,
    counts: journal.counts,
  });
  if (record !== undefined) {
    await writeRecord(paths.stateDir, key, {
      ...record,
      readiness: "ready",
      receipts: { ...record.receipts, [journal.operationId]: receipt },
      updatedAt: now,
    });
  }
  await cleanupTransaction(paths);
  return {
    status: "rolled-back",
    ...(record?.revision !== undefined ? { revision: record.revision } : {}),
    ...(record?.digest !== undefined ? { digest: record.digest } : {}),
    operationId: journal.operationId,
  };
}

export { injectedStageFailure };

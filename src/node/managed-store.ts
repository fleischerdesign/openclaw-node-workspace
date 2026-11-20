import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ManifestEntry } from "../digest.js";
import { NodeWorkspaceError, errorMessage, isErrno } from "../errors.js";
import { fsyncDirectory } from "../fs-durable.js";
import type { PlanCounts, PlanKind, ReleasedEntry } from "../managed-plan.js";
import type { ResolvedPolicy } from "../policy.js";
import type { Receipt } from "../receipts.js";

export type { Receipt };
import { isWithin, normalizeAbsolutePosixPath } from "../paths.js";

export const STATE_DIR_NAME = ".nodews-state";
const STATE_FILE = "state.json";
const RECORD_VERSION = 1;
const JOURNAL_VERSION = 1;
const LOCK_VERSION = 1;
const MAX_STATE_BYTES = 16 * 1024 * 1024;

export interface WorkspaceRecord {
  readonly version: 1;
  readonly workspaceId: string;
  readonly remotePath: string;
  readonly root: string;
  readonly localProject: string;
  readonly owner: {
    readonly agentId: string;
    readonly sessionKey: string | null;
    readonly assertedBy: "gateway";
  };
  readonly epoch: number;
  readonly revision: number;
  readonly digest: string;
  readonly files: readonly ManifestEntry[];
  readonly directories: readonly string[];
  readonly policy: ResolvedPolicy;
  readonly released: readonly ReleasedEntry[];
  readonly readiness: "ready" | "applying" | "interrupted" | "recovery-blocked";
  readonly stateDir: { readonly path: string; readonly dev: number; readonly ino: number };
  readonly receipts: Readonly<Record<string, Receipt>>;
  readonly reboundFrom?: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JournalEntry {
  readonly kind: PlanKind;
  readonly path: string;
  readonly before: ManifestEntry | null;
  readonly after: ManifestEntry | null;
  /** File name inside the transaction stage directory, for payload entries. */
  readonly staged?: string;
  /** File name inside the transaction backup directory, when an old file was moved. */
  readonly backup?: string;
}

export interface JournalCommit {
  readonly revision: number;
  readonly digest: string;
  readonly files: readonly ManifestEntry[];
  readonly directories: readonly string[];
  readonly policy: ResolvedPolicy;
  readonly released: readonly ReleasedEntry[];
  readonly operationId: string;
  readonly fingerprint: string;
  readonly planDigest: string;
  readonly counts: PlanCounts;
  readonly root: string;
  readonly localProject: string;
  readonly owner: WorkspaceRecord["owner"];
  readonly epoch: number;
  readonly rebind: boolean;
  readonly reboundFrom?: readonly string[];
  readonly stateDir: WorkspaceRecord["stateDir"];
  readonly createdAt: string;
}

export interface Journal {
  readonly version: 1;
  readonly operationId: string;
  readonly fingerprint: string;
  readonly remotePath: string;
  readonly workspaceId: string;
  readonly baseRevision: number;
  readonly planDigest: string;
  readonly counts: PlanCounts;
  readonly phase: "prepared" | "applying" | "committed";
  readonly entries: readonly JournalEntry[];
  readonly commit?: JournalCommit;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedDestination {
  readonly destination: string;
  readonly parent: string;
  readonly root: string;
}

async function realRoots(roots: readonly string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of roots) {
    try {
      const real = await fs.realpath(root);
      const stat = await fs.lstat(real);
      if (stat.isDirectory()) resolved.push(real);
    } catch {
      // A configured root that does not exist grants nothing.
    }
  }
  return resolved;
}

/**
 * Resolve one managed workspace inside a configured node root.
 *
 * The workspace is a child of the root, never the root itself: the node keeps
 * its registry and transaction area beside the workspace on the same volume.
 * The parent must exist and be real; the plugin never creates a directory
 * chain outside the operator's configured root.
 */
export async function resolveManagedDestination(
  remotePath: string,
  managedRoots: readonly string[],
): Promise<ManagedDestination> {
  if (managedRoots.length === 0) {
    throw new NodeWorkspaceError(
      "node-not-configured",
      "node.pushRoots is empty; no managed workspace is allowed",
    );
  }
  const normalized = normalizeAbsolutePosixPath(remotePath);
  const name = path.posix.basename(normalized);
  if (normalized.split("/").includes(STATE_DIR_NAME)) {
    throw new NodeWorkspaceError(
      "path-outside-root",
      `${STATE_DIR_NAME} is reserved for node metadata and may not appear in the destination ancestry`,
    );
  }
  const parentCandidate = path.posix.dirname(normalized);
  let parentStat;
  try {
    parentStat = await fs.lstat(parentCandidate);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new NodeWorkspaceError("path-not-found", `parent directory does not exist: ${parentCandidate}`);
    }
    throw new NodeWorkspaceError("io", `cannot inspect ${parentCandidate}: ${errorMessage(error)}`, {}, { cause: error });
  }
  if (parentStat.isSymbolicLink()) {
    throw new NodeWorkspaceError("symlink-rejected", `parent directory must not be a symlink: ${parentCandidate}`);
  }
  if (!parentStat.isDirectory()) {
    throw new NodeWorkspaceError("not-a-directory", `parent is not a directory: ${parentCandidate}`);
  }
  const parent = await fs.realpath(parentCandidate);
  const roots = await realRoots(managedRoots);
  const match = roots
    .filter((root) => isWithin(root, parent))
    .sort((left, right) => right.length - left.length)[0];
  if (match === undefined) {
    throw new NodeWorkspaceError(
      "path-outside-root",
      `managed workspace parent ${parent} is outside every configured node.pushRoots entry`,
    );
  }
  const rootStat = await fs.stat(match);
  const parentDevice = (await fs.stat(parent)).dev;
  if (rootStat.dev !== parentDevice) {
    throw new NodeWorkspaceError(
      "node-not-configured",
      `managed workspace ${parent} is on a different device than its root ${match}; same-volume staging is required`,
    );
  }
  return { destination: path.posix.join(parent, name), parent, root: match };
}

export function workspaceKey(remotePath: string): string {
  return createHash("sha256").update(remotePath).digest("hex").slice(0, 32);
}

export interface StatePaths {
  readonly stateDir: string;
  readonly recordFile: string;
  readonly lockFile: string;
  readonly txDir: string;
  readonly journalFile: string;
  readonly stageDir: string;
  readonly backupDir: string;
}

export function statePaths(root: string, key: string): StatePaths {
  const stateDir = path.join(root, STATE_DIR_NAME);
  const txDir = path.join(stateDir, "tx", key);
  return {
    stateDir,
    recordFile: path.join(stateDir, "workspaces", `${key}.json`),
    lockFile: path.join(stateDir, "locks", `${key}.lock`),
    txDir,
    journalFile: path.join(txDir, "journal.json"),
    stageDir: path.join(txDir, "stage"),
    backupDir: path.join(txDir, "backup"),
  };
}

export { fsyncDirectory };

async function writeAll(handle: Awaited<ReturnType<typeof fs.open>>, body: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < body.byteLength) {
    const { bytesWritten } = await handle.write(body, offset, body.byteLength - offset);
    offset += bytesWritten;
  }
}

/** Atomic single-file JSON write: temp, fsync, rename, fsync parent. */
export async function atomicWriteJson(file: string, value: unknown, mode = 0o600): Promise<void> {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (body.byteLength > MAX_STATE_BYTES) {
    throw new NodeWorkspaceError("limit-exceeded", `metadata for ${file} exceeds ${MAX_STATE_BYTES} bytes`);
  }
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temp, "wx", mode);
    await writeAll(handle, body);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, file);
    await fsyncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);
    if (error instanceof NodeWorkspaceError) throw error;
    throw new NodeWorkspaceError("io", `cannot write ${file}: ${errorMessage(error)}`, {}, { cause: error });
  }
}

interface StatePin {
  readonly version: 1;
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly createdAt: string;
}

async function readStatePin(stateDir: string): Promise<StatePin | undefined> {
  try {
    const file = path.join(stateDir, STATE_FILE);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return undefined;
    const value = JSON.parse(await fs.readFile(file, "utf8")) as Partial<StatePin>;
    if (
      value.version !== 1 ||
      typeof value.path !== "string" ||
      typeof value.dev !== "number" ||
      typeof value.ino !== "number" ||
      typeof value.createdAt !== "string"
    ) {
      return undefined;
    }
    return value as StatePin;
  } catch {
    return undefined;
  }
}

/**
 * Create or verify the per-volume node metadata directory and pin its identity.
 *
 * A replaced directory fails closed: silently adopting a new inode would orphan
 * the transaction backups that belong to the previous one.
 */
export async function ensureStateDir(root: string, create: boolean): Promise<string> {
  const stateDir = statePaths(root, "x").stateDir;
  let stat;
  try {
    stat = await fs.lstat(stateDir);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw new NodeWorkspaceError("io", `cannot inspect ${stateDir}: ${errorMessage(error)}`, {}, { cause: error });
    }
    if (!create) {
      throw new NodeWorkspaceError("path-not-found", `node metadata directory does not exist: ${stateDir}`);
    }
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    for (const child of ["workspaces", "locks", "tx"]) {
      await fs.mkdir(path.join(stateDir, child), { recursive: true, mode: 0o700 });
    }
    const created = await fs.stat(stateDir);
    await atomicWriteJson(path.join(stateDir, STATE_FILE), {
      version: 1,
      path: stateDir,
      dev: created.dev,
      ino: created.ino,
      createdAt: new Date().toISOString(),
    } satisfies StatePin);
    await fsyncDirectory(root);
    return stateDir;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new NodeWorkspaceError("recovery-blocked", `node metadata directory is not a real directory: ${stateDir}`);
  }
  const pin = await readStatePin(stateDir);
  if (pin === undefined) {
    throw new NodeWorkspaceError(
      "recovery-blocked",
      `node metadata directory ${stateDir} has no identity pin; refusing to use or replace it`,
    );
  }
  if (pin.path !== stateDir || pin.dev !== stat.dev || pin.ino !== stat.ino) {
    throw new NodeWorkspaceError(
      "recovery-blocked",
      `node metadata directory ${stateDir} was replaced (pinned ${pin.dev}:${pin.ino}, found ${stat.dev}:${stat.ino})`,
    );
  }
  if (create) {
    for (const child of ["workspaces", "locks", "tx"]) {
      await fs.mkdir(path.join(stateDir, child), { recursive: true, mode: 0o700 });
    }
  }
  return stateDir;
}

export async function readRecord(stateDir: string, key: string): Promise<WorkspaceRecord | undefined> {
  const file = path.join(stateDir, "workspaces", `${key}.json`);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) return undefined;
    const value = JSON.parse(await fs.readFile(file, "utf8")) as Partial<WorkspaceRecord>;
    if (
      value.version !== RECORD_VERSION ||
      typeof value.workspaceId !== "string" ||
      typeof value.remotePath !== "string" ||
      typeof value.root !== "string" ||
      typeof value.localProject !== "string" ||
      typeof value.revision !== "number" ||
      typeof value.digest !== "string" ||
      !Array.isArray(value.files) ||
      !Array.isArray(value.directories) ||
      !Array.isArray(value.released) ||
      value.policy === undefined ||
      value.owner === undefined ||
      value.stateDir === undefined ||
      value.receipts === undefined
    ) {
      return undefined;
    }
    return value as WorkspaceRecord;
  } catch {
    return undefined;
  }
}

export async function writeRecord(stateDir: string, key: string, record: WorkspaceRecord): Promise<void> {
  const file = path.join(stateDir, "workspaces", `${key}.json`);
  await atomicWriteJson(file, record);
}

export async function listRecords(stateDir: string): Promise<WorkspaceRecord[]> {
  const directory = path.join(stateDir, "workspaces");
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw new NodeWorkspaceError("io", `cannot read ${directory}: ${errorMessage(error)}`, {}, { cause: error });
  }
  const records: WorkspaceRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const record = await readRecord(stateDir, name.slice(0, -".json".length));
    if (record !== undefined) records.push(record);
  }
  return records;
}

export interface JournalPaths {
  readonly journalFile: string;
  readonly stageDir: string;
  readonly backupDir: string;
}

export async function readJournal(paths: JournalPaths): Promise<Journal | undefined> {
  try {
    const stat = await fs.lstat(paths.journalFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
      throw new NodeWorkspaceError("recovery-blocked", "the transaction journal is not a readable regular file");
    }
    const value = JSON.parse(await fs.readFile(paths.journalFile, "utf8")) as Partial<Journal>;
    if (
      value.version !== JOURNAL_VERSION ||
      typeof value.operationId !== "string" ||
      typeof value.remotePath !== "string" ||
      typeof value.planDigest !== "string" ||
      (value.phase !== "prepared" && value.phase !== "applying" && value.phase !== "committed") ||
      !Array.isArray(value.entries)
    ) {
      throw new NodeWorkspaceError("recovery-blocked", "the transaction journal is malformed; manual inspection is required");
    }
    return value as Journal;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    if (error instanceof NodeWorkspaceError) throw error;
    throw new NodeWorkspaceError("recovery-blocked", `cannot read the transaction journal: ${errorMessage(error)}`, {}, {
      cause: error,
    });
  }
}

export async function writeJournal(paths: JournalPaths, journal: Journal): Promise<void> {
  await atomicWriteJson(paths.journalFile, journal);
}

export async function removeJournal(paths: JournalPaths): Promise<void> {
  await fs.rm(paths.journalFile, { force: true });
  await fsyncDirectory(path.dirname(paths.journalFile));
}

export async function ensureTransactionDirs(paths: JournalPaths): Promise<void> {
  await fs.mkdir(paths.stageDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.backupDir, { recursive: true, mode: 0o700 });
  await fsyncDirectory(path.dirname(paths.stageDir));
}

export interface LockHandle {
  readonly file: string;
  readonly token: string;
  readonly operationId: string;
}

interface LockBody {
  readonly version: 1;
  readonly pid: number;
  readonly processStart: string | null;
  readonly host: string;
  readonly token: string;
  readonly operationId: string;
  readonly acquiredAt: number;
}

/** Linux process start time from /proc, used to distinguish a PID reuse. */
async function processStart(pid: number): Promise<string | null> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return null;
    const fields = raw.slice(close + 2).trim().split(/\s+/u);
    // Field 22 in proc(5), counted from 1, is index 19 after the command name.
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

async function processAlive(pid: number, start: string | null): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (isErrno(error, "EPERM")) {
      // Another user's process; it is alive.
    } else {
      return false;
    }
  }
  if (start === null) return true;
  const actual = await processStart(pid);
  return actual === null || actual === start;
}

async function readLock(file: string): Promise<LockBody | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return undefined;
    const value = JSON.parse(await fs.readFile(file, "utf8")) as Partial<LockBody>;
    if (
      value.version !== LOCK_VERSION ||
      typeof value.pid !== "number" ||
      typeof value.token !== "string" ||
      typeof value.operationId !== "string"
    ) {
      return undefined;
    }
    return {
      version: 1,
      pid: value.pid,
      processStart: typeof value.processStart === "string" ? value.processStart : null,
      host: typeof value.host === "string" ? value.host : "",
      token: value.token,
      operationId: value.operationId,
      acquiredAt: typeof value.acquiredAt === "number" ? value.acquiredAt : 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * Acquire the single per-workspace mutation lock.
 *
 * A live owner blocks. An unreadable lock blocks. A provably dead owner also
 * blocks: POSIX has no compare-and-delete primitive, so automatic reclamation
 * would be a TOCTOU that can remove a newly created live lock. Stale locks are
 * released only through explicit maintenance under a quiescent node.
 */
export async function acquireLock(
  stateDir: string,
  key: string,
  operationId: string,
): Promise<LockHandle> {
  const file = path.join(stateDir, "locks", `${key}.lock`);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const selfStart = await processStart(process.pid);
  const body: LockBody = {
    version: 1,
    pid: process.pid,
    processStart: selfStart,
    host: "node",
    token: randomUUID(),
    operationId,
    acquiredAt: Date.now(),
  };
  try {
    const handle = await fs.open(file, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(body)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(path.dirname(file));
    return { file, token: body.token, operationId };
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw new NodeWorkspaceError("io", `cannot acquire the workspace lock: ${errorMessage(error)}`, {}, {
        cause: error,
      });
    }
  }
  const existing = await readLock(file);
  if (existing === undefined) {
    throw new NodeWorkspaceError(
      "workspace-locked",
      "another operation holds an unreadable workspace lock; inspect the node state before retrying",
    );
  }
  if (await processAlive(existing.pid, existing.processStart)) {
    throw new NodeWorkspaceError(
      "workspace-locked",
      `workspace is locked by a live operation ${existing.operationId} (pid ${existing.pid})`,
    );
  }
  throw new NodeWorkspaceError(
    "workspace-locked",
    `workspace is locked by a dead process (pid ${existing.pid}, operation ${existing.operationId}); ` +
      "automatic reclamation is disabled because it cannot be made race-free without a compare-and-delete primitive. " +
      "Run the documented quiescent-node maintenance to release this exact lock.",
    { pid: existing.pid, operationId: existing.operationId },
  );
}

/**
 * Explicit maintenance for one provably dead lock.
 *
 * Only for a quiescent node: the caller must name the exact token and pid it
 * inspected. A replaced or live lock is never removed.
 */
export async function releaseStaleLockForMaintenance(
  stateDir: string,
  key: string,
  expected: { readonly token: string; readonly pid: number },
): Promise<void> {
  const file = path.join(stateDir, "locks", `${key}.lock`);
  const existing = await readLock(file);
  if (existing === undefined) {
    throw new NodeWorkspaceError("workspace-locked", "the workspace lock is absent or unreadable; nothing was removed");
  }
  if (existing.token !== expected.token || existing.pid !== expected.pid) {
    throw new NodeWorkspaceError(
      "workspace-locked",
      "the workspace lock changed since it was inspected; refusing to remove a possible live replacement",
    );
  }
  if (await processAlive(existing.pid, existing.processStart)) {
    throw new NodeWorkspaceError("workspace-locked", "the recorded process is alive; refusing to remove its lock");
  }
  await fs.rm(file, { force: true });
  await fsyncDirectory(path.dirname(file)).catch(() => undefined);
}

export async function releaseLock(handle: LockHandle): Promise<void> {
  const current = await readLock(handle.file);
  if (current === undefined || current.token !== handle.token) return;
  await fs.rm(handle.file, { force: true }).catch(() => undefined);
  await fsyncDirectory(path.dirname(handle.file)).catch(() => undefined);
}

/** Fence a long handler against a stale lock holder before it mutates anything. */
export async function assertFence(handle: LockHandle): Promise<void> {
  const current = await readLock(handle.file);
  if (current === undefined || current.token !== handle.token) {
    throw new NodeWorkspaceError(
      "workspace-locked",
      "the workspace lock changed while this operation was running; refusing to write",
    );
  }
}


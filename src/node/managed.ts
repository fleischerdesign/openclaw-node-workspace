import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { NodeConfig, PluginConfig } from "../config.js";
import { resolvePluginConfig } from "../config.js";
import { NodeWorkspaceError, errorMessage, isErrno } from "../errors.js";
import {
  buildManagedPlan,
  type ManagedPlan,
  type PlanCounts,
  type PlanEntry,
} from "../managed-plan.js";
import { nowMs } from "../clock.js";
import { resolvePolicy, type ResolvedPolicy } from "../policy.js";
import { assertReceiptQuota, receiptIsLive, receiptState } from "../receipts.js";
import {
  NODE_RESPONSE_GRACE_MS,
  parseStatusRequest,
  parseSyncHello,
  type SyncHello,
  type SyncResult,
} from "../protocol.js";
import { assertSafeRelativePath, normalizeAbsolutePosixPath } from "../paths.js";
import { assertControlFrame, controlType, type FrameSession } from "../transport.js";
import {
  applyTransaction,
  InjectedCrash,
  injectedStageFailure,
  recoverTransaction,
  stagedFileName,
  type RecoveryResult,
} from "./managed-apply.js";
import { scanManagedSource, type ManagedScan } from "./managed-scan.js";
import {
  acquireLock,
  assertFence,
  ensureStateDir,
  listRecords,
  readJournal,
  readRecord,
  releaseLock,
  resolveManagedDestination,
  statePaths,
  workspaceKey,
  type LockHandle,
  type StatePaths,
  type WorkspaceRecord,
} from "./managed-store.js";
import { readControl, remaining, sessionFromFrames, type NodeHostCommandIo } from "./session.js";


export interface NodeHostCommandContext {
  readonly signal?: AbortSignal;
  readonly sessionKey?: string;
  readonly agentId?: string;
}

export interface NodeHostCommand {
  readonly command: string;
  readonly duplex?: boolean;
  readonly dangerous?: boolean;
  readonly hasActiveWork: () => boolean;
  readonly handle: (
    paramsJSON?: string | null,
    io?: NodeHostCommandIo,
    context?: NodeHostCommandContext,
  ) => Promise<string>;
}

interface ConfigState {
  readonly config: PluginConfig | undefined;
  readonly error: string | undefined;
}

function nodeConfig(state: ConfigState): NodeConfig {
  if (!state.config) {
    throw new NodeWorkspaceError("config-invalid", state.error ?? "plugin configuration is invalid");
  }
  return state.config.node;
}

function loadConfig(raw: unknown): ConfigState {
  try {
    return { config: resolvePluginConfig(raw), error: undefined };
  } catch (error) {
    return { config: undefined, error: errorMessage(error) };
  }
}

function hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function helloFingerprint(hello: SyncHello): string {
  return hex(
    JSON.stringify({
      version: 1,
      mode: hello.mode,
      remotePath: hello.remotePath,
      localProject: hello.localProject,
      agentId: hello.owner.agentId,
      policy: hello.policy,
      create: hello.create,
      adopt: hello.adopt,
      adoptPaths: [...hello.adoptPaths].sort(),
      restore: [...hello.restore].sort(),
      rebind: hello.rebind,
      expectedRevision: hello.expectedRevision ?? null,
      planDigest: hello.planDigest ?? null,
    }),
  );
}

function validateLocalManifest(hello: SyncHello, limits: NodeConfig): void {
  if (hello.manifest.length + hello.directories.length > limits.maxFiles) {
    throw new NodeWorkspaceError("limit-exceeded", `manifest exceeds the node limit of ${limits.maxFiles} entries`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const directory of hello.directories) {
    assertSafeRelativePath(directory, "directory path");
    if (seen.has(directory)) throw new NodeWorkspaceError("invalid-manifest", `duplicate path ${directory}`);
    seen.add(directory);
  }
  for (const entry of hello.manifest) {
    assertSafeRelativePath(entry.path);
    if (seen.has(entry.path)) throw new NodeWorkspaceError("invalid-manifest", `duplicate path ${entry.path}`);
    seen.add(entry.path);
    if (entry.size > limits.maxFileBytes) {
      throw new NodeWorkspaceError(
        "limit-exceeded",
        `${entry.path} is ${entry.size} bytes, above the node per-file limit ${limits.maxFileBytes}`,
      );
    }
    totalBytes += entry.size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new NodeWorkspaceError("limit-exceeded", `manifest exceeds the node byte limit ${limits.maxTotalBytes}`);
    }
  }
  const directories = new Set(hello.directories);
  const requireParents = (candidate: string): void => {
    const segments = candidate.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      if (!directories.has(parent)) {
        throw new NodeWorkspaceError("invalid-manifest", `missing parent directory entry ${parent} for ${candidate}`);
      }
    }
  };
  for (const directory of hello.directories) requireParents(directory);
  for (const entry of hello.manifest) {
    requireParents(entry.path);
    if (directories.has(entry.path)) {
      throw new NodeWorkspaceError("invalid-manifest", `${entry.path} is both a file and a directory`);
    }
  }
}

function ownerFromContext(
  hello: SyncHello,
  context: NodeHostCommandContext | undefined,
): { agentId: string | null; sessionKey: string | null } {
  const contextAgent = typeof context?.agentId === "string" && context.agentId.length > 0 ? context.agentId : null;
  const contextSession =
    typeof context?.sessionKey === "string" && context.sessionKey.length > 0 ? context.sessionKey : null;
  if (hello.owner.agentId !== null && contextAgent !== null && hello.owner.agentId !== contextAgent) {
    throw new NodeWorkspaceError(
      "workspace-forbidden",
      "the calling session's authenticated agent does not match the agent named in the request",
    );
  }
  return {
    agentId: contextAgent ?? hello.owner.agentId,
    sessionKey: contextSession ?? hello.owner.sessionKey,
  };
}

function assertOwnership(
  record: WorkspaceRecord | undefined,
  hello: SyncHello,
  owner: { agentId: string | null },
): void {
  if (record === undefined) return;
  if (record.remotePath !== hello.remotePath) {
    throw new NodeWorkspaceError("workspace-forbidden", "the registry record belongs to another remote path");
  }
  if (record.owner.agentId !== null && owner.agentId === null) {
    throw new NodeWorkspaceError(
      "workspace-forbidden",
      "this managed workspace is bound to an authenticated agent and this call carries no authenticated identity",
    );
  }
  if (record.owner.agentId !== null && owner.agentId !== null && record.owner.agentId !== owner.agentId) {
    throw new NodeWorkspaceError(
      "workspace-forbidden",
      "this managed workspace belongs to another authenticated agent; a marker or display name is not authority",
    );
  }
  if (record.localProject !== hello.localProject && !hello.rebind) {
    throw new NodeWorkspaceError(
      "workspace-forbidden",
      `this workspace is bound to ${record.localProject}; changing the binding requires an explicit pinned rebind preview`,
    );
  }
}

function sendFailure(
  session: FrameSession,
  error: NodeWorkspaceError,
  readiness: string,
  effect: "none" | "unknown",
): void {
  const result: SyncResult = {
    t: "result",
    ok: false,
    code: error.code,
    message: error.message,
    effect,
    readiness,
    ...(Array.isArray(error.details.paths) ? { affected: error.details.paths as string[] } : {}),
  };
  void session.sendControl(result).catch(() => undefined);
}

function readinessOf(paths: StatePaths): Promise<string> {
  return readJournal(paths).then(
    (journal) => (journal === undefined ? "ready" : journal.phase === "committed" ? "committed" : "interrupted"),
    () => "recovery-blocked",
  );
}

async function scanFor(
  destination: string,
  policy: ResolvedPolicy,
  config: NodeConfig,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<ManagedScan> {
  return await scanManagedSource(
    destination,
    policy,
    {
      maxFiles: config.maxFiles,
      maxFileBytes: config.maxFileBytes,
      maxTotalBytes: config.maxTotalBytes,
    },
    deadline,
    signal,
  );
}

function planFor(
  hello: SyncHello,
  record: WorkspaceRecord | undefined,
  scan: ManagedScan,
): ManagedPlan {
  return buildManagedPlan({
    remotePath: hello.remotePath,
    localProject: hello.localProject,
    baseRevision: record?.revision ?? 0,
    recordExists: record !== undefined,
    baseManifest: record?.files,
    localFiles: hello.manifest,
    localDirectories: hello.directories,
    nodeFiles: scan.files,
    nodeDirectories: scan.directories,
    policy: hello.policy,
    previousPolicy: record?.policy,
    released: record?.released ?? [],
    adopt: hello.adopt,
    adoptPaths: hello.adoptPaths,
    restore: hello.restore,
  });
}

function payloadEntries(plan: ManagedPlan): PlanEntry[] {
  return plan.entries.filter(
    (entry) => entry.kind === "add" || entry.kind === "change" || entry.kind === "restore",
  );
}

async function stageIncomingFiles(
  session: FrameSession,
  paths: StatePaths,
  plan: ManagedPlan,
  deadline: number,
): Promise<Map<string, string>> {
  const payload = payloadEntries(plan);
  const staged = new Map<string, string>();
  let index = 0;
  let open:
    | { entry: PlanEntry; handle: Awaited<ReturnType<typeof fs.open>>; hash: ReturnType<typeof createHash>; received: number }
    | undefined;
  const pending: { path: string; bytes: number; sha256: string }[] = [];
  let pendingBytes = 0;

  const finish = async (): Promise<void> => {
    if (open === undefined) return;
    const current = open;
    open = undefined;
    await current.handle.close();
    const actual = current.hash.digest("hex");
    if (current.entry.after === null || actual !== current.entry.after.sha256 || current.received !== current.entry.after.size) {
      throw new NodeWorkspaceError("integrity", `staged payload failed verification: ${current.entry.path}`);
    }
    pending.push({ path: current.entry.path, bytes: current.received, sha256: actual });
    pendingBytes += current.received;
  };

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    await session.sendControl({ t: "files-ok", files: pending });
    pending.length = 0;
    pendingBytes = 0;
  };

  const failure = injectedStageFailure();
  if (failure !== undefined) throw failure;

  for (;;) {
    const frame = await session.next(remaining(deadline));
    if (frame.kind === "data") {
      if (open === undefined) throw new NodeWorkspaceError("protocol", "received file data without a file header");
      const expected = open.entry.after;
      if (expected === null) throw new NodeWorkspaceError("protocol", "received data for a delete entry");
      const left = expected.size - open.received;
      if (frame.data.byteLength > left) {
        throw new NodeWorkspaceError("protocol", `received more data than declared for ${open.entry.path}`);
      }
      await open.handle.write(frame.data);
      open.hash.update(frame.data);
      open.received += frame.data.byteLength;
      if (open.received === expected.size) await finish();
      continue;
    }
    const value = assertControlFrame(frame);
    const type = controlType(value);
    if (type === "batch") {
      if (open !== undefined) throw new NodeWorkspaceError("protocol", "batch acknowledgement arrived mid-file");
      if (value.files !== pending.length || value.bytes !== pendingBytes) {
        throw new NodeWorkspaceError("protocol", "batch acknowledgement does not match the staged window");
      }
      await flush();
      continue;
    }
    if (type === "file") {
      if (open !== undefined) throw new NodeWorkspaceError("protocol", "new file header before the previous file completed");
      const entry = payload[index];
      if (entry === undefined) throw new NodeWorkspaceError("protocol", "received more files than the plan requests");
      if (typeof value.path !== "string" || value.path !== entry.path) {
        throw new NodeWorkspaceError("protocol", `expected ${entry.path}, received ${String(value.path)}`);
      }
      if (entry.after === null) throw new NodeWorkspaceError("protocol", "the plan requests no payload for this entry");
      const name = stagedFileName(index);
      const target = path.join(paths.stageDir, name);
      const handle = await fs.open(target, "wx", 0o600);
      open = { entry, handle, hash: createHash("sha256"), received: 0 };
      staged.set(entry.path, name);
      if (entry.after.size === 0) await finish();
      index += 1;
      continue;
    }
    if (type === "end") {
      if (open !== undefined) throw new NodeWorkspaceError("protocol", "end received before the current file completed");
      if (pending.length > 0) throw new NodeWorkspaceError("protocol", "end received before the final acknowledgement");
      if (index !== payload.length) {
        throw new NodeWorkspaceError("protocol", "end received before every requested file was sent");
      }
      return staged;
    }
    throw new NodeWorkspaceError("protocol", `unexpected control frame ${JSON.stringify(type)} during sync`);
  }
}

async function handleSync(
  state: ConfigState,
  _paramsJSON: string | null | undefined,
  io: NodeHostCommandIo | undefined,
  context: NodeHostCommandContext | undefined,
): Promise<string> {
  const session = sessionFromFrames(io);
  const config = nodeConfig(state);
  let lock: LockHandle | undefined;
  let stateDir: string | undefined;
  let paths: StatePaths | undefined;
  let mutationStarted = false;

  try {
    const helloValue = await readControl(session, ["hello"], Date.now() + 120_000);
    const hello = parseSyncHello(helloValue);
    validateLocalManifest(hello, config);
    const destination = await resolveManagedDestination(hello.remotePath, config.pushRoots);
    const key = workspaceKey(destination.destination);
    const deadline = Date.now() + Math.max(1_000, hello.timeoutMs - NODE_RESPONSE_GRACE_MS);
    const owner = ownerFromContext(hello, context);
    const fingerprint = helloFingerprint(hello);
    const signal = io?.signal ?? context?.signal;

    stateDir = await ensureStateDir(destination.root, hello.mode === "apply").catch((error: unknown) => {
      if (hello.mode === "preview" && error instanceof NodeWorkspaceError && error.code === "path-not-found") {
        return undefined;
      }
      throw error;
    });
    let record: WorkspaceRecord | undefined;
    let recovery: RecoveryResult = { status: "clean" };
    if (stateDir !== undefined) {
      lock = await acquireLock(stateDir, key, hello.operationId);
      record = await readRecord(stateDir, key);
      assertOwnership(record, hello, owner);
      paths = statePaths(destination.root, key);
      recovery = await recoverTransaction(destination.destination, paths, key, lock);
      record = await readRecord(stateDir, key);
      if (recovery.status === "blocked") {
        throw new NodeWorkspaceError(
          "recovery-blocked",
          "a previous transaction is mixed and cannot be recovered automatically; inspect the affected paths",
          { paths: recovery.affected ?? [] },
        );
      }
    }

    const revision = record?.revision ?? 0;
    if (hello.expectedRevision !== undefined && hello.expectedRevision !== revision) {
      throw new NodeWorkspaceError(
        "revision-mismatch",
        `expected revision ${hello.expectedRevision}, the node is at ${revision}; preview again`,
        { expected: hello.expectedRevision, actual: revision },
      );
    }

    if (record !== undefined) {
      const existing = record.receipts[hello.operationId];
      if (existing !== undefined && existing.fingerprint !== fingerprint) {
        throw new NodeWorkspaceError(
          "operation-mismatch",
          `operation ${hello.operationId} was used with a different request; use a new operation id`,
        );
      }
      if (existing !== undefined && !receiptIsLive(existing, nowMs())) {
        throw new NodeWorkspaceError(
          "receipt-expired",
          `operation ${hello.operationId} has an expired receipt; inspect the workspace readiness before starting a new operation id. Expiry alone does not authorize a replay.`,
        );
      }
      if (existing !== undefined && existing.outcome === "committed") {
        const result: SyncResult = {
          t: "result",
          ok: true,
          mode: hello.mode,
          status: "replayed",
          operationId: hello.operationId,
          revision: existing.revision,
          digest: existing.digest,
          planDigest: "",
          counts: emptyCounts(),
          applied: [],
          truncated: false,
          caches: "preserved-not-validated",
          verification: "full",
          recovery: "clean",
          protectedCount: 0,
          untracked: 0,
        };
        await session.sendControl(result);
        return JSON.stringify({ ok: true, replayed: true, revision: existing.revision });
      }
      assertReceiptQuota(record.receipts, nowMs());
    }

    // A policy transition is a decision, not an incidental update.
    const scan = await scanFor(destination.destination, hello.policy, config, deadline, signal);
    const plan = planFor(hello, record, scan);

    if (hello.mode === "preview") {
      const result: SyncResult = {
        t: "result",
        ok: true,
        mode: "preview",
        status: "planned",
        operationId: hello.operationId,
        revision,
        digest: record?.digest ?? "",
        planDigest: plan.digest,
        counts: plan.counts,
        applied: [],
        truncated: false,
        caches: "preserved-not-validated",
        verification: "full",
        recovery: recovery.status,
        protectedCount: scan.protectedCount,
        untracked: plan.counts.untracked,
      };
      await session.sendControl({
        t: "plan",
        planDigest: plan.digest,
        baseRevision: revision,
        counts: plan.counts,
        entries: plan.entries,
        directories: plan.directories,
        restorable: plan.restorable,
        conflicts: plan.conflicts,
        createRequired: plan.createRequired,
        adoptRequired: plan.adoptRequired,
        policyChanged: plan.policyChanged,
        safeForRoutine: plan.safeForRoutine,
        policy: hello.policy,
      });
      await session.sendControl(result);
      return JSON.stringify({ ok: true, planDigest: plan.digest, planned: true });
    }

    if (hello.planDigest !== undefined && hello.planDigest !== plan.digest) {
      throw new NodeWorkspaceError(
        "plan-stale",
        "the node plan changed since the preview; request a fresh preview and retry with its planDigest",
        { expected: hello.planDigest, actual: plan.digest },
      );
    }
    if (plan.conflicts.length > 0) {
      throw new NodeWorkspaceError(
        "conflict",
        `the plan has ${plan.conflicts.length} conflict(s); nothing was written. Resolve them and preview again.`,
        { paths: plan.conflicts.slice(0, 200).map((entry) => entry.path) },
      );
    }
    if (hello.planDigest === undefined && !plan.safeForRoutine) {
      throw new NodeWorkspaceError(
        "preview-required",
        "this update changes deletions, policy, adoption or the binding; apply it with the planDigest from a fresh preview",
      );
    }
    if (hello.rebind && hello.planDigest === undefined) {
      throw new NodeWorkspaceError("preview-required", "a rebind needs a pinned preview of both bindings");
    }

    // A true no-op writes nothing, advances no revision, and touches no file.
    const releasedUnchanged =
      (record?.released.length ?? 0) === plan.releasedAfter.length &&
      (record?.released ?? []).every((entry) =>
        plan.releasedAfter.some((candidate) => candidate.path === entry.path && candidate.sha256 === entry.sha256),
      );
    if (
      plan.entries.length === 0 &&
      !plan.createRequired &&
      !plan.policyChanged &&
      !hello.rebind &&
      hello.adoptPaths.length === 0 &&
      releasedUnchanged
    ) {
      const result: SyncResult = {
        t: "result",
        ok: true,
        mode: "apply",
        status: "noop",
        operationId: hello.operationId,
        revision,
        digest: record?.digest ?? "",
        planDigest: plan.digest,
        counts: plan.counts,
        applied: [],
        truncated: false,
        caches: "preserved-not-validated",
        verification: "full",
        recovery: recovery.status,
        protectedCount: scan.protectedCount,
        untracked: plan.counts.untracked,
      };
      await session.sendControl(result);
      return JSON.stringify({ ok: true, status: "noop", revision });
    }

    await session.sendControl({
      t: "plan",
      planDigest: plan.digest,
      baseRevision: revision,
      counts: plan.counts,
      entries: plan.entries,
      directories: plan.directories,
      restorable: plan.restorable,
      conflicts: plan.conflicts,
      createRequired: plan.createRequired,
      adoptRequired: plan.adoptRequired,
      policyChanged: plan.policyChanged,
      safeForRoutine: plan.safeForRoutine,
      policy: hello.policy,
    });

    if (stateDir === undefined || paths === undefined || lock === undefined) {
      throw new NodeWorkspaceError("io", "apply requires a node metadata directory");
    }
    await fs.mkdir(paths.stageDir, { recursive: true, mode: 0o700 });
    const staged = await stageIncomingFiles(session, paths, plan, deadline);
    await assertFence(lock);

    const previous = record;
    const epoch = hello.rebind ? (previous?.epoch ?? 1) + 1 : (previous?.epoch ?? 1);
    const baseRecord: WorkspaceRecord | undefined = previous;
    const commit = await applyTransaction({
      destination: destination.destination,
      root: destination.root,
      paths,
      lock,
      plan,
      policy: hello.policy,
      previous: baseRecord,
      workspaceId: previous?.workspaceId ?? workspaceKey(destination.destination),
      localProject: hello.localProject,
      owner: { agentId: owner.agentId, sessionKey: owner.sessionKey },
      epoch,
      rebind: hello.rebind,
      fingerprint,
      deadline,
      staged,
      onMutationStart: () => {
        mutationStarted = true;
      },
    });
    mutationStarted = false;
    const result: SyncResult = {
      t: "result",
      ok: true,
      mode: "apply",
      status: "applied",
      operationId: hello.operationId,
      revision: commit.revision,
      digest: commit.digest,
      planDigest: plan.digest,
      counts: plan.counts,
      applied: plan.entries.slice(0, 200).map((entry) => entry.path),
      truncated: plan.entries.length > 200,
      caches: "preserved-not-validated",
      verification: "full",
      recovery: recovery.status,
      protectedCount: scan.protectedCount,
      untracked: plan.counts.untracked,
    };
    await session.sendControl(result);
    return JSON.stringify({
      ok: true,
      status: result.status,
      revision: commit.revision,
      digest: commit.digest,
      operationId: hello.operationId,
    });
  } catch (error) {
    if (error instanceof InjectedCrash) throw error;
    const failure =
      error instanceof NodeWorkspaceError
        ? error
        : new NodeWorkspaceError("io", errorMessage(error), {}, { cause: error });
    const readiness = stateDir !== undefined && paths !== undefined ? await readinessOf(paths) : "absent";
    const effect = mutationStarted && failure.details.rolledBack !== true ? "unknown" : "none";
    sendFailure(session, failure, readiness, effect);
    return JSON.stringify({ ok: false, code: failure.code, effect });
  } finally {
    if (lock !== undefined) await releaseLock(lock).catch(() => undefined);
    session.close();
  }
}

function emptyCounts(): PlanCounts {
  return { add: 0, change: 0, delete: 0, mode: 0, restore: 0, adopt: 0, conflicts: 0, unchanged: 0, untracked: 0, released: 0 };
}

interface DirtySummary {
  readonly nodeChanged: number;
  readonly nodeMissing: number;
  readonly untracked: number;
  readonly protectedCount: number;
  readonly excluded: number;
}

function summarize(record: WorkspaceRecord, scan: ManagedScan): DirtySummary {
  const base = new Map(record.files.map((entry) => [entry.path, entry]));
  let nodeChanged = 0;
  let nodeMissing = 0;
  let untracked = 0;
  const node = new Map(scan.files.map((entry) => [entry.path, entry]));
  for (const [p, entry] of base) {
    const current = node.get(p);
    if (current === undefined) {
      nodeMissing += 1;
      continue;
    }
    if (current.size !== entry.size || current.sha256 !== entry.sha256 || current.executable !== entry.executable) {
      nodeChanged += 1;
    }
  }
  for (const p of node.keys()) if (!base.has(p)) untracked += 1;
  return { nodeChanged, nodeMissing, untracked, protectedCount: scan.protectedCount, excluded: scan.excluded };
}

async function handleStatus(
  state: ConfigState,
  paramsJSON: string | null | undefined,
  context: NodeHostCommandContext | undefined,
): Promise<string> {
  const config = nodeConfig(state);
  let raw: unknown;
  try {
    raw = JSON.parse(paramsJSON ?? "{}");
  } catch {
    throw new NodeWorkspaceError("protocol", "status parameters are not valid JSON");
  }
  const request = parseStatusRequest(raw);
  const agentId =
    typeof context?.agentId === "string" && context.agentId.length > 0 ? context.agentId : null;

  if (request.remotePath === undefined) {
    const limit = Math.min(request.limit ?? 50, 200);
    const workspaces: Record<string, unknown>[] = [];
    let truncated = false;
    for (const root of config.pushRoots) {
      let stateDir: string;
      try {
        stateDir = await ensureStateDir(root, false);
      } catch {
        continue;
      }
      const records = await listRecords(stateDir);
      for (const record of records) {
        if (agentId !== null && record.owner.agentId !== null && record.owner.agentId !== agentId) continue;
        if (workspaces.length >= limit) {
          truncated = true;
          break;
        }
        const paths = statePaths(root, workspaceKey(record.remotePath));
        const journal = await readJournal(paths);
        workspaces.push({
          remotePath: record.remotePath,
          localProject: record.localProject,
          revision: record.revision,
          readiness: journal === undefined ? record.readiness : "interrupted",
          updatedAt: record.updatedAt,
          verification: "metadata-only",
        });
      }
      if (truncated) break;
    }
    return JSON.stringify({ ok: true, workspaces, truncated, verification: "metadata-only" });
  }

  const remotePath = normalizeAbsolutePosixPath(request.remotePath);
  const destination = await resolveManagedDestination(remotePath, config.pushRoots);
  const destinationExists = await fs.lstat(destination.destination).then(
    (stat) => ({ exists: true, directory: stat.isDirectory() && !stat.isSymbolicLink() }),
    (error: unknown) => {
      if (isErrno(error, "ENOENT")) return { exists: false, directory: false };
      throw new NodeWorkspaceError("io", `cannot inspect ${destination.destination}: ${errorMessage(error)}`, {}, {
        cause: error,
      });
    },
  );
  let stateDir: string | undefined;
  try {
    stateDir = await ensureStateDir(destination.root, false);
  } catch (error) {
    if (!(error instanceof NodeWorkspaceError && error.code === "path-not-found")) throw error;
  }
  const key = workspaceKey(destination.destination);
  const record = stateDir === undefined ? undefined : await readRecord(stateDir, key);
  if (record !== undefined && agentId !== null && record.owner.agentId !== null && record.owner.agentId !== agentId) {
    throw new NodeWorkspaceError("workspace-forbidden", "this managed workspace belongs to another agent");
  }
  const paths = statePaths(destination.root, key);
  const journal = stateDir === undefined ? undefined : await readJournal(paths);
  let operation: Record<string, unknown> | null = null;
  if (request.operationId !== undefined) {
    const state = receiptState(record?.receipts ?? {}, request.operationId, nowMs());
    const receipt = record?.receipts[request.operationId];
    operation =
      receipt === undefined
        ? null
        : { ...receipt, state, expired: state === "expired" };
  }

  let dirty: DirtySummary | null = null;
  let verification: "full" | "metadata-only" = "metadata-only";
  let protectedCount = 0;
  if (destinationExists.exists && destinationExists.directory && request.verify !== false) {
    const scan = await scanFor(
      destination.destination,
      record?.policy ?? resolvePolicy(undefined),
      config,
      Date.now() + Math.max(5_000, config.maxFiles * 100),
      undefined,
    );
    protectedCount = scan.protectedCount;
    if (record !== undefined) dirty = summarize(record, scan);
    verification = "full";
  }

  return JSON.stringify({
    ok: true,
    remotePath,
    exists: destinationExists.exists,
    directory: destinationExists.directory,
    owned: record !== undefined,
    adoptionRequired: record === undefined && destinationExists.exists,
    readiness:
      record?.readiness === "recovery-blocked"
        ? "recovery-blocked"
        : journal !== undefined
          ? journal.phase === "committed"
            ? "committed"
            : "interrupted"
          : (record?.readiness ?? "unbound"),
    revision: record?.revision ?? null,
    digest: record?.digest ?? null,
    policy: record?.policy ?? null,
    verification,
    dirty,
    operation,
    protectedCount,
    journal: journal !== undefined,
    localProject: record?.localProject ?? null,
    epoch: record?.epoch ?? null,
    reboundFrom: record?.reboundFrom ?? [],
    stateDir: stateDir === undefined ? null : stateDir,
    updatedAt: record?.updatedAt ?? null,
  });
}

export interface NodeCommandSet {
  readonly commands: readonly NodeHostCommand[];
  readonly configError: string | undefined;
}

export function createNodeCommands(rawConfig: unknown): NodeCommandSet {
  const state = loadConfig(rawConfig);
  const commands: NodeHostCommand[] = [
    {
      command: "nodews.sync",
      duplex: true,
      dangerous: true,
      hasActiveWork: () => false,
      handle: (params, io, context) => handleSync(state, params, io, context),
    },
    {
      command: "nodews.status",
      dangerous: true,
      hasActiveWork: () => false,
      handle: (params, _io, context) => handleStatus(state, params, context),
    },
  ];
  return { commands, configError: state.error };
}


import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import type { GatewayConfig } from "../config.js";
import { NodeWorkspaceError, errorMessage } from "../errors.js";
import type { PlanConflict, PlanCounts, PlanEntry } from "../managed-plan.js";
import { scanSource, type SourceScan } from "../manifest.js";
import { resolvePolicy, type PolicyInput, type ResolvedPolicy } from "../policy.js";
import {
  COMMAND_SYNC,
  PROTOCOL_VERSION,
  SYNC_ACK_BYTES,
  SYNC_ACK_FILES,
  type SyncHello,
  type SyncPlanMessage,
  type SyncResult,
} from "../protocol.js";
import {
  assertControlFrame,
  controlType,
  FrameSession,
  resolveNodeId,
  type NodeTransport,
} from "../transport.js";
import {
  assertLocalAccess,
  resolveWorkspaceBoundary,
  type WorkspaceBoundary,
} from "./workspace-boundary.js";

export interface SyncProgress {
  readonly phase: "scanning" | "sending" | "applying";
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly bytesDone: number;
  readonly bytesTotal: number;
}

export interface SyncInput {
  readonly node: string;
  readonly localPath: string;
  readonly remotePath: string;
  readonly workspaceRoot: string | undefined;
  readonly operationId: string;
  readonly mode: "preview" | "apply";
  readonly create: boolean;
  readonly adopt: boolean;
  readonly adoptPaths: readonly string[];
  readonly restore: readonly string[];
  readonly rebind: boolean;
  readonly expectedRevision: number | undefined;
  readonly planDigest: string | undefined;
  readonly policy: PolicyInput;
  readonly owner: { readonly agentId: string | null; readonly sessionKey: string | null };
  readonly signal: AbortSignal | undefined;
  readonly progress: ((progress: SyncProgress) => void) | undefined;
}

export interface SyncPlanSummary {
  readonly planDigest: string;
  readonly baseRevision: number;
  readonly counts: PlanCounts;
  readonly entries: readonly PlanEntry[];
  readonly directories: readonly string[];
  readonly restorable: readonly string[];
  readonly conflicts: readonly PlanConflict[];
  readonly createRequired: boolean;
  readonly adoptRequired: boolean;
  readonly policyChanged: boolean;
  readonly safeForRoutine: boolean;
  readonly policy: ResolvedPolicy;
}

export interface SyncOutcome {
  readonly status: "planned" | "applied" | "noop" | "replayed";
  readonly nodeId: string;
  readonly cwd: string;
  readonly operationId: string;
  readonly revision: number;
  readonly digest: string;
  readonly planDigest: string;
  readonly counts: PlanCounts;
  readonly applied: readonly string[];
  readonly truncated: boolean;
  readonly caches: "preserved-not-validated";
  readonly verification: "full";
  readonly recovery: string;
  readonly protectedCount: number;
  readonly nodeProtectedCount: number;
  readonly untracked: number;
  readonly durationMs: number;
  readonly plan: SyncPlanSummary | undefined;
  readonly localSkipped: readonly string[];
  readonly transferredBytes: number;
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new NodeWorkspaceError("canceled", "the operation was canceled", {}, { cause: signal.reason });
  }
}

async function resolveLocalProject(
  localPath: string,
  config: GatewayConfig,
  boundary: WorkspaceBoundary,
): Promise<string> {
  let real: string;
  try {
    real = await fs.realpath(localPath);
  } catch (error) {
    throw new NodeWorkspaceError("path-not-found", `workspace does not exist: ${localPath}`, {}, { cause: error });
  }
  const stat = await fs.lstat(real);
  if (!stat.isDirectory()) {
    throw new NodeWorkspaceError("not-a-directory", `workspace is not a directory: ${real}`);
  }
  await assertLocalAccess(boundary, real, "workspace", config.localRoots, "gateway.localRoots");
  return real;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePlan(value: Record<string, unknown>): SyncPlanMessage {
  const digest = value.planDigest;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
    throw new NodeWorkspaceError("protocol", "the node plan has no valid planDigest");
  }
  if (typeof value.baseRevision !== "number" || !isRecord(value.counts)) {
    throw new NodeWorkspaceError("protocol", "the node plan is missing revision or counts");
  }
  if (!Array.isArray(value.entries) || !Array.isArray(value.directories) || !Array.isArray(value.conflicts)) {
    throw new NodeWorkspaceError("protocol", "the node plan is missing entries, directories or conflicts");
  }
  return value as unknown as SyncPlanMessage;
}

function parseResult(value: Record<string, unknown>): SyncResult {
  if (value.t !== "result" || typeof value.ok !== "boolean") {
    throw new NodeWorkspaceError("protocol", "the node result frame is malformed");
  }
  return value as unknown as SyncResult;
}

function resultError(value: SyncResult & { ok: false }, operationId: string): NodeWorkspaceError {
  if (value.effect === "unknown") {
    return new NodeWorkspaceError(
      "unknown-outcome",
      `${value.message}. The node may have applied this operation; query status with the same operationId before retrying.`,
      { operationId, readiness: value.readiness },
    );
  }
  return new NodeWorkspaceError(value.code as NodeWorkspaceError["code"], value.message, {
    ...(value.affected ? { paths: value.affected } : {}),
  });
}

async function nextControl(session: FrameSession, deadline: number): Promise<Record<string, unknown>> {
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new NodeWorkspaceError("timeout", "the sync exceeded its time budget");
    const frame = await session.next(Math.min(left, 120_000));
    if (frame.kind === "data") throw new NodeWorkspaceError("protocol", "the node sent unexpected file data");
    return assertControlFrame(frame);
  }
}

function localEntries(scan: SourceScan): Map<string, { size: number; sha256: string; executable: boolean }> {
  return new Map(scan.files.map((entry) => [entry.path, entry]));
}

export async function syncManaged(
  transport: NodeTransport,
  config: GatewayConfig,
  input: SyncInput,
): Promise<SyncOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + config.timeoutMs;
  if (input.mode === "apply") {
    if (!/^[0-9a-f]{32}$/u.test(input.operationId)) {
      throw new NodeWorkspaceError(
        "path-invalid",
        "operationId must be 32 lowercase hex characters and stable across retries of this intent",
      );
    }
  }
  const nodeId = await resolveNodeId(transport, input.node);
  const boundary = await resolveWorkspaceBoundary(input.workspaceRoot, "sync a workspace");
  const root = await resolveLocalProject(input.localPath, config, boundary);
  const policy = resolvePolicy(input.policy);
  checkAborted(input.signal);

  input.progress?.({
    phase: "scanning",
    filesDone: 0,
    filesTotal: 0,
    bytesDone: 0,
    bytesTotal: 0,
  });
  const scan = await scanSource({
    root,
    policy,
    limits: {
      maxFiles: config.maxFiles,
      maxFileBytes: config.maxFileBytes,
      maxTotalBytes: config.maxTotalBytes,
    },
    signal: input.signal,
    deadline,
  });
  checkAborted(input.signal);

  const hello: SyncHello = {
    t: "hello",
    protocol: PROTOCOL_VERSION,
    mode: input.mode,
    operationId: input.operationId,
    nodeId,
    owner: input.owner,
    localProject: root,
    remotePath: input.remotePath,
    policy,
    create: input.create,
    adopt: input.adopt,
    adoptPaths: input.adoptPaths,
    restore: input.restore,
    rebind: input.rebind,
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
    ...(input.planDigest !== undefined ? { planDigest: input.planDigest } : {}),
    timeoutMs: config.timeoutMs,
    manifest: scan.files,
    directories: scan.directories,
  };

  let session: FrameSession | undefined;
  let sentEnd = false;
  let transferredBytes = 0;
  let terminalFailure: NodeWorkspaceError | undefined;
  try {
    const channel = await transport.openDuplex({
      nodeId,
      command: COMMAND_SYNC,
      idempotencyKey: input.operationId,
      timeoutMs: config.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    session = FrameSession.openSync(channel);
    await session.sendControl(hello);

    let plan: SyncPlanMessage | undefined;
    let result: SyncResult | undefined;
    for (;;) {
      const value = await nextControl(session, deadline);
      const type = controlType(value);
      if (type === "progress") continue;
      if (type === "plan") {
        plan = parsePlan(value);
        // Apply waits for the payload, so the plan is the last frame before
        // the Gateway must start sending. Preview still expects its result.
        if (input.mode === "apply") break;
        continue;
      }
      if (type === "result") {
        result = parseResult(value);
        break;
      }
      throw new NodeWorkspaceError("protocol", `unexpected control frame ${JSON.stringify(type)} from the node`);
    }
    if (result === undefined && (input.mode !== "apply" || plan === undefined)) {
      throw new NodeWorkspaceError("protocol", "the node sent no result");
    }
    if (result !== undefined && result.ok === false) {
      terminalFailure = resultError(result, input.operationId);
      throw terminalFailure;
    }
    if (
      result !== undefined &&
      (result.status === "planned" || result.status === "replayed" || result.status === "noop")
    ) {
      return {
        status: result.status,
        nodeId,
        cwd: input.remotePath,
        operationId: result.operationId,
        revision: result.revision,
        digest: result.digest,
        planDigest: plan?.planDigest ?? result.planDigest,
        counts: result.counts,
        applied: result.applied,
        truncated: result.truncated,
        caches: result.caches,
        verification: result.verification,
        recovery: result.recovery,
        protectedCount: scan.protectedCount,
        nodeProtectedCount: result.protectedCount,
        untracked: result.untracked,
        durationMs: Date.now() - startedAt,
        plan: plan === undefined ? undefined : summarizePlan(plan),
        localSkipped: scan.skipped.map((entry) => entry.path),
        transferredBytes: 0,
      };
    }

    // Apply: the node waits for exactly the payload its plan requests.
    if (plan === undefined) throw new NodeWorkspaceError("protocol", "the node applied without sending a plan");
    if (input.planDigest !== undefined && plan.planDigest !== input.planDigest) {
      throw new NodeWorkspaceError("plan-stale", "the node plan changed between preview and apply", {
        expected: input.planDigest,
        actual: plan.planDigest,
      });
    }
    const payload = plan.entries.filter(
      (entry) => entry.kind === "add" || entry.kind === "change" || entry.kind === "restore",
    );
    const local = localEntries(scan);
    let filesDone = 0;
    let bytesDone = 0;
    const bytesTotal = payload.reduce((total, entry) => total + (entry.after?.size ?? 0), 0);
    let lastProgressAt = 0;
    const report = (phase: SyncProgress["phase"], force = false): void => {
      const now = Date.now();
      if (!force && now - lastProgressAt < 150) return;
      lastProgressAt = now;
      input.progress?.({
        phase,
        filesDone,
        filesTotal: payload.length,
        bytesDone,
        bytesTotal,
      });
    };

    const pending: { path: string; bytes: number }[] = [];
    let pendingBytes = 0;
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      const active = session;
      if (active === undefined) throw new NodeWorkspaceError("transport", "node channel disappeared");
      await active.sendControl({ t: "batch", files: pending.length, bytes: pendingBytes });
      const expected = [...pending];
      pending.length = 0;
      pendingBytes = 0;
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) throw new NodeWorkspaceError("timeout", "the sync exceeded its time budget");
        const frame = await active.next(Math.min(left, 120_000));
        if (frame.kind === "data") throw new NodeWorkspaceError("protocol", "the node sent data while acknowledging");
        const value = assertControlFrame(frame);
        const type = controlType(value);
        if (type === "progress") continue;
        if (type === "result") {
          const early = parseResult(value);
          if (early.ok === false) {
            terminalFailure = resultError(early, input.operationId);
            throw terminalFailure;
          }
          throw new NodeWorkspaceError("protocol", "the node committed before acknowledging the sent window");
        }
        if (type !== "files-ok") {
          throw new NodeWorkspaceError("protocol", `unexpected control frame ${JSON.stringify(type)} while sending`);
        }
        if (!Array.isArray(value.files) || value.files.length !== expected.length) {
          throw new NodeWorkspaceError("integrity", "the node acknowledgement has the wrong file count");
        }
        for (let index = 0; index < expected.length; index += 1) {
          const ack = value.files[index] as Record<string, unknown> | undefined;
          const sent = expected[index];
          if (ack === undefined || sent === undefined || ack.path !== sent.path || ack.bytes !== sent.bytes) {
            throw new NodeWorkspaceError("integrity", "the node acknowledgement does not match the sent window");
          }
        }
        return;
      }
    };

    report("sending", true);
    for (const entry of payload) {
      checkAborted(input.signal);
      const source = local.get(entry.path);
      const expected = entry.after;
      if (source === undefined || expected === null) {
        throw new NodeWorkspaceError("integrity", `the plan requests an unknown local file: ${entry.path}`);
      }
      if (source.size !== expected.size || source.sha256 !== expected.sha256) {
        throw new NodeWorkspaceError(
          "local-conflict",
          `${entry.path} changed after the local scan; nothing was applied. Retry the sync.`,
        );
      }
      await session.sendControl({ t: "file", path: entry.path });
      const absolute = [root, ...entry.path.split("/")].join("/");
      const handle = await fs.open(absolute, "r");
      try {
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(config.chunkBytes);
        let sent = 0;
        for (;;) {
          checkAborted(input.signal);
          if (Date.now() >= deadline) throw new NodeWorkspaceError("timeout", "the sync exceeded its time budget");
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, sent);
          if (bytesRead === 0) break;
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          await session.sendData(chunk);
          sent += bytesRead;
          bytesDone += bytesRead;
          transferredBytes += bytesRead;
          if (sent > expected.size) {
            throw new NodeWorkspaceError("local-conflict", `${entry.path} grew after the scan; nothing was applied`);
          }
          report("sending");
        }
        if (sent !== expected.size || hash.digest("hex") !== expected.sha256) {
          throw new NodeWorkspaceError("local-conflict", `${entry.path} changed after the scan; nothing was applied`);
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      pending.push({ path: entry.path, bytes: expected.size });
      pendingBytes += expected.size;
      filesDone += 1;
      if (pending.length >= SYNC_ACK_FILES || pendingBytes >= SYNC_ACK_BYTES) await flush();
    }
    await flush();
    report("applying", true);
    // The frame may be delivered before send() rejects. Mark the possible
    // commit before the attempt so a delivered-then-error send is unknown.
    sentEnd = true;
    await session.sendControl({ t: "end" });

    for (;;) {
      const value = await nextControl(session, deadline);
      const type = controlType(value);
      if (type === "progress") continue;
      if (type === "files-ok") continue;
      if (type !== "result") {
        throw new NodeWorkspaceError("protocol", `unexpected control frame ${JSON.stringify(type)} after apply`);
      }
      const applied = parseResult(value);
      if (applied.ok === false) {
        terminalFailure = resultError(applied, input.operationId);
        throw terminalFailure;
      }
      return {
        status: applied.status === "noop" ? "noop" : "applied",
        nodeId,
        cwd: input.remotePath,
        operationId: applied.operationId,
        revision: applied.revision,
        digest: applied.digest,
        planDigest: applied.planDigest,
        counts: applied.counts,
        applied: applied.applied,
        truncated: applied.truncated,
        caches: applied.caches,
        verification: applied.verification,
        recovery: applied.recovery,
        protectedCount: scan.protectedCount,
        nodeProtectedCount: applied.protectedCount,
        untracked: applied.untracked,
        durationMs: Date.now() - startedAt,
        plan: summarizePlan(plan),
        localSkipped: scan.skipped.map((entry) => entry.path),
        transferredBytes,
      };
    }
  } catch (caught) {
    if (terminalFailure !== undefined) throw terminalFailure;
    if (caught instanceof NodeWorkspaceError && caught.code === "canceled") throw caught;
    const detail = errorMessage(caught);
    if (sentEnd) {
      throw new NodeWorkspaceError(
        "unknown-outcome",
        `the node may or may not have applied this operation (operationId ${input.operationId}, node ${nodeId}): ${detail}. ` +
          `Do not retry blindly; call node_workspace_status with this operationId first.`,
        { operationId: input.operationId, nodeId, remotePath: input.remotePath },
        { cause: caught },
      );
    }
    if (caught instanceof NodeWorkspaceError) throw caught;
    throw new NodeWorkspaceError("transport", `the sync failed before any node mutation: ${detail}`, {}, {
      cause: caught,
    });
  } finally {
    session?.close();
  }
}

function summarizePlan(plan: SyncPlanMessage): SyncPlanSummary {
  return {
    planDigest: plan.planDigest,
    baseRevision: plan.baseRevision,
    counts: plan.counts,
    entries: plan.entries,
    directories: plan.directories,
    restorable: plan.restorable,
    conflicts: plan.conflicts,
    createRequired: plan.createRequired,
    adoptRequired: plan.adoptRequired,
    policyChanged: plan.policyChanged,
    safeForRoutine: plan.safeForRoutine,
    policy: plan.policy,
  };
}

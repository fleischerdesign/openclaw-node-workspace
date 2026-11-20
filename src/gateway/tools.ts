import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";

import type { GatewayConfig } from "../config.js";
import { NodeWorkspaceError } from "../errors.js";
import type { PolicyInput, PolicyPreset } from "../policy.js";
import type { NodeTransport } from "../transport.js";
import { fetchArtifact } from "./artifact.js";
import { managedStatus } from "./managed-status.js";
import { syncManaged, type SyncOutcome, type SyncProgress } from "./sync.js";
import type { TransferProgressStore, TransferScope } from "./progress-store.js";

export interface ToolDependencies {
  readonly transport: NodeTransport;
  readonly config: GatewayConfig | undefined;
  readonly configError: string | undefined;
  /** Workspace directory the host resolved for this session; absent fails closed. */
  readonly workspaceDir?: string | undefined;
  readonly workspaceError?: string | undefined;
  /** Authenticated session identity supplied by the host. */
  readonly scope?: TransferScope;
  readonly progress?: TransferProgressStore;
  readonly onProgressChange?: (terminal?: boolean) => void;
}

export interface AgentUpdate {
  content: { type: "text"; text: string }[];
  details: unknown;
  progress?: {
    text: string;
    visibility: "channel";
    privacy: "public";
    id: string;
  };
}

export interface ToolFailure {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}

function requireConfig(deps: ToolDependencies): GatewayConfig {
  if (!deps.config) {
    throw new NodeWorkspaceError("config-invalid", deps.configError ?? "plugin configuration is invalid");
  }
  return deps.config;
}

function requireWorkspace(deps: ToolDependencies, operation: string): string {
  if (deps.workspaceDir !== undefined && deps.workspaceDir.length > 0) return deps.workspaceDir;
  const detail = deps.workspaceError ?? "the host resolved no workspace directory for this session";
  throw new NodeWorkspaceError("workspace-unresolved", `${detail}; refusing to ${operation}`);
}

export function toolFailure(
  tool: string,
  error: unknown,
  context: { node?: string; remotePath?: string; localPath?: string; operationId?: string } = {},
): ToolFailure {
  if (!(error instanceof NodeWorkspaceError)) throw error;
  const unknown = error.code === "unknown-outcome";
  const details: Record<string, unknown> = {
    ok: false,
    code: error.code,
    message: error.message,
    unknownOutcome: unknown,
  };
  for (const key of ["operationId", "nodeId", "remotePath", "localPath", "readiness", "paths"] as const) {
    const value = error.details[key];
    if (typeof value === "string" || Array.isArray(value)) details[key] = value;
  }
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === "string" && details[key] === undefined) details[key] = value;
  }
  const prefix = unknown ? "UNKNOWN OUTCOME — do not retry blindly" : "failed";
  return {
    content: [{ type: "text", text: `${tool} ${prefix} [${error.code}]: ${error.message}` }],
    details,
  };
}

function progressText(progress: SyncProgress): string {
  const total = progress.filesTotal;
  const files = total === 0 ? "scanning" : `${progress.filesDone}/${total} files`;
  const mib = (progress.bytesDone / (1024 * 1024)).toFixed(1);
  return `Node workspace ${progress.phase}: ${files}, ${mib} MiB`;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NodeWorkspaceError("path-invalid", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireField(record: Record<string, unknown>, key: string, maximum: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new NodeWorkspaceError("path-invalid", `${key} must be a non-empty string of at most ${maximum} characters`);
  }
  if (value.includes("\0")) throw new NodeWorkspaceError("path-invalid", `${key} must not contain a NUL byte`);
  return value;
}

function parsePatternArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 200) {
    throw new NodeWorkspaceError("path-invalid", `${label} must be an array of at most 200 patterns`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 1024) {
      throw new NodeWorkspaceError("path-invalid", `${label}[${index}] must be a non-empty string`);
    }
    return entry;
  });
}

function parsePolicy(value: unknown): PolicyInput {
  if (value === undefined) return {};
  const record = requireRecord(value, "policy");
  const preset = record.preset;
  if (preset !== undefined && preset !== "none" && preset !== "node" && preset !== "rust") {
    throw new NodeWorkspaceError("path-invalid", 'policy.preset must be "none", "node" or "rust"');
  }
  return {
    ...(preset !== undefined ? { preset: preset as PolicyPreset } : {}),
    include: parsePatternArray(record.include, "policy.include"),
    exclude: parsePatternArray(record.exclude, "policy.exclude"),
    protect: parsePatternArray(record.protect, "policy.protect"),
  };
}

interface SyncParams {
  readonly node: string;
  readonly localPath: string;
  readonly remotePath: string;
  readonly mode: "preview" | "apply";
  readonly operationId: string;
  readonly create: boolean;
  readonly adopt: boolean;
  readonly adoptPaths: readonly string[];
  readonly restore: readonly string[];
  readonly rebind: boolean;
  readonly expectedRevision: number | undefined;
  readonly planDigest: string | undefined;
  readonly policy: PolicyInput;
}

function parseSyncParams(value: unknown): SyncParams {
  const record = requireRecord(value, "sync parameters");
  const mode = record.mode ?? "apply";
  if (mode !== "preview" && mode !== "apply") {
    throw new NodeWorkspaceError("path-invalid", 'mode must be "preview" or "apply"');
  }
  const operationId =
    record.operationId === undefined ? randomUUID().replace(/-/gu, "").slice(0, 32) : requireField(record, "operationId", 32);
  if (mode === "apply" && !/^[0-9a-f]{32}$/u.test(operationId)) {
    throw new NodeWorkspaceError(
      "path-invalid",
      "operationId must be 32 lowercase hex characters and stable across retries of the same intent",
    );
  }
  const planDigest = record.planDigest === undefined ? undefined : requireField(record, "planDigest", 64);
  if (planDigest !== undefined && !/^[0-9a-f]{64}$/u.test(planDigest)) {
    throw new NodeWorkspaceError("path-invalid", "planDigest must be 64 lowercase hex characters");
  }
  const expectedRevision =
    record.expectedRevision === undefined ? undefined : Number(record.expectedRevision);
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw new NodeWorkspaceError("path-invalid", "expectedRevision must be a non-negative integer");
  }
  const boolean = (key: string): boolean => {
    const raw = record[key];
    if (raw === undefined) return false;
    if (typeof raw !== "boolean") throw new NodeWorkspaceError("path-invalid", `${key} must be a boolean`);
    return raw;
  };
  return {
    node: requireField(record, "node", 256),
    localPath: requireField(record, "localPath", 4096),
    remotePath: requireField(record, "remotePath", 4096),
    mode,
    operationId,
    create: boolean("create"),
    adopt: boolean("adopt"),
    adoptPaths: parsePatternArray(record.adoptPaths, "adoptPaths") ?? [],
    restore: parsePatternArray(record.restore, "restore") ?? [],
    rebind: boolean("rebind"),
    expectedRevision,
    planDigest,
    policy: parsePolicy(record.policy),
  };
}

const policySchema = Type.Object(
  {
    preset: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("node"), Type.Literal("rust")])),
    include: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    exclude: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    protect: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);

const syncParameters = Type.Object(
  {
    node: Type.String({ minLength: 1, description: "Paired node id or exact display name." }),
    localPath: Type.String({
      minLength: 1,
      description: "Absolute Gateway source directory. It must resolve inside the session workspace.",
    }),
    remotePath: Type.String({
      minLength: 1,
      description: "Stable absolute destination directory on the node. It must stay the same across syncs.",
    }),
    mode: Type.Optional(
      Type.Union([Type.Literal("preview"), Type.Literal("apply")], {
        description:
          "preview plans and writes nothing; apply updates the workspace. Creation, adoption, deletion, " +
          "restore, rebind and policy changes require the planDigest from a preview.",
      }),
    ),
    operationId: Type.Optional(
      Type.String({
        minLength: 32,
        maxLength: 32,
        description:
          "Stable 32-hex id for one apply intent. A retry with the same id returns the original receipt instead of reapplying.",
      }),
    ),
    create: Type.Optional(Type.Boolean({ description: "Authorize creating a new managed workspace." })),
    adopt: Type.Optional(
      Type.Boolean({ description: "Authorize adopting an existing unmanaged directory after a pinned preview." }),
    ),
    adoptPaths: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Exact previously released paths to re-adopt. Requires a pinned preview.",
      }),
    ),
    restore: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description:
          "Exact base paths missing on the node whose local content still equals the base. Requires a pinned preview.",
      }),
    ),
    rebind: Type.Optional(
      Type.Boolean({ description: "Move the binding to a different local project under the same authenticated owner." }),
    ),
    expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    planDigest: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })),
    policy: Type.Optional(policySchema),
  },
  { additionalProperties: false },
);

const planCountsSchema = Type.Object(
  {
    add: Type.Number(),
    change: Type.Number(),
    delete: Type.Number(),
    mode: Type.Number(),
    restore: Type.Number(),
    adopt: Type.Number(),
    conflicts: Type.Number(),
    unchanged: Type.Number(),
    untracked: Type.Number(),
    released: Type.Number(),
  },
  { additionalProperties: false },
);

const planOperationSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("add"),
      Type.Literal("change"),
      Type.Literal("delete"),
      Type.Literal("mode"),
      Type.Literal("restore"),
      Type.Literal("adopt"),
    ]),
    path: Type.String(),
  },
  { additionalProperties: false },
);

const syncSuccess = Type.Object(
  {
    ok: Type.Literal(true),
    status: Type.Union([
      Type.Literal("planned"),
      Type.Literal("applied"),
      Type.Literal("noop"),
      Type.Literal("replayed"),
    ]),
    nodeId: Type.String(),
    cwd: Type.String(),
    operationId: Type.String(),
    revision: Type.Number(),
    digest: Type.String(),
    planDigest: Type.String(),
    counts: planCountsSchema,
    operations: Type.Array(planOperationSchema),
    conflicts: Type.Array(
      Type.Object({ path: Type.String(), reason: Type.String() }, { additionalProperties: false }),
    ),
    restorable: Type.Array(Type.String()),
    createRequired: Type.Boolean(),
    adoptRequired: Type.Boolean(),
    policyChanged: Type.Boolean(),
    safeForRoutine: Type.Boolean(),
    caches: Type.Literal("preserved-not-validated"),
    verification: Type.Literal("full"),
    recovery: Type.String(),
    protectedCount: Type.Number(),
    nodeProtectedCount: Type.Number(),
    untracked: Type.Number(),
    transferredBytes: Type.Number(),
    durationMs: Type.Number(),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

const failureShape = {
  ok: Type.Literal(false),
  code: Type.String(),
  message: Type.String(),
  unknownOutcome: Type.Boolean(),
  operationId: Type.Optional(Type.String()),
  node: Type.Optional(Type.String()),
  nodeId: Type.Optional(Type.String()),
  remotePath: Type.Optional(Type.String()),
  localPath: Type.Optional(Type.String()),
  readiness: Type.Optional(Type.String()),
  paths: Type.Optional(Type.Array(Type.String())),
} as const;

const syncFailure = Type.Object(failureShape, { additionalProperties: false });

const artifactParameters = Type.Object(
  {
    node: Type.String({ minLength: 1, description: "Paired node id or exact display name." }),
    remotePath: Type.String({
      minLength: 1,
      description: "Absolute POSIX path of the artifact on the node. Must be inside node.artifactRoots.",
    }),
    localPath: Type.String({
      minLength: 1,
      description:
        "Absolute destination file on the Gateway. It must resolve inside the session workspace; " +
        "gateway.artifactRoots, when set, narrows that further. It must not exist; it is never overwritten.",
    }),
  },
  { additionalProperties: false },
);

const artifactDetails = Type.Object(
  {
    ok: Type.Literal(true),
    nodeId: Type.String(),
    localPath: Type.String(),
    sha256: Type.String(),
    bytes: Type.Number(),
    mode: Type.Number(),
  },
  { additionalProperties: false },
);

const statusParameters = Type.Object(
  {
    node: Type.String({ minLength: 1, description: "Paired node id or exact display name." }),
    remotePath: Type.Optional(
      Type.String({ minLength: 1, description: "Absolute managed directory on the node. Omit for owned inventory." }),
    ),
    operationId: Type.Optional(
      Type.String({ minLength: 32, maxLength: 32, description: "Query the durable receipt of one operation." }),
    ),
    verify: Type.Optional(
      Type.Boolean({ description: "Hash selected source on the node. False reports registry metadata only." }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);

const statusDetails = Type.Object(
  {
    ok: Type.Literal(true),
    nodeId: Type.String(),
    remotePath: Type.Optional(Type.String()),
    exists: Type.Optional(Type.Boolean()),
    directory: Type.Optional(Type.Boolean()),
    owned: Type.Optional(Type.Boolean()),
    adoptionRequired: Type.Optional(Type.Boolean()),
    readiness: Type.Optional(Type.String()),
    revision: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    digest: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    policy: Type.Optional(Type.Unknown()),
    verification: Type.Optional(Type.String()),
    dirty: Type.Optional(Type.Union([Type.Unknown(), Type.Null()])),
    operation: Type.Optional(Type.Union([Type.Unknown(), Type.Null()])),
    protectedCount: Type.Optional(Type.Number()),
    journal: Type.Optional(Type.Boolean()),
    localProject: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    epoch: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    reboundFrom: Type.Optional(Type.Array(Type.String())),
    stateDir: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    updatedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    workspaces: Type.Optional(Type.Array(Type.Unknown())),
    truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const MAX_REPORTED_PATHS = 200;

function summarize(plan: SyncOutcome["plan"]): {
  operations: { kind: string; path: string }[];
  conflicts: { path: string; reason: string }[];
  restorable: string[];
  createRequired: boolean;
  adoptRequired: boolean;
  policyChanged: boolean;
  safeForRoutine: boolean;
  truncated: boolean;
} {
  if (plan === undefined) {
    return {
      operations: [],
      conflicts: [],
      restorable: [],
      createRequired: false,
      adoptRequired: false,
      policyChanged: false,
      safeForRoutine: true,
      truncated: false,
    };
  }
  return {
    operations: plan.entries.slice(0, MAX_REPORTED_PATHS).map((entry) => ({ kind: entry.kind, path: entry.path })),
    conflicts: plan.conflicts.slice(0, MAX_REPORTED_PATHS).map((entry) => ({
      path: entry.path,
      reason: entry.reason,
    })),
    restorable: plan.restorable.slice(0, MAX_REPORTED_PATHS),
    createRequired: plan.createRequired,
    adoptRequired: plan.adoptRequired,
    policyChanged: plan.policyChanged,
    safeForRoutine: plan.safeForRoutine,
    truncated:
      plan.entries.length > MAX_REPORTED_PATHS ||
      plan.conflicts.length > MAX_REPORTED_PATHS ||
      plan.restorable.length > MAX_REPORTED_PATHS,
  };
}

export function createTools(deps: ToolDependencies): AnyAgentTool[] {
  return [
    {
      name: "node_workspace_sync",
      label: "Sync a persistent workspace to a node",
      description:
        "Update one stable managed source directory on a paired node in place. Unchanged files are not rewritten, " +
        "build caches (node_modules, target, configured excludes) are preserved and never read, and protected secret-like " +
        "paths never cross the channel. A node edit that differs from the committed base blocks the update; nothing is " +
        "silently overwritten or deleted. Deletions, creation, adoption, restore, rebind and policy changes require a " +
        "pinned preview: call with mode=preview, then apply with the returned planDigest. A no-op writes nothing. " +
        "Use a stable operationId for apply; a retry after an unknown outcome returns the original receipt.",
      parameters: syncParameters,
      outputSchema: Type.Union([syncSuccess, syncFailure]),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: (update: AgentUpdate) => void) {
        let context: { node?: string; remotePath?: string; localPath?: string; operationId?: string } = {};
        const transferId = randomUUID();
        const scope = deps.scope;
        const tracked = scope && deps.progress ? { scope, store: deps.progress } : undefined;
        let settled = false;
        try {
          const config = requireConfig(deps);
          const input = parseSyncParams(params);
          const workspaceRoot = requireWorkspace(deps, "sync a workspace");
          context = {
            node: input.node,
            remotePath: input.remotePath,
            localPath: input.localPath,
            operationId: input.operationId,
          };
          tracked?.store.begin(scope as TransferScope, transferId, "sync");
          const outcome = await syncManaged(deps.transport, config, {
            node: input.node,
            localPath: input.localPath,
            remotePath: input.remotePath,
            workspaceRoot,
            operationId: input.operationId,
            mode: input.mode,
            create: input.create,
            adopt: input.adopt,
            adoptPaths: input.adoptPaths,
            restore: input.restore,
            rebind: input.rebind,
            expectedRevision: input.expectedRevision,
            planDigest: input.planDigest,
            policy: input.policy,
            owner: {
              agentId: scope?.agentId ?? null,
              sessionKey: scope?.sessionKey ?? null,
            },
            signal,
            progress: (progress) => {
              if (tracked) tracked.store.updateFromSync(tracked.scope, transferId, progress);
              deps.onProgressChange?.();
              onUpdate?.({
                content: [{ type: "text", text: progressText(progress) }],
                details: { phase: progress.phase },
                progress: {
                  text: progressText(progress),
                  visibility: "channel",
                  privacy: "public",
                  id: "node-workspace-sync",
                },
              });
            },
          });
          tracked?.store.finish(scope as TransferScope, transferId, "completed");
          settled = true;
          deps.onProgressChange?.(true);
          const detail = summarize(outcome.plan);
          const counts = outcome.counts;
          const summary =
            `${counts.add} add, ${counts.change} change, ${counts.delete} delete, ${counts.mode} mode, ` +
            `${counts.restore} restore, ${counts.unchanged} unchanged`;
          const conflicts =
            detail.conflicts.length === 0
              ? ""
              : ` Conflicts: ${detail.conflicts.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}.`;
          const next =
            outcome.status === "planned"
              ? detail.conflicts.length > 0
                ? " Nothing will be written until these are resolved."
                : ` Apply with planDigest ${outcome.planDigest}.`
              : "";
          const recovery = outcome.recovery === "clean" ? "" : ` Recovery: ${outcome.recovery}.`;
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `${outcome.status}: ${outcome.cwd} on node ${outcome.nodeId}, revision ${outcome.revision}, ` +
                  `digest ${outcome.digest || "none"}. ${summary}.${conflicts}${next}${recovery} ` +
                  `Caches are preserved but not validated. Run commands there with exec: host=node, node=${outcome.nodeId}, workdir=${outcome.cwd}.`,
              },
            ],
            details: {
              ok: true as const,
              status: outcome.status,
              nodeId: outcome.nodeId,
              cwd: outcome.cwd,
              operationId: outcome.operationId,
              revision: outcome.revision,
              digest: outcome.digest,
              planDigest: outcome.planDigest,
              counts,
              operations: detail.operations,
              conflicts: detail.conflicts,
              restorable: detail.restorable,
              createRequired: detail.createRequired,
              adoptRequired: detail.adoptRequired,
              policyChanged: detail.policyChanged,
              safeForRoutine: detail.safeForRoutine,
              caches: outcome.caches,
              verification: outcome.verification,
              recovery: outcome.recovery,
              protectedCount: outcome.protectedCount,
              nodeProtectedCount: outcome.nodeProtectedCount,
              untracked: outcome.untracked,
              transferredBytes: outcome.transferredBytes,
              durationMs: outcome.durationMs,
              truncated: outcome.truncated || detail.truncated,
            },
          };
        } catch (error) {
          if (!settled) {
            const state =
              error instanceof NodeWorkspaceError && error.code === "unknown-outcome"
                ? "unknown"
                : signal?.aborted || (error instanceof NodeWorkspaceError && error.code === "canceled")
                  ? "cancelled"
                  : "failed";
            const reasonCode = error instanceof NodeWorkspaceError ? error.code : undefined;
            if (tracked) tracked.store.finish(tracked.scope, transferId, state, reasonCode);
            deps.onProgressChange?.(true);
          }
          return toolFailure("node_workspace_sync", error, context);
        }
      },
    },
    {
      name: "node_workspace_status",
      label: "Inspect managed node workspaces",
      description:
        "Read-only managed workspace status. With remotePath it reports readiness, revision, policy, protected/untracked " +
        "counts and, when verify is true, a source-only drift summary hashed on the node. With operationId it returns the " +
        "durable receipt for that operation. Without remotePath it lists the bounded owned inventory. " +
        "Use it after an unknown outcome before any retry.",
      parameters: statusParameters,
      outputSchema: Type.Union([statusDetails, syncFailure]),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        let context: { node?: string; remotePath?: string; operationId?: string } = {};
        try {
          const config = requireConfig(deps);
          const record = requireRecord(params, "status parameters");
          const node = requireField(record, "node", 256);
          const remotePath =
            record.remotePath === undefined ? undefined : requireField(record, "remotePath", 4096);
          const operationId =
            record.operationId === undefined ? undefined : requireField(record, "operationId", 32);
          if (operationId !== undefined && !/^[0-9a-f]{32}$/u.test(operationId)) {
            throw new NodeWorkspaceError("path-invalid", "operationId must be 32 lowercase hex characters");
          }
          const verify = record.verify === undefined ? undefined : record.verify === true;
          const limit = typeof record.limit === "number" ? record.limit : undefined;
          context = { node, ...(remotePath !== undefined ? { remotePath } : {}), ...(operationId ? { operationId } : {}) };
          const outcome = await managedStatus(deps.transport, config, {
            node,
            ...(remotePath !== undefined ? { remotePath } : {}),
            ...(operationId !== undefined ? { operationId } : {}),
            ...(verify !== undefined ? { verify } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(signal ? { signal } : {}),
          });
          const value = outcome.value;
          const text =
            remotePath === undefined
              ? `Owned workspaces on node ${outcome.nodeId}: ${Array.isArray(value.workspaces) ? value.workspaces.length : 0}.`
              : value.owned === true
                ? `${String(value.remotePath)}: readiness ${String(value.readiness)}, revision ${String(value.revision)}, verification ${String(value.verification)}.`
                : value.exists === true
                  ? `${String(value.remotePath)} exists but is not managed by this plugin; adoption needs a pinned preview.`
                  : `${String(value.remotePath)} does not exist on node ${outcome.nodeId}.`;
          return {
            content: [{ type: "text" as const, text }],
            details: { ok: true as const, nodeId: outcome.nodeId, ...value },
          };
        } catch (error) {
          return toolFailure("node_workspace_status", error, context);
        }
      },
    },
    {
      name: "node_workspace_artifact",
      label: "Fetch an artifact from a node",
      description:
        "Fetch one explicitly selected file from a paired node to the Gateway over the OpenClaw node channel. " +
        "The bytes are verified against the node's SHA-256 before publication and the destination is created exclusively: " +
        "an existing file is never overwritten.",
      parameters: artifactParameters,
      outputSchema: Type.Union([artifactDetails, syncFailure]),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: (update: AgentUpdate) => void) {
        let context: { node?: string; remotePath?: string; localPath?: string } = {};
        const transferId = randomUUID();
        const scope = deps.scope;
        const tracked = scope && deps.progress ? { scope, store: deps.progress } : undefined;
        let settled = false;
        try {
          const config = requireConfig(deps);
          const input = requireRecord(params, "artifact parameters");
          const node = requireField(input, "node", 256);
          const remotePath = requireField(input, "remotePath", 4096);
          const localPath = requireField(input, "localPath", 4096);
          const workspaceRoot = requireWorkspace(deps, "fetch an artifact");
          context = { node, remotePath, localPath };
          tracked?.store.begin(scope as TransferScope, transferId, "fetch");
          const outcome = await fetchArtifact(deps.transport, config, {
            node,
            remotePath,
            localPath,
            workspaceRoot,
            signal,
            progress: (bytesDone, bytesTotal) => {
              tracked?.store.updateFetch(tracked!.scope, transferId, bytesDone, bytesTotal);
              deps.onProgressChange?.();
              if (onUpdate) {
                const percent = bytesTotal === 0 ? 100 : Math.floor((bytesDone / bytesTotal) * 100);
                onUpdate({
                  content: [{ type: "text", text: `Node artifact fetch: ${percent}%` }],
                  details: { bytesDone, bytesTotal },
                  progress: {
                    text: `Node artifact fetch: ${percent}%`,
                    visibility: "channel",
                    privacy: "public",
                    id: "node-workspace-artifact",
                  },
                });
              }
            },
          });
          tracked?.store.finish(scope as TransferScope, transferId, "completed");
          settled = true;
          deps.onProgressChange?.(true);
          return {
            content: [
              {
                type: "text" as const,
                text: `Wrote ${outcome.bytes} bytes to ${outcome.localPath} (sha256 ${outcome.sha256}). The destination did not exist before this call.`,
              },
            ],
            details: {
              ok: true as const,
              nodeId: outcome.nodeId,
              localPath: outcome.localPath,
              sha256: outcome.sha256,
              bytes: outcome.bytes,
              mode: outcome.mode,
            },
          };
        } catch (error) {
          if (!settled) {
            const state =
              error instanceof NodeWorkspaceError && error.code === "unknown-outcome"
                ? "unknown"
                : signal?.aborted || (error instanceof NodeWorkspaceError && error.code === "canceled")
                  ? "cancelled"
                  : "failed";
            const reasonCode = error instanceof NodeWorkspaceError ? error.code : undefined;
            if (tracked) tracked.store.finish(tracked.scope, transferId, state, reasonCode);
            deps.onProgressChange?.(true);
          }
          return toolFailure("node_workspace_artifact", error, context);
        }
      },
    },
  ];
}

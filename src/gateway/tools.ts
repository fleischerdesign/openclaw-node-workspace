import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";

import type { GatewayConfig } from "../config.js";
import { NodeWorkspaceError } from "../errors.js";
import type { NodeTransport } from "../transport.js";
import { fetchArtifact } from "./artifact.js";
import { pushWorkspace, type PushProgress } from "./push.js";
import { MAX_RETURN_OPERATIONS, applyReturn, previewReturn, type ReturnProgress } from "./return.js";
import type { TransferProgressStore, TransferScope } from "./progress-store.js";
import { workspaceStatus, type StatusOutcome } from "./status.js";

export interface ToolDependencies {
  readonly transport: NodeTransport;
  readonly config: GatewayConfig | undefined;
  readonly configError: string | undefined;
  /** Session identity supplied by the host; absent for direct in-process tests. */
  readonly scope?: TransferScope;
  /** Session-scoped measured progress registry. */
  readonly progress?: TransferProgressStore;
  /** Wake feature subscribers after the registry changed. */
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

function requireConfig(deps: ToolDependencies): GatewayConfig {
  if (!deps.config) {
    throw new NodeWorkspaceError("config-invalid", deps.configError ?? "plugin configuration is invalid");
  }
  return deps.config;
}

export interface ToolFailure {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}

/**
 * Return a coded failure as an ordinary tool result.
 *
 * OpenClaw's tools.invoke boundary turns a thrown plugin error into a generic
 * internal_error, which hides unknown-outcome and every other code from the
 * agent. A structured details object preserves the outcome the caller needs.
 */
export function toolFailure(
  tool: string,
  error: unknown,
  context: { node?: string; remotePath?: string; localPath?: string } = {},
): ToolFailure {
  if (!(error instanceof NodeWorkspaceError)) throw error;
  const unknown = error.code === "unknown-outcome";
  const details: Record<string, unknown> = {
    ok: false,
    code: error.code,
    message: error.message,
    unknownOutcome: unknown,
  };
  for (const key of ["pushId", "nodeId", "remotePath", "localPath", "partial"] as const) {
    const value = error.details[key];
    if (typeof value === "string" || typeof value === "boolean") details[key] = value;
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

function progressText(progress: PushProgress): string {
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

interface PushParams {
  readonly node: string;
  readonly localPath: string;
  readonly remotePath: string;
  readonly incrementalFrom: string | undefined;
  readonly exclude: readonly string[] | undefined;
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

interface ReturnParams {
  readonly node: string;
  readonly remotePath: string;
  readonly localPath: string;
  readonly include: readonly string[] | undefined;
  readonly exclude: readonly string[] | undefined;
}

function parseReturnParams(value: unknown, withDigest: boolean): ReturnParams & { planDigest?: string } {
  const record = requireRecord(value, "return parameters");
  const planDigest = withDigest ? requireField(record, "planDigest", 64) : undefined;
  if (withDigest && !/^[0-9a-f]{64}$/.test(planDigest ?? "")) {
    throw new NodeWorkspaceError("path-invalid", "planDigest must be 64 lowercase hex characters");
  }
  return {
    node: requireField(record, "node", 256),
    remotePath: requireField(record, "remotePath", 4096),
    localPath: requireField(record, "localPath", 4096),
    include: parsePatternArray(record.include, "include"),
    exclude: parsePatternArray(record.exclude, "exclude"),
    ...(planDigest ? { planDigest } : {}),
  };
}

function parsePushParams(value: unknown): PushParams {
  const record = requireRecord(value, "push parameters");
  const incrementalValue = record.incrementalFrom;
  let incrementalFrom: string | undefined;
  if (incrementalValue !== undefined) {
    incrementalFrom = requireField(record, "incrementalFrom", 4096);
  }
  return {
    node: requireField(record, "node", 256),
    localPath: requireField(record, "localPath", 4096),
    remotePath: requireField(record, "remotePath", 4096),
    incrementalFrom,
    exclude: parsePatternArray(record.exclude, "exclude"),
  };
}

function parseArtifactParams(value: unknown): { node: string; remotePath: string; localPath: string } {
  const record = requireRecord(value, "artifact parameters");
  return {
    node: requireField(record, "node", 256),
    remotePath: requireField(record, "remotePath", 4096),
    localPath: requireField(record, "localPath", 4096),
  };
}

function parseStatusParams(value: unknown): { node: string; remotePath: string } {
  const record = requireRecord(value, "status parameters");
  return {
    node: requireField(record, "node", 256),
    remotePath: requireField(record, "remotePath", 4096),
  };
}

const pushParameters = Type.Object(
  {
    node: Type.String({ minLength: 1, description: "Paired node id or exact display name." }),
    localPath: Type.String({
      minLength: 1,
      description: "Absolute path of the Gateway directory to publish. Must be inside gateway.localRoots.",
    }),
    remotePath: Type.String({
      minLength: 1,
      description:
        "Absolute POSIX destination directory on the node. It must not exist; this plugin never replaces an existing directory.",
    }),
    incrementalFrom: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Absolute remotePath of a previous plugin-owned publication to reuse unchanged files from. " +
          "Only changed bytes cross the channel; the base directory is never modified. The new destination must still be new.",
      }),
    ),
    exclude: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Additional minimatch patterns relative to the selected workspace root.",
      }),
    ),
  },
  { additionalProperties: false },
);

const pushSuccess = Type.Object(
  {
    ok: Type.Literal(true),
    status: Type.Union([Type.Literal("published"), Type.Literal("already-applied")]),
    nodeId: Type.String(),
    cwd: Type.String(),
    pushId: Type.String(),
    digest: Type.String(),
    files: Type.Number(),
    bytes: Type.Number(),
    reusedFiles: Type.Number(),
    reusedBytes: Type.Number(),
    transferredBytes: Type.Number(),
    stateRecorded: Type.Boolean(),
    durationMs: Type.Number(),
    skipped: Type.Number(),
    skippedPaths: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const failureShape = {
  ok: Type.Literal(false),
  code: Type.String(),
  message: Type.String(),
  unknownOutcome: Type.Boolean(),
  pushId: Type.Optional(Type.String()),
  node: Type.Optional(Type.String()),
  nodeId: Type.Optional(Type.String()),
  remotePath: Type.Optional(Type.String()),
  localPath: Type.Optional(Type.String()),
  partial: Type.Optional(Type.Boolean()),
} as const;

const pushFailure = Type.Object(failureShape, { additionalProperties: false });
const pushDetails = Type.Union([pushSuccess, pushFailure]);

const artifactFailure = pushFailure;

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
        "Absolute destination file on the Gateway. Must be inside gateway.artifactRoots and must not exist; it is never overwritten.",
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
    remotePath: Type.String({ minLength: 1, description: "Absolute POSIX destination directory on the node." }),
  },
  { additionalProperties: false },
);

const markerSchema = Type.Object(
  {
    plugin: Type.Literal("node-workspace"),
    protocol: Type.Literal(1),
    pushId: Type.String(),
    digest: Type.String(),
    files: Type.Number(),
    bytes: Type.Number(),
    createdAt: Type.String(),
    state: Type.Union([Type.Literal("complete"), Type.Literal("incomplete"), Type.Literal("legacy")]),
    manifest: Type.Optional(
      Type.Array(
        Type.Object(
          {
            path: Type.String(),
            size: Type.Number(),
            sha256: Type.String(),
            executable: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    directories: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

const statusDetails = Type.Object(
  {
    ok: Type.Literal(true),
    nodeId: Type.String(),
    remotePath: Type.String(),
    exists: Type.Boolean(),
    parentExists: Type.Boolean(),
    owned: Type.Boolean(),
    complete: Type.Boolean(),
    verified: Type.Boolean(),
    drift: Type.Union([Type.String(), Type.Null()]),
    marker: Type.Union([markerSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

const changesParameters = Type.Object(
  {
    node: Type.String({ minLength: 1, description: "Paired node id or exact display name." }),
    remotePath: Type.String({
      minLength: 1,
      description: "Absolute directory on the node to compare and return. Must be inside node.returnRoots.",
    }),
    localPath: Type.String({
      minLength: 1,
      description: "Absolute local project directory to compare against. Must be inside gateway.returnRoots.",
    }),
    include: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { description: "Optional minimatch patterns to select node paths." }),
    ),
    exclude: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { description: "Optional minimatch patterns to omit on both sides." }),
    ),
  },
  { additionalProperties: false },
);

const returnParameters = Type.Object(
  {
    node: Type.String({ minLength: 1, description: "Paired node id or exact display name." }),
    remotePath: Type.String({ minLength: 1, description: "Absolute node directory. Must be inside node.returnRoots." }),
    localPath: Type.String({ minLength: 1, description: "Absolute local project directory. Must be inside gateway.returnRoots." }),
    planDigest: Type.String({
      minLength: 64,
      maxLength: 64,
      description: "The planDigest returned by node_workspace_changes. A changed plan is rejected.",
    }),
    include: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    exclude: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);

const returnPlanEntry = Type.Object(
  {
    kind: Type.Union([Type.Literal("add"), Type.Literal("modify"), Type.Literal("chmod")]),
    path: Type.String(),
    size: Type.Number(),
    sha256: Type.String(),
    executable: Type.Boolean(),
    baseSha256: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const returnConflictEntry = Type.Object(
  {
    path: Type.String(),
    reason: Type.String(),
    localSha256: Type.Optional(Type.String()),
    baseSha256: Type.Optional(Type.String()),
    nodeSha256: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const changesDetails = Type.Object(
  {
    ok: Type.Literal(true),
    nodeId: Type.String(),
    remotePath: Type.String(),
    localPath: Type.String(),
    treeDigest: Type.String(),
    planDigest: Type.String(),
    nodeOwned: Type.Boolean(),
    nodeVerified: Type.Boolean(),
    drift: Type.Union([Type.String(), Type.Null()]),
    counts: Type.Object(
      {
        additions: Type.Number(),
        modifications: Type.Number(),
        modeChanges: Type.Number(),
        unchanged: Type.Number(),
        conflicts: Type.Number(),
        nodeRemoved: Type.Number(),
      },
      { additionalProperties: false },
    ),
    operations: Type.Array(returnPlanEntry),
    conflicts: Type.Array(returnConflictEntry),
    nodeRemoved: Type.Array(Type.String()),
    directories: Type.Array(Type.String()),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

const returnDetails = Type.Object(
  {
    ok: Type.Literal(true),
    nodeId: Type.String(),
    localPath: Type.String(),
    treeDigest: Type.String(),
    planDigest: Type.String(),
    applied: Type.Array(
      Type.Object(
        { path: Type.String(), kind: Type.Union([Type.Literal("add"), Type.Literal("modify"), Type.Literal("chmod")]) },
        { additionalProperties: false },
      ),
    ),
    unchanged: Type.Number(),
    removedOnNode: Type.Array(Type.String()),
    bytesTransferred: Type.Number(),
    stateRecorded: Type.Boolean(),
    durationMs: Type.Number(),
  },
  { additionalProperties: false },
);

const MAX_REPORTED_PATHS = MAX_RETURN_OPERATIONS;

export function createTools(deps: ToolDependencies): AnyAgentTool[] {
  // Deliberately absolute-path only: a relative path would silently depend on
  // whichever workspace the agent happens to run in.
  return [
    {
      name: "node_workspace_push",
      label: "Publish a workspace to a node",
      description:
        "Publish one explicitly selected local directory to a paired node over the OpenClaw node channel. " +
        "This is one-way (Gateway to node), verifies every file by SHA-256, and claims a new destination with mkdir(2) before writing. " +
        "It does not run commands: the result returns the node id and remote cwd so you can invoke the native exec tool with host=node yourself. " +
        "The destination must be new. With incrementalFrom, unchanged files are copied on the node from a previously published generation, so only changed bytes cross the channel; the base is never modified. An existing directory with the same content is reported as already-applied only after its bytes are re-verified; a different directory is a conflict and is never replaced.",
      parameters: pushParameters,
      outputSchema: pushDetails,
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: (update: AgentUpdate) => void) {
        let context: { node?: string; remotePath?: string; localPath?: string } = {};
        const transferId = randomUUID();
        const scope = deps.scope;
        const tracked = scope && deps.progress ? { scope, store: deps.progress } : undefined;
        let settled = false;
        try {
          const config = requireConfig(deps);
          const input = parsePushParams(params);
          context = { node: input.node, remotePath: input.remotePath, localPath: input.localPath };
          tracked?.store.begin(tracked.scope, transferId, "push");
          const outcome = await pushWorkspace(deps.transport, config, {
            node: input.node,
            localPath: input.localPath,
            remotePath: input.remotePath,
            incrementalFrom: input.incrementalFrom,
            exclude: input.exclude,
            signal,
            progress: (progress) => {
              tracked?.store.updateFromPush(tracked.scope, transferId, progress);
              deps.onProgressChange?.();
              onUpdate?.({
                content: [{ type: "text", text: progressText(progress) }],
                details: { phase: progress.phase },
                progress: {
                  text: progressText(progress),
                  visibility: "channel",
                  privacy: "public",
                  id: "node-workspace-push",
                },
              });
            },
          });
          tracked?.store.finish(tracked.scope, transferId, "completed");
          settled = true;
          deps.onProgressChange?.(true);
          const mib = (outcome.bytes / (1024 * 1024)).toFixed(2);
          const verb = outcome.status === "already-applied" ? "already present" : "published";
          // Without the reuse counts a caller cannot tell whether the incremental
          // path did anything: the totals look the same as a full copy.
          const reuseNote =
            outcome.reusedFiles === 0
              ? ""
              : ` ${outcome.reusedFiles} file(s) reused from the base (${(outcome.reusedBytes / (1024 * 1024)).toFixed(2)} MiB), ${(outcome.transferredBytes / (1024 * 1024)).toFixed(2)} MiB transferred. `;
          const skippedNote =
            outcome.skipped.length === 0
              ? ""
              : ` ${outcome.skipped.length} entries were skipped (symlink or exclude rule); see details.skippedPaths.`;
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `${verb}: ${outcome.files} files (${mib} MiB) at ${outcome.cwd} on node ${outcome.nodeId}. ` +
                  `sha256 tree digest ${outcome.digest}. ` +
                  reuseNote +
                  `One-way copy; later Gateway changes are not synchronized. ` +
                  (outcome.stateRecorded ? "A local return baseline was recorded." : "No local return baseline was recorded; the first return may report conflicts.") +
                  skippedNote +
                  ` ` +
                  `Run commands there with the exec tool: host=node, node=${outcome.nodeId}, workdir=${outcome.cwd}.`,
              },
            ],
            details: {
              ok: true as const,
              status: outcome.status,
              nodeId: outcome.nodeId,
              cwd: outcome.cwd,
              pushId: outcome.pushId,
              digest: outcome.digest,
              files: outcome.files,
              bytes: outcome.bytes,
              reusedFiles: outcome.reusedFiles,
              reusedBytes: outcome.reusedBytes,
              transferredBytes: outcome.transferredBytes,
              stateRecorded: outcome.stateRecorded,
              durationMs: outcome.durationMs,
              skipped: outcome.skipped.length,
              skippedPaths: outcome.skipped.map((entry) => entry.path),
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
            tracked?.store.finish(tracked.scope, transferId, state);
            deps.onProgressChange?.(true);
          }
          return toolFailure("node_workspace_push", error, context);
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
      outputSchema: Type.Union([artifactDetails, artifactFailure]),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: (update: AgentUpdate) => void) {
        let context: { node?: string; remotePath?: string; localPath?: string } = {};
        const transferId = randomUUID();
        const scope = deps.scope;
        const tracked = scope && deps.progress ? { scope, store: deps.progress } : undefined;
        let settled = false;
        try {
          const config = requireConfig(deps);
          const input = parseArtifactParams(params);
          context = { node: input.node, remotePath: input.remotePath, localPath: input.localPath };
          tracked?.store.begin(tracked.scope, transferId, "fetch");
          const outcome = await fetchArtifact(deps.transport, config, {
            node: input.node,
            remotePath: input.remotePath,
            localPath: input.localPath,
            signal,
            progress: (bytesDone, bytesTotal) => {
              tracked?.store.updateFetch(tracked.scope, transferId, bytesDone, bytesTotal);
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
          tracked?.store.finish(tracked.scope, transferId, "completed");
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
            tracked?.store.finish(tracked.scope, transferId, state);
            deps.onProgressChange?.(true);
          }
          return toolFailure("node_workspace_artifact", error, context);
        }
      },
    },
    {
      name: "node_workspace_status",
      label: "Inspect a node workspace copy",
      description:
        "Read-only: report whether a node destination exists and whether it was published by this plugin, including its push id and tree digest. " +
        "Use this after an unknown outcome before retrying anything.",
      parameters: statusParameters,
      outputSchema: Type.Union([statusDetails, artifactFailure]),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        let context: { node?: string; remotePath?: string; localPath?: string } = {};
        try {
          const config = requireConfig(deps);
          const input = parseStatusParams(params);
          context = { node: input.node, remotePath: input.remotePath };
          const outcome: StatusOutcome = await workspaceStatus(deps.transport, config, {
            node: input.node,
            remotePath: input.remotePath,
            signal,
          });
          const text = !outcome.exists
            ? `${outcome.remotePath} does not exist on node ${outcome.nodeId}.`
            : outcome.owned && outcome.verified
              ? `${outcome.remotePath} is owned by this plugin and its bytes still match the published manifest (push ${outcome.marker?.pushId}, digest ${outcome.marker?.digest}).`
              : outcome.owned
                ? `${outcome.remotePath} has a marker but the content no longer matches: ${outcome.drift ?? "verification failed"}.`
                : `${outcome.remotePath} exists but has no node-workspace marker; this plugin did not publish it.`;
          return {
            content: [{ type: "text" as const, text }],
            details: {
              ok: true as const,
              nodeId: outcome.nodeId,
              remotePath: outcome.remotePath,
              exists: outcome.exists,
              parentExists: outcome.parentExists,
              owned: outcome.owned,
              complete: outcome.complete,
              verified: outcome.verified,
              drift: outcome.drift,
              marker: outcome.marker,
            },
          };
        } catch (error) {
          return toolFailure("node_workspace_status", error, context);
        }
      },
    },
    {
      name: "node_workspace_changes",
      label: "Preview a project tree return from a node",
      description:
        "Read-only preview of the files a paired node generated or changed in one directory, compared with a local project directory. " +
        "Reports additions, safe modifications, mode changes, unchanged files, conflicts, and paths removed on the node. " +
        "It never writes, overwrites, or deletes anything. Pass the returned planDigest to node_workspace_return to apply exactly this plan.",
      parameters: changesParameters,
      outputSchema: Type.Union([changesDetails, artifactFailure]),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        let context: { node?: string; remotePath?: string; localPath?: string } = {};
        try {
          const config = requireConfig(deps);
          const input = parseReturnParams(params, false);
          context = { node: input.node, remotePath: input.remotePath, localPath: input.localPath };
          const preview = await previewReturn(deps.transport, config, {
            node: input.node,
            remotePath: input.remotePath,
            localPath: input.localPath,
            include: input.include,
            exclude: input.exclude,
            signal,
          });
          const plan = preview.plan;
          const operations = plan.operations.slice(0, MAX_REPORTED_PATHS).map((entry) => ({
            kind: entry.kind,
            path: entry.path,
            size: entry.size,
            sha256: entry.sha256,
            executable: entry.executable,
            ...(entry.baseSha256 ? { baseSha256: entry.baseSha256 } : {}),
          }));
          const conflicts = plan.conflicts.slice(0, MAX_REPORTED_PATHS).map((entry) => ({
            path: entry.path,
            reason: entry.reason,
            ...(entry.localSha256 ? { localSha256: entry.localSha256 } : {}),
            ...(entry.baseSha256 ? { baseSha256: entry.baseSha256 } : {}),
            ...(entry.nodeSha256 ? { nodeSha256: entry.nodeSha256 } : {}),
          }));
          const truncated =
            plan.operations.length > MAX_REPORTED_PATHS ||
            plan.conflicts.length > MAX_REPORTED_PATHS ||
            plan.nodeRemoved.length > MAX_REPORTED_PATHS;
          const counts = plan.counts;
          const summary =
            `${counts.additions} addition(s), ${counts.modifications} modification(s), ${counts.modeChanges} mode change(s), ` +
            `${counts.unchanged} unchanged, ${counts.conflicts} conflict(s), ${counts.nodeRemoved} path(s) removed on the node.`;
          const conflictText =
            counts.conflicts === 0
              ? "No conflicts."
              : ` Conflicts: ${plan.conflicts
                  .slice(0, 20)
                  .map((entry) => `${entry.path} (${entry.reason})`)
                  .join(", ")}${plan.conflicts.length > 20 ? ", …" : ""}. Resolve them before applying.`;
          const removedText =
            counts.nodeRemoved === 0
              ? ""
              : " Paths removed on the node are reported and never deleted locally.";
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Preview returning ${plan.remotePath} on node ${plan.nodeId} into ${plan.localPath}: ${summary}` +
                  conflictText +
                  removedText +
                  ` planDigest ${plan.planDigest}. Apply with node_workspace_return and this digest; a changed plan is rejected.`,
              },
            ],
            details: {
              ok: true as const,
              nodeId: plan.nodeId,
              remotePath: plan.remotePath,
              localPath: plan.localPath,
              treeDigest: plan.treeDigest,
              planDigest: plan.planDigest,
              nodeOwned: preview.tree.owned,
              nodeVerified: preview.tree.verified,
              drift: preview.tree.drift,
              counts,
              operations,
              conflicts,
              nodeRemoved: plan.nodeRemoved.slice(0, MAX_REPORTED_PATHS).map((entry) => entry.path),
              directories: plan.directories.slice(0, MAX_REPORTED_PATHS),
              truncated,
            },
          };
        } catch (error) {
          return toolFailure("node_workspace_changes", error, context);
        }
      },
    },
    {
      name: "node_workspace_return",
      label: "Return changed project files from a node",
      description:
        "Apply one previewed node_workspace_changes plan to the local project directory. " +
        "The planDigest must match a fresh preview exactly; conflicts, a changed node tree, or a locally modified file abort the call before anything is written. " +
        "Files are staged and verified over the node channel first, then applied with an exclusive create for additions and a re-checked atomic replace for safe modifications. " +
        "Files removed on the node are reported and never deleted locally. Modes are owner-only (0600 or 0700).",
      parameters: returnParameters,
      outputSchema: Type.Union([returnDetails, artifactFailure]),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: (update: AgentUpdate) => void) {
        let context: { node?: string; remotePath?: string; localPath?: string } = {};
        const transferId = randomUUID();
        const scope = deps.scope;
        const tracked = scope && deps.progress ? { scope, store: deps.progress } : undefined;
        let settled = false;
        try {
          const config = requireConfig(deps);
          const input = parseReturnParams(params, true);
          if (input.planDigest === undefined) {
            throw new NodeWorkspaceError("path-invalid", "planDigest is required");
          }
          context = { node: input.node, remotePath: input.remotePath, localPath: input.localPath };
          tracked?.store.begin(tracked.scope, transferId, "return");
          const outcome = await applyReturn(deps.transport, config, {
            node: input.node,
            remotePath: input.remotePath,
            localPath: input.localPath,
            include: input.include,
            exclude: input.exclude,
            planDigest: input.planDigest,
            signal,
            progress: (progress: ReturnProgress) => {
              tracked?.store.updateReturn(tracked.scope, transferId, progress);
              deps.onProgressChange?.();
              if (onUpdate) {
                const files =
                  progress.filesTotal === 0 ? "preparing" : `${progress.filesDone}/${progress.filesTotal} files`;
                const text = `Node workspace return ${progress.phase}: ${files}`;
                onUpdate({
                  content: [{ type: "text", text }],
                  details: { phase: progress.phase },
                  progress: {
                    text,
                    visibility: "channel",
                    privacy: "public",
                    id: "node-workspace-return",
                  },
                });
              }
            },
          });
          tracked?.store.finish(tracked.scope, transferId, "completed");
          settled = true;
          deps.onProgressChange?.(true);
          const additions = outcome.applied.filter((entry) => entry.kind === "add").length;
          const modifications = outcome.applied.filter((entry) => entry.kind === "modify").length;
          const modes = outcome.applied.filter((entry) => entry.kind === "chmod").length;
          const removedText =
            outcome.removedOnNode.length === 0
              ? ""
              : ` ${outcome.removedOnNode.length} path(s) were removed on the node and were not deleted locally.`;
          const stateText = outcome.stateRecorded
            ? ""
            : " The local return baseline could not be recorded; the next preview may report a conflict.";
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Returned into ${outcome.localPath}: ${additions} added, ${modifications} modified, ${modes} mode change(s); ` +
                  `${outcome.unchanged} unchanged, ${outcome.bytesTransferred} bytes transferred.` +
                  removedText +
                  stateText +
                  ` planDigest ${outcome.planDigest}.`,
              },
            ],
            details: {
              ok: true as const,
              nodeId: outcome.nodeId,
              localPath: outcome.localPath,
              treeDigest: outcome.treeDigest,
              planDigest: outcome.planDigest,
              applied: outcome.applied,
              unchanged: outcome.unchanged,
              removedOnNode: outcome.removedOnNode,
              bytesTransferred: outcome.bytesTransferred,
              stateRecorded: outcome.stateRecorded,
              durationMs: outcome.durationMs,
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
            tracked?.store.finish(tracked.scope, transferId, state);
            deps.onProgressChange?.(true);
          }
          return toolFailure("node_workspace_return", error, context);
        }
      },
    },
  ];
}

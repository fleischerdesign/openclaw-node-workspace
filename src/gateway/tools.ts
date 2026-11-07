import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";

import type { GatewayConfig } from "../config.js";
import { NodeWorkspaceError } from "../errors.js";
import type { NodeTransport } from "../transport.js";
import { fetchArtifact } from "./artifact.js";
import { pushWorkspace, type PushProgress } from "./push.js";
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
  readonly exclude: readonly string[] | undefined;
}

function parsePushParams(value: unknown): PushParams {
  const record = requireRecord(value, "push parameters");
  const excludeValue = record.exclude;
  let exclude: string[] | undefined;
  if (excludeValue !== undefined) {
    if (!Array.isArray(excludeValue) || excludeValue.length > 200) {
      throw new NodeWorkspaceError("path-invalid", "exclude must be an array of at most 200 patterns");
    }
    exclude = excludeValue.map((entry, index) => {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > 1024) {
        throw new NodeWorkspaceError("path-invalid", `exclude[${index}] must be a non-empty string`);
      }
      return entry;
    });
  }
  return {
    node: requireField(record, "node", 256),
    localPath: requireField(record, "localPath", 4096),
    remotePath: requireField(record, "remotePath", 4096),
    exclude,
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
        "The destination must be new. An existing directory with the same content is reported as already-applied only after its bytes are re-verified; a different directory is a conflict and is never replaced.",
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
                  `One-way copy; later Gateway changes are not synchronized.` +
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
  ];
}

import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";

import type { GatewayConfig } from "../config.js";
import { NodeWorkspaceError, errorMessage } from "../errors.js";
import type { NodeTransport } from "../transport.js";
import { fetchArtifact } from "./artifact.js";
import { pushWorkspace, type PushProgress } from "./push.js";
import { workspaceStatus, type StatusOutcome } from "./status.js";

export interface ToolDependencies {
  readonly transport: NodeTransport;
  readonly config: GatewayConfig | undefined;
  readonly configError: string | undefined;
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

export function formatToolError(error: unknown): string {
  if (error instanceof NodeWorkspaceError) {
    if (error.code === "unknown-outcome") return `UNKNOWN OUTCOME — do not retry blindly. ${error.message}`;
    return `${error.code}: ${error.message}`;
  }
  return errorMessage(error);
}

function progressText(progress: PushProgress): string {
  const total = progress.filesTotal;
  const files = total === 0 ? "scanning" : `${progress.filesDone}/${total} files`;
  const mib = (progress.bytesDone / (1024 * 1024)).toFixed(1);
  return `Node workspace ${progress.phase}: ${files}, ${mib} MiB`;
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
        "Absolute POSIX destination directory on the node. Must be a new path, or a directory this plugin previously published when replace=true.",
    }),
    replace: Type.Optional(
      Type.Boolean({
        description:
          "Replace the destination only when it carries this plugin's marker. Defaults to false and never clobbers a foreign directory.",
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

const pushDetails = Type.Object(
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
    replaced: Type.Boolean(),
  },
  { additionalProperties: false },
);

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
        "This is one-way (Gateway to node), verifies every file by SHA-256, and publishes atomically. " +
        "It does not run commands: the result returns the node id and remote cwd so you can invoke the native exec tool with host=node yourself. " +
        "The destination must be new, or a directory this plugin previously published when replace=true.",
      parameters: pushParameters,
      outputSchema: pushDetails,
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: (update: AgentUpdate) => void) {
        const config = requireConfig(deps);
        const input = params as {
          node: string;
          localPath: string;
          remotePath: string;
          replace?: boolean;
          exclude?: string[];
        };
        try {
          const outcome = await pushWorkspace(deps.transport, config, {
            node: input.node,
            localPath: input.localPath,
            remotePath: input.remotePath,
            replace: input.replace === true,
            exclude: input.exclude,
            signal,
            progress: onUpdate
              ? (progress) =>
                  onUpdate({
                    content: [{ type: "text", text: progressText(progress) }],
                    details: { phase: progress.phase },
                    progress: {
                      text: progressText(progress),
                      visibility: "channel",
                      privacy: "public",
                      id: "node-workspace-push",
                    },
                  })
              : undefined,
          });
          const mib = (outcome.bytes / (1024 * 1024)).toFixed(2);
          const verb = outcome.status === "already-applied" ? "already present" : "published";
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `${verb}: ${outcome.files} files (${mib} MiB) at ${outcome.cwd} on node ${outcome.nodeId}. ` +
                  `sha256 tree digest ${outcome.digest}${outcome.replaced ? " (replaced the previous plugin-owned copy)" : ""}. ` +
                  `One-way copy; later Gateway changes are not synchronized. ` +
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
              skipped: outcome.skipped,
              replaced: outcome.replaced,
            },
          };
        } catch (error) {
          throw new Error(formatToolError(error), { cause: error });
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
      outputSchema: artifactDetails,
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: (update: AgentUpdate) => void) {
        const config = requireConfig(deps);
        const input = params as { node: string; remotePath: string; localPath: string };
        try {
          const outcome = await fetchArtifact(deps.transport, config, {
            node: input.node,
            remotePath: input.remotePath,
            localPath: input.localPath,
            signal,
            progress: onUpdate
              ? (bytesDone, bytesTotal) => {
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
              : undefined,
          });
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
          throw new Error(formatToolError(error), { cause: error });
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
      outputSchema: statusDetails,
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        const config = requireConfig(deps);
        const input = params as { node: string; remotePath: string };
        try {
          const outcome: StatusOutcome = await workspaceStatus(deps.transport, config, {
            node: input.node,
            remotePath: input.remotePath,
            signal,
          });
          const text = !outcome.exists
            ? `${outcome.remotePath} does not exist on node ${outcome.nodeId}.`
            : outcome.owned
              ? `${outcome.remotePath} is owned by this plugin (push ${outcome.marker?.pushId}, digest ${outcome.marker?.digest}).`
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
              marker: outcome.marker,
            },
          };
        } catch (error) {
          throw new Error(formatToolError(error), { cause: error });
        }
      },
    },
  ];
}

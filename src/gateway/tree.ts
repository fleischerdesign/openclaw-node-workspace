import type { GatewayConfig } from "../config.js";
import type { ManifestEntry } from "../digest.js";
import { NodeWorkspaceError, errorMessage } from "../errors.js";
import { normalizeAbsolutePosixPath } from "../paths.js";
import { parseManifestEntry, COMMAND_TREE } from "../protocol.js";
import { resolveNodeId, type NodeTransport } from "../transport.js";
import type { Marker } from "../node/fs-atomic.js";

export interface NodeTreeOutcome {
  readonly nodeId: string;
  readonly remotePath: string;
  readonly directory: string;
  readonly files: readonly ManifestEntry[];
  readonly directories: readonly string[];
  readonly totalBytes: number;
  readonly treeDigest: string;
  readonly owned: boolean;
  readonly complete: boolean;
  readonly verified: boolean;
  readonly drift: string | null;
  readonly marker: Marker | null;
}

function parseEnvelope(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new NodeWorkspaceError("protocol", "node tree response is not valid JSON");
    }
  }
  if (typeof raw === "object" && raw !== null) {
    const envelope = raw as Record<string, unknown>;
    for (const key of ["payloadJSON", "payload"] as const) {
      const value = envelope[key];
      if (typeof value === "string") {
        try {
          return JSON.parse(value) as Record<string, unknown>;
        } catch {
          throw new NodeWorkspaceError("protocol", `node tree ${key} is not valid JSON`);
        }
      }
      if (typeof value === "object" && value !== null && key === "payload") {
        return value as Record<string, unknown>;
      }
    }
    return envelope;
  }
  throw new NodeWorkspaceError("protocol", "node tree response has an unexpected shape");
}

/** Read the node's independent manifest of one directory. Read-only. */
export async function readNodeTree(
  transport: NodeTransport,
  config: GatewayConfig,
  input: { node: string; remotePath: string; signal?: AbortSignal | undefined },
): Promise<NodeTreeOutcome> {
  const nodeId = await resolveNodeId(transport, input.node);
  const remotePath = normalizeAbsolutePosixPath(input.remotePath);
  let raw: unknown;
  try {
    raw = await transport.invoke({
      nodeId,
      command: COMMAND_TREE,
      params: { remotePath },
      timeoutMs: config.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    if (error instanceof NodeWorkspaceError) throw error;
    throw new NodeWorkspaceError("transport", `tree request failed: ${errorMessage(error)}`, {}, { cause: error });
  }
  const value = parseEnvelope(raw);
  if (!Array.isArray(value.files) || !Array.isArray(value.directories)) {
    throw new NodeWorkspaceError("protocol", "node tree response is missing its manifest");
  }
  const files = value.files.map(parseManifestEntry);
  const directories: string[] = [];
  for (const entry of value.directories) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new NodeWorkspaceError("protocol", "node tree response has an invalid directory entry");
    }
    directories.push(entry);
  }
  if (typeof value.treeDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.treeDigest)) {
    throw new NodeWorkspaceError("protocol", "node tree response is missing a valid treeDigest");
  }
  if (typeof value.totalBytes !== "number" || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0) {
    throw new NodeWorkspaceError("protocol", "node tree response has an invalid totalBytes");
  }
  if (typeof value.directory !== "string") {
    throw new NodeWorkspaceError("protocol", "node tree response is missing its directory");
  }
  return {
    nodeId,
    remotePath,
    directory: value.directory,
    files,
    directories,
    totalBytes: value.totalBytes,
    treeDigest: value.treeDigest,
    owned: value.owned === true,
    complete: value.complete === true,
    verified: value.verified === true,
    drift: typeof value.drift === "string" ? value.drift : null,
    marker: (value.marker as Marker | null | undefined) ?? null,
  };
}

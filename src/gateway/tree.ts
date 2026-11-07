import type { GatewayConfig } from "../config.js";
import { treeDigest, type ManifestEntry } from "../digest.js";
import { NodeWorkspaceError, errorMessage } from "../errors.js";
import { assertSafeRelativePath, normalizeAbsolutePosixPath } from "../paths.js";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A malformed or foreign marker is ignored; it is never trusted as a base. */
function parseMarker(value: unknown): Marker | null {
  if (!isRecord(value)) return null;
  if (value.plugin !== "node-workspace" || value.protocol !== 1) return null;
  if (
    typeof value.pushId !== "string" ||
    typeof value.digest !== "string" ||
    typeof value.files !== "number" ||
    typeof value.bytes !== "number" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  const state = value.state;
  if (state !== "complete" && state !== "incomplete" && state !== "legacy") return null;
  let manifest: ManifestEntry[] | undefined;
  if (value.manifest !== undefined) {
    if (!Array.isArray(value.manifest)) return null;
    try {
      manifest = value.manifest.map((entry) => {
        const parsed = parseManifestEntry(entry);
        assertSafeRelativePath(parsed.path, "marker manifest path");
        return parsed;
      });
    } catch {
      return null;
    }
  }
  let directories: string[] | undefined;
  if (value.directories !== undefined) {
    if (!Array.isArray(value.directories)) return null;
    try {
      directories = value.directories.map((entry) => {
        if (typeof entry !== "string" || entry.length === 0) throw new Error("invalid directory");
        assertSafeRelativePath(entry, "marker directory path");
        return entry;
      });
    } catch {
      return null;
    }
  }
  return {
    plugin: "node-workspace",
    protocol: 1,
    pushId: value.pushId,
    digest: value.digest,
    files: value.files,
    bytes: value.bytes,
    createdAt: value.createdAt,
    state,
    ...(manifest !== undefined ? { manifest } : {}),
    ...(directories !== undefined ? { directories } : {}),
  };
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
  input: {
    node: string;
    remotePath: string;
    exclude?: readonly string[] | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<NodeTreeOutcome> {
  const nodeId = await resolveNodeId(transport, input.node);
  const remotePath = normalizeAbsolutePosixPath(input.remotePath);
  let raw: unknown;
  try {
    raw = await transport.invoke({
      nodeId,
      command: COMMAND_TREE,
      params: { remotePath, ...(input.exclude ? { exclude: [...input.exclude] } : {}) },
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
  for (const entry of files) assertSafeRelativePath(entry.path, "node tree file");
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.directories) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new NodeWorkspaceError("protocol", "node tree response has an invalid directory entry");
    }
    assertSafeRelativePath(entry, "node tree directory");
    if (seen.has(entry)) throw new NodeWorkspaceError("protocol", `node tree repeats ${entry}`);
    seen.add(entry);
    directories.push(entry);
  }
  for (const directory of directories) {
    const segments = directory.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      if (!seen.has(parent)) {
        throw new NodeWorkspaceError("protocol", `node tree is missing directory ${parent} for ${directory}`);
      }
    }
  }
  const filePaths = new Set<string>();
  let summedBytes = 0;
  for (const entry of files) {
    if (filePaths.has(entry.path)) throw new NodeWorkspaceError("protocol", `node tree repeats ${entry.path}`);
    if (seen.has(entry.path)) {
      throw new NodeWorkspaceError("protocol", `node tree uses ${entry.path} as both file and directory`);
    }
    filePaths.add(entry.path);
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      if (!seen.has(parent)) {
        throw new NodeWorkspaceError("protocol", `node tree is missing directory ${parent} for ${entry.path}`);
      }
    }
    summedBytes += entry.size;
  }
  if (typeof value.treeDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.treeDigest)) {
    throw new NodeWorkspaceError("protocol", "node tree response is missing a valid treeDigest");
  }
  if (typeof value.totalBytes !== "number" || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0) {
    throw new NodeWorkspaceError("protocol", "node tree response has an invalid totalBytes");
  }
  if (value.totalBytes !== summedBytes) {
    throw new NodeWorkspaceError("protocol", "node tree totalBytes does not match its manifest");
  }
  const recomputed = treeDigest({ version: 1, files, directories });
  if (recomputed !== value.treeDigest) {
    throw new NodeWorkspaceError("integrity", "node tree digest does not match its manifest");
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
    marker: parseMarker(value.marker),
  };
}

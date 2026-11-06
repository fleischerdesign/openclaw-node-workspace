import path from "node:path";

import { NodeWorkspaceError } from "./errors.js";

export type SymlinkPolicy = "reject" | "skip";

export interface GatewayConfig {
  /** Absolute directories a push may read from. Empty denies every push. */
  readonly localRoots: readonly string[];
  /** Absolute directories an artifact may be written into. Empty denies every fetch. */
  readonly artifactRoots: readonly string[];
  readonly exclude: readonly string[];
  readonly symlinks: SymlinkPolicy;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxArtifactBytes: number;
  readonly chunkBytes: number;
  readonly timeoutMs: number;
}

export interface NodeConfig {
  /** Absolute directories a push may create children in. Empty denies every push. */
  readonly pushRoots: readonly string[];
  /** Absolute directories an artifact may be read from. Empty denies every fetch. */
  readonly artifactRoots: readonly string[];
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxArtifactBytes: number;
}

export interface PluginConfig {
  readonly gateway: GatewayConfig;
  readonly node: NodeConfig;
}

const DEFAULTS = {
  maxFiles: 2000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxArtifactBytes: 32 * 1024 * 1024,
  chunkBytes: 64 * 1024,
  timeoutMs: 120_000,
} as const;

const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

function fail(message: string): never {
  throw new NodeWorkspaceError("config-invalid", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${label} must be an array of strings`);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) fail(`${label}[${index}] must be a non-empty string`);
    return entry;
  });
}

function absoluteRoots(value: unknown, label: string): string[] {
  const resolved = stringArray(value, label).map((entry, index) => {
    if (!path.isAbsolute(entry)) fail(`${label}[${index}] must be an absolute path, got ${JSON.stringify(entry)}`);
    if (entry.includes("\0")) fail(`${label}[${index}] must not contain a NUL byte`);
    return path.resolve(entry);
  });
  return [...new Set(resolved)];
}

function positiveInteger(value: unknown, label: string, fallback: number, maximum?: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer`);
  }
  if (maximum !== undefined && value > maximum) fail(`${label} must not exceed ${maximum}`);
  return value;
}

/**
 * Read the plugin configuration defensively.
 *
 * The host validates the manifest schema, but a node and a Gateway may run
 * different plugin versions, so each side revalidates what it uses. Invalid
 * configuration fails closed: no root means no access, never the working
 * directory.
 */
export function resolvePluginConfig(raw: unknown): PluginConfig {
  const root = record(raw, "plugin config");
  const gateway = record(root.gateway, "gateway");
  const node = record(root.node, "node");

  const symlinksRaw = gateway.symlinks ?? "reject";
  if (symlinksRaw !== "reject" && symlinksRaw !== "skip") {
    fail('gateway.symlinks must be "reject" or "skip"');
  }

  const maxFiles = positiveInteger(gateway.maxFiles, "gateway.maxFiles", DEFAULTS.maxFiles);
  const maxFileBytes = positiveInteger(gateway.maxFileBytes, "gateway.maxFileBytes", DEFAULTS.maxFileBytes);
  const maxTotalBytes = positiveInteger(gateway.maxTotalBytes, "gateway.maxTotalBytes", DEFAULTS.maxTotalBytes);
  const nodeMaxFiles = positiveInteger(node.maxFiles, "node.maxFiles", DEFAULTS.maxFiles);
  const nodeMaxFileBytes = positiveInteger(node.maxFileBytes, "node.maxFileBytes", DEFAULTS.maxFileBytes);
  const nodeMaxTotalBytes = positiveInteger(node.maxTotalBytes, "node.maxTotalBytes", DEFAULTS.maxTotalBytes);

  if (maxFileBytes > maxTotalBytes) fail("gateway.maxFileBytes must not exceed gateway.maxTotalBytes");
  if (nodeMaxFileBytes > nodeMaxTotalBytes) fail("node.maxFileBytes must not exceed node.maxTotalBytes");

  return {
    gateway: {
      localRoots: absoluteRoots(gateway.localRoots, "gateway.localRoots"),
      artifactRoots: absoluteRoots(gateway.artifactRoots, "gateway.artifactRoots"),
      exclude: stringArray(gateway.exclude, "gateway.exclude"),
      symlinks: symlinksRaw,
      maxFiles,
      maxFileBytes,
      maxTotalBytes,
      maxArtifactBytes: positiveInteger(
        gateway.maxArtifactBytes,
        "gateway.maxArtifactBytes",
        DEFAULTS.maxArtifactBytes,
      ),
      chunkBytes: positiveInteger(gateway.chunkBytes, "gateway.chunkBytes", DEFAULTS.chunkBytes, MAX_CHUNK_BYTES),
      timeoutMs: positiveInteger(gateway.timeoutMs, "gateway.timeoutMs", DEFAULTS.timeoutMs, MAX_TIMEOUT_MS),
    },
    node: {
      pushRoots: absoluteRoots(node.pushRoots, "node.pushRoots"),
      artifactRoots: absoluteRoots(node.artifactRoots, "node.artifactRoots"),
      maxFiles: nodeMaxFiles,
      maxFileBytes: nodeMaxFileBytes,
      maxTotalBytes: nodeMaxTotalBytes,
      maxArtifactBytes: positiveInteger(
        node.maxArtifactBytes,
        "node.maxArtifactBytes",
        DEFAULTS.maxArtifactBytes,
      ),
    },
  };
}

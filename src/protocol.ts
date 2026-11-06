import type { ManifestEntry } from "./digest.js";
import { NodeWorkspaceError } from "./errors.js";

export const PROTOCOL_VERSION = 2;
export const COMMAND_PUSH = "nodews.push";
export const COMMAND_FETCH = "nodews.fetch";
export const COMMAND_STATUS = "nodews.status";

export interface PushHello {
  readonly t: "hello";
  readonly protocol: 2;
  readonly pushId: string;
  readonly remotePath: string;
  readonly totalBytes: number;
  readonly treeDigest: string;
  readonly manifest: readonly ManifestEntry[];
  readonly directories: readonly string[];
}

export interface FetchRequest {
  readonly remotePath: string;
  readonly maxBytes: number;
}

export type GatewayControl = PushHello | { readonly t: "file"; readonly path: string } | { readonly t: "end" };

export type NodeControl =
  | { readonly t: "accepted"; readonly pushId: string }
  | { readonly t: "rejected"; readonly code: string; readonly message: string }
  | { readonly t: "progress"; readonly phase: string; readonly filesDone: number; readonly bytesDone: number }
  | { readonly t: "file-ok"; readonly path: string; readonly bytes: number; readonly sha256: string }
  | { readonly t: "file-error"; readonly path: string; readonly code: string; readonly message: string }
  | {
      readonly t: "result";
      readonly ok: true;
      readonly pushId: string;
      readonly digest: string;
      readonly files: number;
      readonly bytes: number;
    }
  | {
      readonly t: "result";
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly published: boolean;
    }
  | { readonly t: "meta"; readonly size: number; readonly sha256: string | null; readonly mode: number }
  | { readonly t: "done"; readonly sha256: string; readonly bytes: number }
  | { readonly t: "fetch-error"; readonly code: string; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new NodeWorkspaceError("protocol", `${label} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new NodeWorkspaceError("protocol", `${label} must be a boolean`);
  return value;
}

function requireSafeInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new NodeWorkspaceError("protocol", `${label} must be an integer >= ${minimum}`);
  }
  return value;
}

export function parseManifestEntry(value: unknown): ManifestEntry {
  if (!isRecord(value)) throw new NodeWorkspaceError("protocol", "manifest entry must be an object");
  const path = requireString(value.path, "manifest entry path");
  const size = requireSafeInteger(value.size, "manifest entry size");
  const sha256 = requireString(value.sha256, "manifest entry sha256");
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new NodeWorkspaceError("protocol", `manifest entry sha256 is not lowercase hex: ${path}`);
  }
  return {
    path,
    size,
    sha256,
    executable: requireBoolean(value.executable, "manifest entry executable"),
  };
}

export function parsePushHello(value: unknown): PushHello {
  if (!isRecord(value) || value.t !== "hello") throw new NodeWorkspaceError("protocol", "expected a hello control frame");
  if (value.protocol !== PROTOCOL_VERSION) {
    throw new NodeWorkspaceError("protocol", `unsupported protocol version ${String(value.protocol)}`);
  }
  if (!Array.isArray(value.manifest)) throw new NodeWorkspaceError("protocol", "hello.manifest must be an array");
  if (!Array.isArray(value.directories)) {
    throw new NodeWorkspaceError("protocol", "hello.directories must be an array");
  }
  for (const entry of value.directories) {
    requireString(entry, "hello.directories entry");
  }
  return {
    t: "hello",
    protocol: PROTOCOL_VERSION,
    pushId: requireString(value.pushId, "hello.pushId"),
    remotePath: requireString(value.remotePath, "hello.remotePath"),
    totalBytes: requireSafeInteger(value.totalBytes, "hello.totalBytes"),
    treeDigest: requireString(value.treeDigest, "hello.treeDigest"),
    manifest: value.manifest.map(parseManifestEntry),
    directories: value.directories as string[],
  };
}

export function parseFetchRequest(value: unknown, nodeMaxBytes: number): FetchRequest {
  if (!isRecord(value)) throw new NodeWorkspaceError("protocol", "fetch parameters must be an object");
  const remotePath = requireString(value.remotePath, "fetch.remotePath");
  const maxBytes = requireSafeInteger(value.maxBytes, "fetch.maxBytes", 1);
  if (maxBytes > nodeMaxBytes) {
    throw new NodeWorkspaceError(
      "limit-exceeded",
      `requested artifact limit ${maxBytes} exceeds the node limit ${nodeMaxBytes}`,
    );
  }
  return { remotePath, maxBytes };
}

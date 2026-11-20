import type { ManifestEntry } from "./digest.js";
import { NodeWorkspaceError } from "./errors.js";
import type { PlanConflict, PlanCounts, PlanEntry } from "./managed-plan.js";
import { resolvePolicy, type PolicyInput, type ResolvedPolicy } from "./policy.js";

export const PROTOCOL_VERSION = 5;

export const COMMAND_SYNC = "nodews.sync";
export const COMMAND_FETCH = "nodews.fetch";
export const COMMAND_STATUS = "nodews.status";

/** Bounded acknowledgement window for staged payloads. */
export const SYNC_ACK_FILES = 128;
export const SYNC_ACK_BYTES = 8 * 1024 * 1024;

/** Grace the node keeps back so it can report a typed timeout before the Gateway's budget ends. */
export const NODE_RESPONSE_GRACE_MS = 5_000;

/** Node deadline derived from the Gateway budget, with a response grace. */
export function nodeDeadline(timeoutMs: number, now: number = Date.now()): number {
  return now + Math.max(1_000, timeoutMs - NODE_RESPONSE_GRACE_MS);
}

export interface SyncOwner {
  readonly agentId: string | null;
  readonly sessionKey: string | null;
}

export interface SyncHello {
  readonly t: "hello";
  readonly protocol: 5;
  readonly mode: "preview" | "apply";
  readonly operationId: string;
  /** Node id the Gateway resolved; echoed for diagnostics, never an authority. */
  readonly nodeId: string;
  readonly owner: SyncOwner;
  /** Canonical absolute local project on the Gateway. */
  readonly localProject: string;
  readonly remotePath: string;
  readonly policy: ResolvedPolicy;
  readonly create: boolean;
  readonly adopt: boolean;
  readonly adoptPaths: readonly string[];
  readonly restore: readonly string[];
  readonly rebind: boolean;
  readonly expectedRevision?: number;
  readonly planDigest?: string;
  /** Gateway-side budget; the node deadline is derived from it. */
  readonly timeoutMs: number;
  readonly manifest: readonly ManifestEntry[];
  readonly directories: readonly string[];
}

export interface SyncPlanMessage {
  readonly t: "plan";
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

export interface SyncResultSuccess {
  readonly t: "result";
  readonly ok: true;
  readonly mode: "preview" | "apply";
  readonly status: "planned" | "applied" | "noop" | "replayed";
  readonly operationId: string;
  readonly revision: number;
  readonly digest: string;
  readonly planDigest: string;
  readonly counts: PlanCounts;
  readonly applied: readonly string[];
  readonly truncated: boolean;
  readonly caches: "preserved-not-validated";
  readonly verification: "full";
  readonly recovery: "clean" | "recovered" | "rolled-back" | "committed" | "blocked";
  readonly protectedCount: number;
  readonly untracked: number;
}

export interface SyncResultFailure {
  readonly t: "result";
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly effect: "none" | "unknown";
  readonly readiness: string;
  readonly affected?: readonly string[];
}

export type SyncResult = SyncResultSuccess | SyncResultFailure;

export interface FetchRequest {
  readonly remotePath: string;
  readonly maxBytes: number;
  readonly timeoutMs: number | undefined;
}

export interface StatusRequest {
  readonly owner: { readonly agentId: string | null; readonly sessionKey: string | null };
  readonly timeoutMs: number | undefined;
  readonly remotePath?: string;
  readonly operationId?: string;
  readonly verify?: boolean;
  readonly limit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new NodeWorkspaceError("protocol", `${label} must be a non-empty string of at most ${maximum} characters`);
  }
  if (value.includes("\0")) throw new NodeWorkspaceError("protocol", `${label} must not contain a NUL byte`);
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

function requireHex(value: unknown, label: string, length: number): string {
  const text = requireString(value, label, length);
  if (!new RegExp(`^[0-9a-f]{${length}}$`, "u").test(text)) {
    throw new NodeWorkspaceError("protocol", `${label} must be ${length} lowercase hex characters`);
  }
  return text;
}

function requireStringArray(value: unknown, label: string, maximum = 2000): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new NodeWorkspaceError("protocol", `${label} must be an array of at most ${maximum} strings`);
  }
  return value.map((entry, index) => requireString(entry, `${label}[${index}]`));
}

export function parseManifestEntry(value: unknown): ManifestEntry {
  if (!isRecord(value)) throw new NodeWorkspaceError("protocol", "manifest entry must be an object");
  const path = requireString(value.path, "manifest entry path");
  const size = requireSafeInteger(value.size, "manifest entry size");
  const sha256 = requireHex(value.sha256, "manifest entry sha256", 64);
  return { path, size, sha256, executable: requireBoolean(value.executable, "manifest entry executable") };
}

function parseOwner(value: unknown): SyncOwner {
  if (!isRecord(value)) throw new NodeWorkspaceError("protocol", "hello.owner must be an object");
  const optional = (input: unknown, label: string): string | null => {
    if (input === null || input === undefined) return null;
    return requireString(input, label, 512);
  };
  return {
    agentId: optional(value.agentId, "hello.owner.agentId"),
    sessionKey: optional(value.sessionKey, "hello.owner.sessionKey"),
  };
}

export function parseSyncHello(value: unknown): SyncHello {
  if (!isRecord(value) || value.t !== "hello") {
    throw new NodeWorkspaceError("protocol", "expected a managed sync hello control frame");
  }
  if (value.protocol !== PROTOCOL_VERSION) {
    throw new NodeWorkspaceError("protocol", `unsupported protocol version ${String(value.protocol)}`);
  }
  const mode = value.mode;
  if (mode !== "preview" && mode !== "apply") {
    throw new NodeWorkspaceError("protocol", 'hello.mode must be "preview" or "apply"');
  }
  if (!Array.isArray(value.manifest) || !Array.isArray(value.directories)) {
    throw new NodeWorkspaceError("protocol", "hello.manifest and hello.directories must be arrays");
  }
  if (!isRecord(value.policy)) throw new NodeWorkspaceError("protocol", "hello.policy must be an object");
  const policyInput: PolicyInput = {
    preset: value.policy.preset as PolicyInput["preset"],
    include: Array.isArray(value.policy.include) ? (value.policy.include as string[]) : [],
    exclude: Array.isArray(value.policy.exclude) ? (value.policy.exclude as string[]) : [],
    protect: Array.isArray(value.policy.protect) ? (value.policy.protect as string[]) : [],
  };
  const policy = resolvePolicy(policyInput);
  const expectedRevisionValue = value.expectedRevision;
  const expectedRevision =
    expectedRevisionValue === undefined ? undefined : requireSafeInteger(expectedRevisionValue, "hello.expectedRevision");
  const planDigestValue = value.planDigest;
  const planDigest =
    planDigestValue === undefined ? undefined : requireHex(planDigestValue, "hello.planDigest", 64);
  return {
    t: "hello",
    protocol: PROTOCOL_VERSION,
    mode,
    operationId: requireHex(value.operationId, "hello.operationId", 32),
    nodeId: requireString(value.nodeId, "hello.nodeId", 256),
    owner: parseOwner(value.owner),
    localProject: requireString(value.localProject, "hello.localProject"),
    remotePath: requireString(value.remotePath, "hello.remotePath"),
    policy,
    create: requireBoolean(value.create, "hello.create"),
    adopt: requireBoolean(value.adopt, "hello.adopt"),
    adoptPaths: requireStringArray(value.adoptPaths, "hello.adoptPaths"),
    restore: requireStringArray(value.restore, "hello.restore"),
    rebind: requireBoolean(value.rebind, "hello.rebind"),
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    ...(planDigest !== undefined ? { planDigest } : {}),
    timeoutMs: requireSafeInteger(value.timeoutMs, "hello.timeoutMs", 1000),
    manifest: value.manifest.map(parseManifestEntry),
    directories: requireStringArray(value.directories, "hello.directories"),
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
  const timeoutMs =
    value.timeoutMs === undefined ? undefined : requireSafeInteger(value.timeoutMs, "fetch.timeoutMs", 1000);
  return { remotePath, maxBytes, timeoutMs };
}

export function parseStatusRequest(value: unknown): StatusRequest {
  if (!isRecord(value)) throw new NodeWorkspaceError("protocol", "status parameters must be an object");
  const owner = parseOwner(value.owner);
  const remotePath = value.remotePath === undefined ? undefined : requireString(value.remotePath, "status.remotePath");
  const operationId =
    value.operationId === undefined ? undefined : requireHex(value.operationId, "status.operationId", 32);
  const verify = value.verify === undefined ? undefined : requireBoolean(value.verify, "status.verify");
  const limit = value.limit === undefined ? undefined : requireSafeInteger(value.limit, "status.limit", 1);
  const timeoutMs =
    value.timeoutMs === undefined ? undefined : requireSafeInteger(value.timeoutMs, "status.timeoutMs", 1000);
  return {
    owner,
    timeoutMs,
    ...(remotePath !== undefined ? { remotePath } : {}),
    ...(operationId !== undefined ? { operationId } : {}),
    ...(verify !== undefined ? { verify } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

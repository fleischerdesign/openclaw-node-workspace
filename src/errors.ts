export type NodeWorkspaceErrorCode =
  | "config-invalid"
  | "path-invalid"
  | "path-outside-root"
  | "path-not-found"
  | "not-a-directory"
  | "symlink-rejected"
  | "special-file-rejected"
  | "limit-exceeded"
  | "invalid-manifest"
  | "destination-exists"
  | "destination-drifted"
  | "node-not-configured"
  | "node-rejected"
  | "protocol"
  | "integrity"
  | "transport"
  | "timeout"
  | "canceled"
  | "conflict"
  | "unknown-outcome"
  | "io";

/**
 * A failure that carries a machine-readable code.
 *
 * `unknown` is reserved for the one case where the plugin cannot prove whether
 * the node applied the operation. Never collapse it into a plain failure.
 */
export class NodeWorkspaceError extends Error {
  readonly code: NodeWorkspaceErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: NodeWorkspaceErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "NodeWorkspaceError";
    this.code = code;
    this.details = details;
  }

  /** True only when the effect may or may not have happened. */
  get outcomeUnknown(): boolean {
    return this.code === "unknown-outcome";
  }
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function errorMessage(value: unknown): string {
  return asError(value).message;
}

export function isErrno(error: unknown, ...codes: string[]): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && codes.includes(code);
}

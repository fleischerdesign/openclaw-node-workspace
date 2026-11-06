import { createHash } from "node:crypto";

export type Hex = string;

export function sha256Hex(bytes: Uint8Array | string): Hex {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Idempotency key for one content-addressed publish.
 *
 * The same bytes to the same destination derive the same id, so a caller that
 * retries after an unknown outcome gets `already-applied` instead of a second
 * copy. Different content at an occupied destination is a conflict.
 */
export function derivePushId(nodeId: string, remotePath: string, digest: Hex): Hex {
  return sha256Hex(`${nodeId}\n${remotePath}\n${digest}`).slice(0, 32);
}

export interface ManifestEntry {
  /** POSIX path relative to the published root. */
  readonly path: string;
  readonly size: number;
  readonly sha256: Hex;
  /** True when the owner execute bit is set on the source file. */
  readonly executable: boolean;
}

export interface ManifestBody {
  readonly version: 1;
  readonly files: readonly ManifestEntry[];
  /** Directories relative to the root, including empty ones. */
  readonly directories: readonly string[];
}

/**
 * Compare paths in byte order so every participant sorts identically.
 *
 * JavaScript string comparison uses UTF-16 code units, which is not the same
 * order for astral characters; the digest must not depend on the engine.
 */
export function comparePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function sortEntries(entries: readonly ManifestEntry[]): ManifestEntry[] {
  return [...entries].sort((left, right) => comparePaths(left.path, right.path));
}

/** Deterministic bytes for the manifest digest. Nothing mutable enters it. */
export function canonicalManifest(body: ManifestBody): string {
  const files = sortEntries(body.files).map((entry) => ({
    path: entry.path,
    size: entry.size,
    sha256: entry.sha256,
    executable: entry.executable,
  }));
  const directories = [...body.directories].sort(comparePaths);
  return JSON.stringify({ version: body.version, files, directories });
}

export function treeDigest(body: ManifestBody): Hex {
  return sha256Hex(canonicalManifest(body));
}

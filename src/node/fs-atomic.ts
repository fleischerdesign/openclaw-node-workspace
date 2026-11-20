import fs from "node:fs/promises";

import { NodeWorkspaceError, errorMessage, isErrno } from "../errors.js";
import { isWithin, normalizeAbsolutePosixPath } from "../paths.js";

async function realRoots(roots: readonly string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of roots) {
    try {
      const real = await fs.realpath(root);
      const stat = await fs.lstat(real);
      if (stat.isDirectory()) resolved.push(real);
    } catch {
      // A configured root that does not exist grants nothing.
    }
  }
  return resolved;
}

/** Resolve an existing regular file inside an artifact root. */
export async function resolveArtifactSource(
  remotePath: string,
  artifactRoots: readonly string[],
): Promise<string> {
  if (artifactRoots.length === 0) {
    throw new NodeWorkspaceError("node-not-configured", "node.artifactRoots is empty; no artifact is readable");
  }
  const normalized = normalizeAbsolutePosixPath(remotePath);
  let stat;
  try {
    stat = await fs.lstat(normalized);
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw new NodeWorkspaceError("path-not-found", `artifact does not exist: ${normalized}`);
    throw new NodeWorkspaceError("io", `cannot inspect ${normalized}: ${errorMessage(error)}`, {}, { cause: error });
  }
  if (stat.isSymbolicLink()) {
    throw new NodeWorkspaceError("symlink-rejected", `artifact must not be a symlink: ${normalized}`);
  }
  if (!stat.isFile()) {
    throw new NodeWorkspaceError("not-a-file", `artifact is not a regular file: ${normalized}`);
  }
  const real = await fs.realpath(normalized);
  const roots = await realRoots(artifactRoots);
  if (!roots.some((root) => isWithin(root, real))) {
    throw new NodeWorkspaceError(
      "path-outside-root",
      `artifact ${real} is outside every configured node.artifactRoots entry`,
    );
  }
  return real;
}

/** Local artifact mode never inherits group/other bits from the node. */
export function safeArtifactMode(remoteMode: number): number {
  return (remoteMode & 0o111) !== 0 ? 0o700 : 0o600;
}

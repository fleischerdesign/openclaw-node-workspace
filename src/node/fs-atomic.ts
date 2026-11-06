import fs from "node:fs/promises";
import path from "node:path";

import { NodeWorkspaceError, errorMessage, isErrno } from "../errors.js";
import { MARKER_FILE, assertDestinationName, isWithin, normalizeAbsolutePosixPath } from "../paths.js";
import { sha256Hex } from "../digest.js";

export interface PushDestination {
  readonly destination: string;
  readonly parent: string;
  readonly root: string;
}

async function realRoots(roots: readonly string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of roots) {
    try {
      const real = await fs.realpath(root);
      const stat = await fs.lstat(real);
      if (!stat.isDirectory()) continue;
      resolved.push(real);
    } catch {
      // A configured root that does not exist grants nothing.
    }
  }
  return resolved;
}

async function resolveParent(remotePath: string): Promise<{ parent: string; name: string; root: string }> {
  const normalized = normalizeAbsolutePosixPath(remotePath);
  const name = assertDestinationName(path.posix.basename(normalized));
  const parentCandidate = path.posix.dirname(normalized);
  let parentStat;
  try {
    parentStat = await fs.lstat(parentCandidate);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new NodeWorkspaceError("path-not-found", `parent directory does not exist: ${parentCandidate}`);
    }
    throw new NodeWorkspaceError("io", `cannot inspect ${parentCandidate}: ${errorMessage(error)}`, {}, { cause: error });
  }
  if (parentStat.isSymbolicLink()) {
    throw new NodeWorkspaceError("symlink-rejected", `parent directory must not be a symlink: ${parentCandidate}`);
  }
  if (!parentStat.isDirectory()) {
    throw new NodeWorkspaceError("not-a-directory", `parent is not a directory: ${parentCandidate}`);
  }
  return { parent: await fs.realpath(parentCandidate), name, root: parentCandidate };
}

/**
 * Resolve a push destination into an allowed root.
 *
 * The parent must already exist: the plugin never creates a directory chain
 * outside a configured root, and realpath containment makes a symlinked parent
 * harmless.
 */
export async function resolvePushDestination(
  remotePath: string,
  pushRoots: readonly string[],
): Promise<PushDestination> {
  if (pushRoots.length === 0) {
    throw new NodeWorkspaceError("node-not-configured", "node.pushRoots is empty; no push destination is allowed");
  }
  const parent = await resolveParent(remotePath);
  const roots = await realRoots(pushRoots);
  const match = roots.find((root) => isWithin(root, parent.parent));
  if (match === undefined) {
    throw new NodeWorkspaceError(
      "path-outside-root",
      `destination parent ${parent.parent} is outside every configured node.pushRoots entry`,
    );
  }
  const destination = path.posix.join(parent.parent, parent.name);
  if (!isWithin(match, destination)) {
    throw new NodeWorkspaceError("path-outside-root", "destination is outside the configured node.pushRoots entry");
  }
  return { destination, parent: parent.parent, root: match };
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
    throw new NodeWorkspaceError("not-a-directory", `artifact is not a regular file: ${normalized}`);
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

export interface Marker {
  readonly plugin: "node-workspace";
  readonly protocol: 1;
  readonly pushId: string;
  readonly digest: string;
  readonly files: number;
  readonly bytes: number;
  readonly createdAt: string;
}

export async function readMarker(destination: string): Promise<Marker | undefined> {
  try {
    const markerPath = path.join(destination, MARKER_FILE);
    const stat = await fs.lstat(markerPath);
    // A symlinked or oversized marker is not proof of ownership.
    if (!stat.isFile() || stat.size > 64 * 1024) return undefined;
    const raw = await fs.readFile(markerPath, { encoding: "utf8" });
    const value = JSON.parse(raw) as Partial<Marker>;
    if (
      value.plugin !== "node-workspace" ||
      value.protocol !== 1 ||
      typeof value.pushId !== "string" ||
      typeof value.digest !== "string" ||
      typeof value.files !== "number" ||
      typeof value.bytes !== "number" ||
      typeof value.createdAt !== "string"
    ) {
      return undefined;
    }
    return value as Marker;
  } catch {
    return undefined;
  }
}

export async function markerMatches(
  destination: string,
  pushId: string,
  digest: string,
): Promise<boolean> {
  const marker = await readMarker(destination);
  return marker !== undefined && marker.pushId === pushId && marker.digest === digest;
}

export async function writeMarker(directory: string, marker: Marker): Promise<void> {
  const target = path.join(directory, MARKER_FILE);
  await fs.writeFile(target, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

/** Re-hash every staged file so the published bytes, not only the wire bytes, are verified. */
export async function verifyStagedTree(
  directory: string,
  files: readonly { path: string; size: number; sha256: string }[],
): Promise<void> {
  for (const entry of files) {
    const absolute = path.join(directory, ...entry.path.split("/"));
    const bytes = await fs.readFile(absolute);
    if (bytes.byteLength !== entry.size || sha256Hex(bytes) !== entry.sha256) {
      throw new NodeWorkspaceError("integrity", `staged file failed verification: ${entry.path}`);
    }
  }
}

export async function fsyncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is best-effort; some filesystems reject it.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

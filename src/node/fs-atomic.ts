import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { NodeWorkspaceError, errorMessage, isErrno } from "../errors.js";
import {
  MARKER_FILE,
  MAX_MARKER_BYTES,
  assertDestinationName,
  isWithin,
  normalizeAbsolutePosixPath,
} from "../paths.js";
import { sha256Hex, sortEntries, type ManifestEntry } from "../digest.js";

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

async function resolveParent(remotePath: string): Promise<{ parent: string; name: string }> {
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
  return { parent: await fs.realpath(parentCandidate), name };
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

/**
 * Validate a destination path against the roots without requiring the parent
 * to exist. Used by status, which must distinguish "absent" from "forbidden".
 */
export async function assertDestinationAllowed(
  remotePath: string,
  pushRoots: readonly string[],
): Promise<string> {
  if (pushRoots.length === 0) {
    throw new NodeWorkspaceError("node-not-configured", "node.pushRoots is empty; no destination is allowed");
  }
  const normalized = normalizeAbsolutePosixPath(remotePath);
  const roots = await realRoots(pushRoots);
  const lexicalMatch = roots.some((root) => isWithin(root, normalized));
  if (!lexicalMatch) {
    throw new NodeWorkspaceError("path-outside-root", "destination is outside every configured node.pushRoots entry");
  }
  return normalized;
}

/**
 * Resolve an existing directory inside a configured return root.
 *
 * A return reads a whole tree, so the directory itself must be real: a
 * symlinked root would let the Gateway read outside the operator's intent.
 */
export async function resolveReturnSource(
  remotePath: string,
  returnRoots: readonly string[],
): Promise<{ readonly directory: string; readonly root: string }> {
  if (returnRoots.length === 0) {
    throw new NodeWorkspaceError("node-not-configured", "node.returnRoots is empty; no project tree is readable");
  }
  const normalized = normalizeAbsolutePosixPath(remotePath);
  let stat;
  try {
    stat = await fs.lstat(normalized);
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw new NodeWorkspaceError("path-not-found", `directory does not exist: ${normalized}`);
    throw new NodeWorkspaceError("io", `cannot inspect ${normalized}: ${errorMessage(error)}`, {}, { cause: error });
  }
  if (stat.isSymbolicLink()) {
    throw new NodeWorkspaceError("symlink-rejected", `return source must not be a symlink: ${normalized}`);
  }
  if (!stat.isDirectory()) {
    throw new NodeWorkspaceError("not-a-directory", `return source is not a directory: ${normalized}`);
  }
  const real = await fs.realpath(normalized);
  const roots = await realRoots(returnRoots);
  const match = roots.find((root) => isWithin(root, real));
  if (match === undefined) {
    throw new NodeWorkspaceError(
      "path-outside-root",
      `return source ${real} is outside every configured node.returnRoots entry`,
    );
  }
  return { directory: real, root: match };
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

export type MarkerState = "complete" | "incomplete" | "legacy";

export interface Marker {
  readonly plugin: "node-workspace";
  readonly protocol: 1;
  readonly pushId: string;
  readonly digest: string;
  readonly files: number;
  readonly bytes: number;
  readonly createdAt: string;
  /** Absent on markers written before the state field existed: legacy. */
  readonly state: MarkerState;
  readonly manifest?: readonly ManifestEntry[];
  readonly directories?: readonly string[];
}

export async function readMarker(destination: string): Promise<Marker | undefined> {
  try {
    const markerPath = path.join(destination, MARKER_FILE);
    const stat = await fs.lstat(markerPath);
    // A symlinked or oversized marker is not proof of ownership.
    if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) return undefined;
    const raw = await fs.readFile(markerPath, { encoding: "utf8" });
    const value = JSON.parse(raw) as Partial<Marker>;
    if (
      value.plugin !== "node-workspace" ||
      value.protocol !== 1 ||
      typeof value.pushId !== "string" ||
      typeof value.digest !== "string" ||
      typeof value.files !== "number" ||
      typeof value.bytes !== "number" ||
      typeof value.createdAt !== "string" ||
      (value.manifest !== undefined && !Array.isArray(value.manifest)) ||
      (value.directories !== undefined && !Array.isArray(value.directories))
    ) {
      return undefined;
    }
    const state =
      value.state === "complete" || value.state === "incomplete"
        ? value.state
        : value.state === undefined
          ? "legacy"
          : undefined;
    if (!state) return undefined;
    return { ...(value as Marker), state };
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
  const temp = path.join(directory, `.openclaw-node-workspace.tmp-${randomUUID()}`);
  const body = `${JSON.stringify(marker, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_MARKER_BYTES) {
    throw new NodeWorkspaceError("limit-exceeded", "marker exceeds the maximum marker size");
  }
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(body, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, target);
    await fsyncDirectory(directory);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
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

const SMALL_FILE_HASH_BYTES = 4 * 1024 * 1024;

function drift(reason: string): never {
  throw new NodeWorkspaceError("destination-drifted", reason);
}

/**
 * Prove that the published directory still matches the manifest byte for byte.
 *
 * A marker alone only records what a previous push claimed; it cannot prove
 * that the node's copy is unchanged. This walk rejects extra, missing, linked,
 * or modified entries instead of reporting a stale copy as applied.
 */
export interface VerifyOptions {
  readonly deadline?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export async function verifyTreeMatches(
  destination: string,
  manifest: readonly ManifestEntry[],
  directories: readonly string[],
  options: VerifyOptions = {},
): Promise<void> {
  const check = (): void => {
    if (options.deadline !== undefined && Date.now() > options.deadline) {
      throw new NodeWorkspaceError("timeout", "tree verification exceeded its deadline");
    }
    if (options.signal?.aborted) {
      throw new NodeWorkspaceError("canceled", "tree verification was canceled", {}, { cause: options.signal.reason });
    }
  };
  const expectedFiles = new Map(sortEntries(manifest).map((entry) => [entry.path, entry]));
  const expectedDirectories = new Set(directories);
  const seenFiles = new Set<string>();
  const seenDirectories = new Set<string>();

  const walk = async (relativeDir: string): Promise<void> => {
    check();
    const absoluteDir = relativeDir.length === 0 ? destination : path.join(destination, relativeDir);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      check();
      const relative = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;
      if (relativeDir.length === 0 && entry.name === MARKER_FILE) continue;
      const absolute = path.join(destination, ...relative.split("/"));
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) drift(`published tree contains a symlink at ${relative}`);
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(relative)) drift(`published tree contains an unexpected directory ${relative}`);
        if (seenDirectories.has(relative)) drift(`published tree repeats directory ${relative}`);
        seenDirectories.add(relative);
        await walk(relative);
        continue;
      }
      if (!stat.isFile()) drift(`published tree contains a non-regular entry ${relative}`);
      const expected = expectedFiles.get(relative);
      if (!expected) drift(`published tree contains an unexpected file ${relative}`);
      if (seenFiles.has(relative)) drift(`published tree repeats file ${relative}`);
      if (stat.size !== expected.size) drift(`published file size differs at ${relative}`);
      if (((stat.mode & 0o111) !== 0) !== expected.executable) {
        drift(`published executable bit differs at ${relative}`);
      }
      const hash = createHash("sha256");
      if (stat.size <= SMALL_FILE_HASH_BYTES) {
        hash.update(await fs.readFile(absolute));
      } else {
        const stream = createReadStream(absolute);
        for await (const chunk of stream) {
          check();
          hash.update(chunk as Buffer);
        }
      }
      if (hash.digest("hex") !== expected.sha256) drift(`published file content differs at ${relative}`);
      seenFiles.add(relative);
    }
  };

  await walk("");
  for (const relative of expectedDirectories) {
    if (!seenDirectories.has(relative)) drift(`published tree is missing directory ${relative}`);
  }
  for (const relative of expectedFiles.keys()) {
    if (!seenFiles.has(relative)) drift(`published tree is missing file ${relative}`);
  }
}

async function runPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

/**
 * fsync every published file before the complete marker is written.
 *
 * Per-file durability is not required while receiving: the incomplete marker
 * already makes a partial tree explicit. Fsyncing in a bounded pool before the
 * complete marker keeps the crash guarantee without paying one serial sync per
 * file on the critical path.
 */
export async function fsyncTreeFiles(
  root: string,
  files: readonly ManifestEntry[],
  concurrency = 16,
): Promise<void> {
  await runPool(files, concurrency, async (entry) => {
    const absolute = path.join(root, ...entry.path.split("/"));
    let handle;
    try {
      handle = await fs.open(absolute, "r");
      await handle.sync();
    } catch (error) {
      throw new NodeWorkspaceError("io", `cannot sync ${entry.path}: ${errorMessage(error)}`, {}, {
        cause: error,
      });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  });
}

export async function fsyncTreeDirectories(root: string, concurrency = 16): Promise<void> {
  const directories: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    directories.push(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(path.join(directory, entry.name));
    }
  };
  await walk(root);
  await runPool(directories, concurrency, fsyncDirectory);
}

export async function fsyncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Some filesystems reject directory fsync; anything else is a durability
    // failure and must not be reported as a successful publication.
    if (!isErrno(error, "EINVAL", "ENOTSUP", "EBADF")) {
      throw new NodeWorkspaceError("io", `cannot sync directory ${directory}: ${errorMessage(error)}`, {}, {
        cause: error,
      });
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Local artifact mode never inherits group/other bits from the node. */
export function safeArtifactMode(remoteMode: number): number {
  return (remoteMode & 0o111) !== 0 ? 0o700 : 0o600;
}

/**
 * Atomically claim a destination name without ever replacing it.
 *
 * mkdir(2) is the no-clobber primitive available on every supported POSIX
 * host: it fails with EEXIST for an existing file, symlink, or directory,
 * including an empty directory (which rename(2) would otherwise replace).
 */
export async function claimDestination(destination: string): Promise<void> {
  try {
    await fs.mkdir(destination, { mode: 0o700 });
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new NodeWorkspaceError("destination-exists", "destination already exists; it is never replaced");
    }
    throw new NodeWorkspaceError("io", `cannot claim destination: ${errorMessage(error)}`, {}, { cause: error });
  }
}

/**
 * Remove a claimed destination only when it is empty or contains exactly our
 * incomplete marker. Anything else is left in place: the plugin never deletes
 * a tree it cannot prove it owns.
 */
export async function cleanupIncomplete(destination: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(destination);
    if (entries.length === 0) {
      await fs.rmdir(destination);
      return false;
    }
    if (entries.length === 1 && entries[0] === MARKER_FILE) {
      const marker = await readMarker(destination);
      if (marker?.state === "incomplete") {
        await fs.unlink(path.join(destination, MARKER_FILE));
        await fs.rmdir(destination);
        return false;
      }
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Re-check every already-created parent of a relative path before writing.
 *
 * Node has no openat/O_NOFOLLOW-across-components primitive, so this narrows
 * the same-user symlink race to the gap between this check and the subsequent
 * open; it does not eliminate it. The final verifyTreeMatches pass rejects a
 * tree that contains a symlink, and status reports the drift.
 */
export async function assertSafeParent(destination: string, relativePath: string): Promise<void> {
  const rootStat = await fs.lstat(destination);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new NodeWorkspaceError("symlink-rejected", "claimed destination was replaced during publication");
  }
  if ((await fs.realpath(destination)) !== destination) {
    throw new NodeWorkspaceError("symlink-rejected", "claimed destination resolves elsewhere during publication");
  }
  const segments = relativePath.split("/");
  segments.pop();
  let current = destination;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new NodeWorkspaceError("symlink-rejected", `parent became a symlink during publication: ${relativePath}`);
    }
    if (!stat.isDirectory()) {
      throw new NodeWorkspaceError("destination-drifted", `parent is not a directory during publication: ${relativePath}`);
    }
    const real = await fs.realpath(current);
    if (real !== current) {
      throw new NodeWorkspaceError("symlink-rejected", `parent resolves outside the claimed destination: ${relativePath}`);
    }
  }
}

import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import type { NodeConfig } from "../config.js";
import { comparePaths, sortEntries, type ManifestEntry } from "../digest.js";
import { NodeWorkspaceError, errorMessage } from "../errors.js";
import { scanWorkspace } from "../manifest.js";
import { MARKER_FILE, assertSafeRelativePath } from "../paths.js";
import { parseReturnHello } from "../protocol.js";
import {
  readMarker,
  resolveReturnSource,
  type Marker,
} from "./fs-atomic.js";
import {
  NODE_OPERATION_TIMEOUT_MS,
  readControl,
  sessionFromFrames,
  type NodeHostCommandIo,
} from "./session.js";

const RETURN_CHUNK_BYTES = 64 * 1024;

export interface NodeTree {
  readonly directory: string;
  readonly files: readonly ManifestEntry[];
  readonly directories: readonly string[];
  readonly totalBytes: number;
  readonly treeDigest: string;
  readonly marker: Marker | undefined;
  readonly owned: boolean;
  readonly complete: boolean;
  /** True when the live tree still matches the marker manifest byte for byte. */
  readonly verified: boolean;
  readonly drift: string | null;
}

function sameEntries(left: readonly ManifestEntry[], right: readonly ManifestEntry[]): boolean {
  if (left.length !== right.length) return false;
  const a = sortEntries(left);
  const b = sortEntries(right);
  for (let index = 0; index < a.length; index += 1) {
    const one = a[index];
    const two = b[index];
    if (!one || !two) return false;
    if (
      one.path !== two.path ||
      one.size !== two.size ||
      one.sha256 !== two.sha256 ||
      one.executable !== two.executable
    ) {
      return false;
    }
  }
  return true;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort(comparePaths);
  const b = [...right].sort(comparePaths);
  return a.every((value, index) => value === b[index]);
}

/**
 * Scan a node directory that the Gateway may return files from.
 *
 * The scan is the node's independent view: it hashes every file, rejects
 * symlinks and special files, and compares the result to the plugin marker so
 * the Gateway can tell the last published generation from later changes.
 */
export async function readNodeTree(
  config: NodeConfig,
  remotePath: string,
  deadline: number,
): Promise<NodeTree> {
  const source = await resolveReturnSource(remotePath, config.returnRoots);
  const scan = await scanWorkspace({
    root: source.directory,
    exclude: [MARKER_FILE],
    symlinks: "reject",
    maxFiles: config.maxFiles,
    maxFileBytes: config.maxFileBytes,
    maxTotalBytes: config.maxTotalBytes,
    deadline,
  });
  const marker = await readMarker(source.directory);
  const owned = marker !== undefined;
  const complete = marker?.state === "complete";
  let verified = false;
  let drift: string | null = null;
  if (marker === undefined) {
    drift = "no node-workspace marker";
  } else if (marker.state !== "complete") {
    drift = marker.state === "incomplete" ? "publication is incomplete" : "legacy marker has no manifest to verify";
  } else if (marker.manifest === undefined || marker.directories === undefined) {
    drift = "marker has no manifest to verify";
  } else if (
    marker.digest === scan.treeDigest &&
    sameEntries(marker.manifest, scan.files) &&
    sameStrings(marker.directories, scan.directories)
  ) {
    verified = true;
  } else {
    drift = "node content changed since the recorded publication";
  }
  return {
    directory: source.directory,
    files: scan.files,
    directories: scan.directories,
    totalBytes: scan.totalBytes,
    treeDigest: scan.treeDigest,
    marker,
    owned,
    complete,
    verified,
    drift,
  };
}

export function treePayload(remotePath: string, tree: NodeTree): Record<string, unknown> {
  return {
    ok: true,
    remotePath,
    directory: tree.directory,
    files: tree.files,
    directories: tree.directories,
    totalBytes: tree.totalBytes,
    treeDigest: tree.treeDigest,
    owned: tree.owned,
    complete: tree.complete,
    verified: tree.verified,
    drift: tree.drift,
    marker: tree.marker ?? null,
  };
}

export async function handleTree(
  config: NodeConfig,
  paramsJSON: string | null | undefined,
): Promise<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(paramsJSON ?? "{}");
  } catch {
    throw new NodeWorkspaceError("protocol", "tree parameters are not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new NodeWorkspaceError("protocol", "tree parameters must be an object");
  }
  const remotePath = (raw as Record<string, unknown>).remotePath;
  if (typeof remotePath !== "string") {
    throw new NodeWorkspaceError("protocol", "tree.remotePath must be a string");
  }
  const deadline = Date.now() + NODE_OPERATION_TIMEOUT_MS;
  const tree = await readNodeTree(config, remotePath, deadline);
  return JSON.stringify(treePayload(remotePath, tree));
}

/** Validate the requested subset against the freshly scanned node tree. */
function selectPaths(tree: NodeTree, paths: readonly string[], maxFiles: number): ManifestEntry[] {
  if (paths.length > maxFiles) {
    throw new NodeWorkspaceError("limit-exceeded", `return selection exceeds the ${maxFiles} file limit`);
  }
  const byPath = new Map(tree.files.map((entry) => [entry.path, entry]));
  const selected: ManifestEntry[] = [];
  let previous: string | undefined;
  for (const candidate of paths) {
    assertSafeRelativePath(candidate, "return path");
    if (previous !== undefined && comparePaths(previous, candidate) >= 0) {
      throw new NodeWorkspaceError("protocol", "return paths must be unique and sorted");
    }
    previous = candidate;
    const entry = byPath.get(candidate);
    if (!entry) {
      throw new NodeWorkspaceError("plan-stale", `return path is no longer in the node tree: ${candidate}`);
    }
    selected.push(entry);
  }
  return selected;
}

/**
 * Stream one selected subset of a node directory back to the Gateway.
 *
 * The node re-scans the tree and refuses a selection whose digest no longer
 * matches the preview. It never writes, renames, or deletes anything.
 */
export async function handleReturn(
  config: NodeConfig,
  io: NodeHostCommandIo | undefined,
): Promise<string> {
  const session = sessionFromFrames(io);
  let accepted = false;
  let files = 0;
  let bytes = 0;
  try {
    const deadline = Date.now() + NODE_OPERATION_TIMEOUT_MS;
    const hello = parseReturnHello(await readControl(session, ["hello"], deadline));
    const tree = await readNodeTree(config, hello.remotePath, deadline);
    if (tree.treeDigest !== hello.treeDigest) {
      throw new NodeWorkspaceError(
        "plan-stale",
        "the node tree changed since the preview; request a new preview before returning files",
      );
    }
    const selected = selectPaths(tree, hello.paths, config.maxFiles);
    accepted = true;
    await session.sendControl({ t: "accepted", treeDigest: tree.treeDigest });

    const buffer = Buffer.allocUnsafe(RETURN_CHUNK_BYTES);
    for (const entry of selected) {
      const absolute = `${tree.directory}/${entry.path}`;
      const handle = await fs.open(absolute, "r");
      try {
        await session.sendControl({
          t: "file",
          path: entry.path,
          size: entry.size,
          sha256: entry.sha256,
          executable: entry.executable,
        });
        const hash = createHash("sha256");
        let sent = 0;
        for (;;) {
          if (Date.now() > deadline) {
            throw new NodeWorkspaceError("timeout", "the return transfer exceeded its time limit");
          }
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, sent);
          if (bytesRead === 0) break;
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          await session.sendData(chunk);
          sent += bytesRead;
          if (sent > entry.size) {
            throw new NodeWorkspaceError("integrity", `file grew while it was being returned: ${entry.path}`);
          }
        }
        if (sent !== entry.size || hash.digest("hex") !== entry.sha256) {
          throw new NodeWorkspaceError("integrity", `file changed while it was being returned: ${entry.path}`);
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      files += 1;
      bytes += entry.size;
    }
    await session.sendControl({ t: "end", treeDigest: tree.treeDigest, files, bytes });
    return JSON.stringify({ ok: true, files, bytes, treeDigest: tree.treeDigest });
  } catch (error) {
    const failure = error instanceof NodeWorkspaceError
      ? error
      : new NodeWorkspaceError("io", errorMessage(error), {}, { cause: error });
    await session
      .sendControl(
        accepted
          ? { t: "return-error", code: failure.code, message: failure.message }
          : { t: "rejected", code: failure.code, message: failure.message },
      )
      .catch(() => undefined);
    return JSON.stringify({ ok: false, code: failure.code });
  } finally {
    session.close();
  }
}

/** Re-check a parent chain without following symlinks. */
export async function assertNoSymlinkParents(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = `${current}/${segment}`;
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new NodeWorkspaceError("symlink-rejected", `parent became a symlink during return: ${relativePath}`);
    }
    if (!stat.isDirectory()) {
      throw new NodeWorkspaceError("plan-stale", `parent is not a directory: ${relativePath}`);
    }
  }
}

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { minimatch } from "minimatch";

import type { ManifestEntry } from "./digest.js";
import { sortEntries, treeDigest } from "./digest.js";
import { NodeWorkspaceError, errorMessage, isErrno } from "./errors.js";
import { assertSafeRelativePath, normalizeAbsolutePosixPath } from "./paths.js";
import type { SymlinkPolicy } from "./config.js";
import type { PushHello } from "./protocol.js";

export interface ScanRequest {
  readonly root: string;
  readonly exclude: readonly string[];
  readonly symlinks: SymlinkPolicy;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly signal?: AbortSignal | undefined;
  readonly deadline?: number | undefined;
}

export interface SkippedEntry {
  readonly path: string;
  readonly reason: "symlink" | "excluded";
}

export interface ScanResult {
  readonly root: string;
  readonly files: readonly ManifestEntry[];
  readonly directories: readonly string[];
  readonly totalBytes: number;
  readonly treeDigest: string;
  readonly skipped: readonly SkippedEntry[];
}

function checkAborted(signal: AbortSignal | undefined, deadline?: number): void {
  if (deadline !== undefined && Date.now() > deadline) {
    throw new NodeWorkspaceError("timeout", "the scan exceeded the operation deadline");
  }
  if (signal?.aborted) {
    throw new NodeWorkspaceError("canceled", "the push was canceled before it finished scanning", {}, {
      cause: signal.reason,
    });
  }
}

function compileExcludes(patterns: readonly string[]): (relativePath: string) => boolean {
  if (patterns.length === 0) return () => false;
  const compiled = patterns.map((raw) => {
    if (raw.includes("\0")) throw new NodeWorkspaceError("config-invalid", "exclude pattern contains a NUL byte");
    const normalized = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    if (normalized.length === 0) throw new NodeWorkspaceError("config-invalid", "exclude pattern must not be empty");
    return normalized;
  });
  return (relativePath) =>
    compiled.some((pattern) => minimatch(relativePath, pattern, { dot: true }) || minimatch(relativePath, `${pattern}/**`, { dot: true }));
}

async function hashFile(absolutePath: string): Promise<{ size: number; sha256: string }> {
  const before = await fs.lstat(absolutePath);
  if (!before.isFile()) {
    throw new NodeWorkspaceError("special-file-rejected", `not a regular file: ${absolutePath}`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(absolutePath);
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      bytes += buffer.byteLength;
      hash.update(buffer);
    }
  } catch (error) {
    throw new NodeWorkspaceError("io", `failed to read ${absolutePath}: ${errorMessage(error)}`, {}, { cause: error });
  }
  const after = await fs.lstat(absolutePath);
  if (
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ino !== before.ino ||
    bytes !== before.size
  ) {
    throw new NodeWorkspaceError("io", `file changed while it was being read: ${absolutePath}`);
  }
  return { size: bytes, sha256: hash.digest("hex") };
}

/**
 * Walk one selected directory without following links.
 *
 * The scan is strict: a symlink, socket, or FIFO aborts it unless symlinks are
 * configured to be skipped. Silently following a link would publish a file the
 * caller did not select.
 */
export async function scanWorkspace(request: ScanRequest): Promise<ScanResult> {
  const root = normalizeAbsolutePosixPath(request.root);
  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw new NodeWorkspaceError("path-not-found", `workspace does not exist: ${root}`);
    throw new NodeWorkspaceError("io", `cannot inspect ${root}: ${errorMessage(error)}`, {}, { cause: error });
  }
  if (rootStat.isSymbolicLink()) {
    throw new NodeWorkspaceError("symlink-rejected", `the selected workspace root must not be a symlink: ${root}`);
  }
  if (!rootStat.isDirectory()) {
    throw new NodeWorkspaceError("not-a-directory", `the selected workspace is not a directory: ${root}`);
  }

  const excluded = compileExcludes(request.exclude);
  const files: ManifestEntry[] = [];
  const directories: string[] = [];
  const skipped: SkippedEntry[] = [];
  let totalBytes = 0;

  const walk = async (relativeDir: string): Promise<void> => {
    checkAborted(request.signal, request.deadline);
    const absoluteDir = relativeDir.length === 0 ? root : path.join(root, relativeDir);
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch (error) {
      throw new NodeWorkspaceError("io", `cannot read ${absoluteDir}: ${errorMessage(error)}`, {}, { cause: error });
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    for (const entry of entries) {
      checkAborted(request.signal, request.deadline);
      const relativePath = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;
      const absolutePath = path.join(root, relativePath);
      if (excluded(relativePath)) {
        skipped.push({ path: relativePath, reason: "excluded" });
        continue;
      }

      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        if (request.symlinks === "skip") {
          skipped.push({ path: relativePath, reason: "symlink" });
          continue;
        }
        throw new NodeWorkspaceError(
          "symlink-rejected",
          `workspace contains a symlink at ${relativePath}; set gateway.symlinks to "skip" to omit links`,
        );
      }
      if (stat.isDirectory()) {
        assertSafeRelativePath(relativePath);
        if (files.length + directories.length >= request.maxFiles) {
          throw new NodeWorkspaceError("limit-exceeded", `workspace exceeds the ${request.maxFiles} entry limit`);
        }
        directories.push(relativePath);
        await walk(relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new NodeWorkspaceError(
          "special-file-rejected",
          `workspace contains a non-regular entry at ${relativePath}`,
        );
      }
      assertSafeRelativePath(relativePath);
      if (stat.size > request.maxFileBytes) {
        throw new NodeWorkspaceError(
          "limit-exceeded",
          `${relativePath} is ${stat.size} bytes, above the per-file limit ${request.maxFileBytes}`,
        );
      }
      if (files.length + directories.length >= request.maxFiles) {
        throw new NodeWorkspaceError("limit-exceeded", `workspace exceeds the ${request.maxFiles} entry limit`);
      }
      if (totalBytes + stat.size > request.maxTotalBytes) {
        throw new NodeWorkspaceError("limit-exceeded", `workspace exceeds the ${request.maxTotalBytes} byte limit`);
      }
      const hashed = await hashFile(absolutePath);
      if (hashed.size !== stat.size) {
        throw new NodeWorkspaceError("io", `file changed while it was being read: ${relativePath}`);
      }
      totalBytes += hashed.size;
      files.push({
        path: relativePath,
        size: hashed.size,
        sha256: hashed.sha256,
        executable: (stat.mode & 0o111) !== 0,
      });
    }
  };

  await walk("");
  const sortedFiles = sortEntries(files);
  const sortedDirectories = [...directories].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  return {
    root,
    files: sortedFiles,
    directories: sortedDirectories,
    totalBytes,
    treeDigest: treeDigest({ version: 1, files: sortedFiles, directories: sortedDirectories }),
    skipped,
  };
}

export interface ManifestLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

/**
 * Validate a manifest received from the Gateway before anything is written.
 *
 * This is the node's independent check: it trusts no counts, no paths, and no
 * ordering from the other side.
 */
export function validateManifestShape(hello: PushHello, limits: ManifestLimits): void {
  if (!/^[0-9a-f]{16,64}$/.test(hello.pushId)) {
    throw new NodeWorkspaceError("protocol", "pushId must be 16-64 lowercase hex characters");
  }
  if (!/^[0-9a-f]{64}$/.test(hello.treeDigest)) {
    throw new NodeWorkspaceError("protocol", "treeDigest must be lowercase SHA-256 hex");
  }
  if (hello.manifest.length + hello.directories.length > limits.maxFiles) {
    throw new NodeWorkspaceError("limit-exceeded", `manifest exceeds the node limit of ${limits.maxFiles} entries`);
  }
  normalizeAbsolutePosixPath(hello.remotePath);

  const seen = new Set<string>();
  const directorySet = new Set<string>();
  for (const directory of hello.directories) {
    assertSafeRelativePath(directory, "directory path");
    if (seen.has(directory)) throw new NodeWorkspaceError("invalid-manifest", `duplicate path ${directory}`);
    seen.add(directory);
    directorySet.add(directory);
  }

  let totalBytes = 0;
  for (const entry of hello.manifest) {
    assertSafeRelativePath(entry.path);
    if (seen.has(entry.path)) throw new NodeWorkspaceError("invalid-manifest", `duplicate path ${entry.path}`);
    seen.add(entry.path);
    if (entry.size > limits.maxFileBytes) {
      throw new NodeWorkspaceError(
        "limit-exceeded",
        `${entry.path} is ${entry.size} bytes, above the node per-file limit ${limits.maxFileBytes}`,
      );
    }
    totalBytes += entry.size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new NodeWorkspaceError("limit-exceeded", `manifest exceeds the node byte limit ${limits.maxTotalBytes}`);
    }
  }
  if (totalBytes !== hello.totalBytes) {
    throw new NodeWorkspaceError("invalid-manifest", "hello.totalBytes does not match the manifest");
  }

  // Every declared directory must have its own parents declared too.
  for (const directory of hello.directories) {
    const segments = directory.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index).join("/");
      if (!directorySet.has(prefix)) {
        throw new NodeWorkspaceError("invalid-manifest", `missing parent directory entry ${prefix} for ${directory}`);
      }
    }
  }

  // A file cannot also be a parent directory of another entry.
  for (const entry of hello.manifest) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index).join("/");
      if (!directorySet.has(prefix)) {
        throw new NodeWorkspaceError("invalid-manifest", `missing parent directory entry ${prefix} for ${entry.path}`);
      }
    }
  }
}


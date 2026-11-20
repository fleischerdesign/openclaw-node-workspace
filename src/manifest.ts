import fs from "node:fs/promises";
import path from "node:path";

import type { ManifestEntry } from "./digest.js";
import { comparePaths, sortEntries, treeDigest } from "./digest.js";
import { NodeWorkspaceError, errorMessage, isErrno } from "./errors.js";
import { hashRegularFile } from "./file-hash.js";
import { assertSafeRelativePath } from "./paths.js";
import { isExcluded, isProtected, isSelected, type ResolvedPolicy } from "./policy.js";

export interface ScanLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface SkippedEntry {
  readonly path: string;
  readonly reason: "cache" | "protected" | "unselected";
}

export interface SourceScan {
  readonly root: string;
  readonly files: readonly ManifestEntry[];
  readonly directories: readonly string[];
  readonly totalBytes: number;
  readonly treeDigest: string;
  readonly skipped: readonly SkippedEntry[];
  readonly excluded: number;
  readonly protectedCount: number;
}

export interface ScanRequest {
  readonly root: string;
  readonly policy: ResolvedPolicy;
  readonly limits: ScanLimits;
  readonly signal?: AbortSignal | undefined;
  readonly deadline?: number | undefined;
}

function checkAborted(signal: AbortSignal | undefined, deadline: number | undefined): void {
  if (deadline !== undefined && Date.now() > deadline) {
    throw new NodeWorkspaceError("timeout", "the local scan exceeded the operation deadline");
  }
  if (signal?.aborted) {
    throw new NodeWorkspaceError("canceled", "the operation was canceled before scanning finished", {}, {
      cause: signal.reason,
    });
  }
}

function ancestors(value: string): string[] {
  const segments = value.split("/");
  const result: string[] = [];
  for (let index = 1; index < segments.length; index += 1) result.push(segments.slice(0, index).join("/"));
  return result;
}

/**
 * Walk one selected local source tree.
 *
 * Cache/dependency subtrees are skipped before `lstat`, so a warm workspace is
 * never read for content. Protected paths are counted but not hashed and never
 * sent. Source symlinks and special files are rejected: following them would
 * publish something the caller did not select.
 */
export async function scanSource(request: ScanRequest): Promise<SourceScan> {
  const root = path.resolve(request.root);
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

  const files: ManifestEntry[] = [];
  const directories: string[] = [];
  const skipped: SkippedEntry[] = [];
  let totalBytes = 0;
  let excluded = 0;
  let protectedCount = 0;

  const walk = async (relativeDir: string): Promise<void> => {
    checkAborted(request.signal, request.deadline);
    const absoluteDir = relativeDir.length === 0 ? root : path.join(root, ...relativeDir.split("/"));
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
      if (isExcluded(relativePath, request.policy)) {
        excluded += 1;
        skipped.push({ path: relativePath, reason: "cache" });
        continue;
      }
      const absolutePath = path.join(root, ...relativePath.split("/"));
      const stat = await fs.lstat(absolutePath);
      if (isProtected(relativePath, request.policy)) {
        protectedCount += 1;
        skipped.push({ path: relativePath, reason: "protected" });
        continue;
      }
      if (stat.isSymbolicLink()) {
        throw new NodeWorkspaceError(
          "symlink-rejected",
          `workspace contains a symlink at ${relativePath}; excluded dependency links must live in an excluded cache`,
        );
      }
      if (stat.isDirectory()) {
        assertSafeRelativePath(relativePath);
        if (files.length + directories.length >= request.limits.maxFiles) {
          throw new NodeWorkspaceError("limit-exceeded", `workspace exceeds the ${request.limits.maxFiles} entry limit`);
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
      if (!isSelected(relativePath, request.policy)) {
        skipped.push({ path: relativePath, reason: "unselected" });
        continue;
      }
      if (stat.size > request.limits.maxFileBytes) {
        throw new NodeWorkspaceError(
          "limit-exceeded",
          `${relativePath} is ${stat.size} bytes, above the per-file limit ${request.limits.maxFileBytes}`,
        );
      }
      if (files.length + directories.length >= request.limits.maxFiles) {
        throw new NodeWorkspaceError("limit-exceeded", `workspace exceeds the ${request.limits.maxFiles} entry limit`);
      }
      if (totalBytes + stat.size > request.limits.maxTotalBytes) {
        throw new NodeWorkspaceError(
          "limit-exceeded",
          `workspace exceeds the ${request.limits.maxTotalBytes} byte limit`,
        );
      }
      const hashed = await hashRegularFile(absolutePath);
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
  const neededDirectories = new Set<string>();
  for (const entry of sortedFiles) {
    for (const parent of ancestors(entry.path)) neededDirectories.add(parent);
  }
  for (const directory of directories) {
    if (isSelected(directory, request.policy)) neededDirectories.add(directory);
  }
  const sortedDirectories = [...neededDirectories].sort(comparePaths);
  return {
    root,
    files: sortedFiles,
    directories: sortedDirectories,
    totalBytes,
    treeDigest: treeDigest({ version: 1, files: sortedFiles, directories: sortedDirectories }),
    skipped,
    excluded,
    protectedCount,
  };
}

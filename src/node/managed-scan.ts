import fs from "node:fs/promises";
import path from "node:path";

import type { ManifestEntry } from "../digest.js";
import { NodeWorkspaceError, errorMessage, isErrno } from "../errors.js";
import { hashRegularFile } from "../file-hash.js";
import { assertSafeRelativePath } from "../paths.js";
import { isExcluded, isProtected, type ResolvedPolicy } from "../policy.js";

export interface ScanLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface ManagedScan {
  /** Every source entry the node holds, including untracked and unselected files. */
  readonly files: readonly ManifestEntry[];
  readonly directories: readonly string[];
  readonly totalBytes: number;
  readonly excluded: number;
  readonly protectedCount: number;
}

function checkDeadline(deadline: number, signal: AbortSignal | undefined): void {
  if (Date.now() > deadline) {
    throw new NodeWorkspaceError("timeout", "the node source scan exceeded its deadline");
  }
  if (signal?.aborted) {
    throw new NodeWorkspaceError("canceled", "the node source scan was canceled", {}, { cause: signal.reason });
  }
}

/**
 * Scan the node's managed source tree.
 *
 * Cache and dependency subtrees are skipped before `lstat`, so a warm Rust or
 * JavaScript workspace neither costs a full walk nor risks being mistaken for
 * managed source. Protected paths are counted but never hashed. The scan is
 * strict: a source symlink or special file aborts it.
 */
export async function scanManagedSource(
  root: string,
  policy: ResolvedPolicy,
  limits: ScanLimits,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<ManagedScan> {
  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { files: [], directories: [], totalBytes: 0, excluded: 0, protectedCount: 0 };
    }
    throw new NodeWorkspaceError("io", `cannot inspect ${root}: ${errorMessage(error)}`, {}, { cause: error });
  }
  if (rootStat.isSymbolicLink()) {
    throw new NodeWorkspaceError("symlink-rejected", `managed workspace must not be a symlink: ${root}`);
  }
  if (!rootStat.isDirectory()) {
    throw new NodeWorkspaceError("not-a-directory", `managed workspace is not a directory: ${root}`);
  }

  const files: ManifestEntry[] = [];
  const directories: string[] = [];
  let totalBytes = 0;
  let excluded = 0;
  let protectedCount = 0;

  const walk = async (relativeDir: string): Promise<void> => {
    checkDeadline(deadline, signal);
    const absoluteDir = relativeDir.length === 0 ? root : path.join(root, ...relativeDir.split("/"));
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch (error) {
      throw new NodeWorkspaceError("io", `cannot read ${absoluteDir}: ${errorMessage(error)}`, {}, { cause: error });
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      checkDeadline(deadline, signal);
      const relativePath = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;
      if (isExcluded(relativePath, policy)) {
        excluded += 1;
        continue;
      }
      const absolutePath = path.join(root, ...relativePath.split("/"));
      const stat = await fs.lstat(absolutePath);
      if (isProtected(relativePath, policy)) {
        protectedCount += 1;
        continue;
      }
      if (stat.isSymbolicLink()) {
        throw new NodeWorkspaceError(
          "symlink-rejected",
          `managed source contains a symlink at ${relativePath}; omitted dependency symlinks belong in an excluded cache`,
        );
      }
      if (stat.isDirectory()) {
        assertSafeRelativePath(relativePath);
        if (files.length + directories.length >= limits.maxFiles) {
          throw new NodeWorkspaceError("limit-exceeded", `workspace exceeds the ${limits.maxFiles} entry limit`);
        }
        directories.push(relativePath);
        await walk(relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new NodeWorkspaceError(
          "special-file-rejected",
          `managed source contains a non-regular entry at ${relativePath}`,
        );
      }
      assertSafeRelativePath(relativePath);
      if (stat.size > limits.maxFileBytes) {
        throw new NodeWorkspaceError(
          "limit-exceeded",
          `${relativePath} is ${stat.size} bytes, above the per-file limit ${limits.maxFileBytes}`,
        );
      }
      if (files.length + directories.length >= limits.maxFiles) {
        throw new NodeWorkspaceError("limit-exceeded", `workspace exceeds the ${limits.maxFiles} entry limit`);
      }
      if (totalBytes + stat.size > limits.maxTotalBytes) {
        throw new NodeWorkspaceError("limit-exceeded", `workspace exceeds the ${limits.maxTotalBytes} byte limit`);
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
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  directories.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return { files, directories, totalBytes, excluded, protectedCount };
}

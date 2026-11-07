import { minimatch } from "minimatch";

import { sha256Hex, type ManifestEntry } from "./digest.js";
import { NodeWorkspaceError } from "./errors.js";

export type ReturnOperationKind = "add" | "modify" | "chmod";

export interface ReturnOperation {
  readonly kind: ReturnOperationKind;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
  /** Local content the modification replaces; absent for add. */
  readonly baseSha256?: string;
}

export type ReturnConflictReason =
  | "local-modified"
  | "no-base"
  | "target-not-regular"
  | "target-is-directory"
  | "parent-not-directory";

export interface ReturnConflict {
  readonly path: string;
  readonly reason: ReturnConflictReason;
  readonly localSha256?: string;
  readonly baseSha256?: string;
  readonly nodeSha256?: string;
}

export interface ReturnRemoval {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ReturnCounts {
  readonly additions: number;
  readonly modifications: number;
  readonly modeChanges: number;
  readonly unchanged: number;
  readonly conflicts: number;
  readonly removed: number;
}

export interface ReturnPlan {
  readonly nodeId: string;
  readonly remotePath: string;
  readonly localPath: string;
  readonly treeDigest: string;
  readonly planDigest: string;
  readonly operations: readonly ReturnOperation[];
  readonly conflicts: readonly ReturnConflict[];
  readonly unchanged: readonly string[];
  readonly removed: readonly ReturnRemoval[];
  /** Missing local directories the apply step will create. */
  readonly directories: readonly string[];
  readonly counts: ReturnCounts;
}

export interface PlanInput {
  readonly nodeId: string;
  readonly remotePath: string;
  readonly localPath: string;
  readonly treeDigest: string;
  readonly nodeFiles: readonly ManifestEntry[];
  readonly nodeDirectories: readonly string[];
  /** Manifest of the last published generation, when the node has one. */
  readonly baseManifest: readonly ManifestEntry[] | undefined;
  readonly localFiles: ReadonlyMap<string, ManifestEntry>;
  readonly localDirectories: ReadonlySet<string>;
  /** Local entries a scan omitted because they are symlinks. */
  readonly localSymlinks: ReadonlySet<string>;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

function matches(patterns: readonly string[], relativePath: string): boolean {
  return patterns.some(
    (pattern) =>
      minimatch(relativePath, pattern, { dot: true }) || minimatch(relativePath, `${pattern}/**`, { dot: true }),
  );
}

export function selectedPath(
  relativePath: string,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  if (include.length > 0 && !matches(include, relativePath)) return false;
  if (exclude.length > 0 && matches(exclude, relativePath)) return false;
  return true;
}

function sortedByPath<T extends { readonly path: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

/**
 * Derive the exact local change set for one node directory.
 *
 * Pure: it reads no filesystem. The caller supplies the independent node
 * manifest, the local manifest, and the base manifest of the last publication.
 * A local file that differs from both the base and the node version is a
 * conflict, never a silent overwrite.
 */
export function buildReturnPlan(input: PlanInput): ReturnPlan {
  const base = new Map((input.baseManifest ?? []).map((entry) => [entry.path, entry]));
  const operations: ReturnOperation[] = [];
  const conflicts: ReturnConflict[] = [];
  const unchanged: string[] = [];

  for (const entry of sortedByPath(input.nodeFiles)) {
    if (!selectedPath(entry.path, input.include, input.exclude)) continue;
    const local = input.localFiles.get(entry.path);
    if (local === undefined) {
      if (input.localSymlinks.has(entry.path)) {
        conflicts.push({
          path: entry.path,
          reason: "target-not-regular",
          nodeSha256: entry.sha256,
        });
        continue;
      }
      operations.push({ kind: "add", path: entry.path, size: entry.size, sha256: entry.sha256, executable: entry.executable });
      continue;
    }
    if (local.size === entry.size && local.sha256 === entry.sha256) {
      if (local.executable === entry.executable) {
        unchanged.push(entry.path);
      } else {
        operations.push({
          kind: "chmod",
          path: entry.path,
          size: entry.size,
          sha256: entry.sha256,
          executable: entry.executable,
        });
      }
      continue;
    }
    const previous = base.get(entry.path);
    if (previous === undefined) {
      conflicts.push({
        path: entry.path,
        reason: "no-base",
        localSha256: local.sha256,
        nodeSha256: entry.sha256,
      });
      continue;
    }
    if (previous.sha256 !== local.sha256 || previous.size !== local.size) {
      conflicts.push({
        path: entry.path,
        reason: "local-modified",
        localSha256: local.sha256,
        baseSha256: previous.sha256,
        nodeSha256: entry.sha256,
      });
      continue;
    }
    operations.push({
      kind: "modify",
      path: entry.path,
      size: entry.size,
      sha256: entry.sha256,
      executable: entry.executable,
      baseSha256: previous.sha256,
    });
  }

  // A new file needs its parent chain. Only chains that are absent locally are
  // created; an existing file or symlink in that chain is a conflict.
  const localEntries = new Set<string>([
    ...input.localFiles.keys(),
    ...input.localDirectories,
    ...input.localSymlinks,
  ]);
  const directories = new Set<string>();
  const conflictedParents = new Set<string>();
  for (const operation of operations) {
    if (operation.kind === "chmod") continue;
    const segments = operation.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      if (input.localDirectories.has(parent)) continue;
      if (localEntries.has(parent)) {
        if (!conflictedParents.has(operation.path)) {
          conflicts.push({
            path: operation.path,
            reason: "parent-not-directory",
            nodeSha256: operation.sha256,
          });
          conflictedParents.add(operation.path);
        }
        break;
      }
      directories.add(parent);
    }
  }

  const nodePaths = new Set(input.nodeFiles.map((entry) => entry.path));
  const removed: ReturnRemoval[] = [];
  for (const entry of sortedByPath([...input.localFiles.values()])) {
    if (nodePaths.has(entry.path)) continue;
    if (!selectedPath(entry.path, input.include, input.exclude)) continue;
    removed.push({ path: entry.path, size: entry.size, sha256: entry.sha256 });
  }

  const sortedOperations = sortedByPath(operations);
  const sortedConflicts = sortedByPath(conflicts);
  const sortedRemoved = sortedByPath(removed);
  const sortedDirectories = [...directories].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  const planDigest = sha256Hex(
    JSON.stringify({
      version: 1,
      remotePath: input.remotePath,
      localPath: input.localPath,
      treeDigest: input.treeDigest,
      operations: sortedOperations,
      conflicts: sortedConflicts,
      removed: sortedRemoved,
      directories: sortedDirectories,
    }),
  );
  return {
    nodeId: input.nodeId,
    remotePath: input.remotePath,
    localPath: input.localPath,
    treeDigest: input.treeDigest,
    planDigest,
    operations: sortedOperations,
    conflicts: sortedConflicts,
    unchanged: [...unchanged].sort(),
    removed: sortedRemoved,
    directories: sortedDirectories,
    counts: {
      additions: sortedOperations.filter((entry) => entry.kind === "add").length,
      modifications: sortedOperations.filter((entry) => entry.kind === "modify").length,
      modeChanges: sortedOperations.filter((entry) => entry.kind === "chmod").length,
      unchanged: unchanged.length,
      conflicts: sortedConflicts.length,
      removed: sortedRemoved.length,
    },
  };
}

export function assertPlanApplicable(plan: ReturnPlan): void {
  if (plan.conflicts.length > 0) {
    throw new NodeWorkspaceError(
      "local-conflict",
      `the return plan has ${plan.conflicts.length} conflict(s); resolve them, then request a fresh preview. ` +
        "Nothing was written.",
      { conflicts: plan.conflicts.length },
    );
  }
}

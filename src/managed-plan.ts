import { sha256Hex, type ManifestEntry } from "./digest.js";
import { NodeWorkspaceError } from "./errors.js";
import { comparePaths } from "./digest.js";
import { isSelected, policyEquals, type ResolvedPolicy } from "./policy.js";

export type PlanKind = "add" | "change" | "delete" | "mode" | "restore";

export type ConflictReason =
  | "node-modified"
  | "node-missing"
  | "node-missing-local-changed"
  | "untracked"
  | "type-collision"
  | "parent-not-directory"
  | "released-path"
  | "adoption-required"
  | "adoption-collision"
  | "invalid-path";

export interface PlanEntry {
  readonly kind: PlanKind;
  readonly path: string;
  /** The managed bytes this entry replaces; null for an add. */
  readonly before: ManifestEntry | null;
  /** The bytes that must exist after the entry; null for a delete. */
  readonly after: ManifestEntry | null;
}

export interface PlanConflict {
  readonly path: string;
  readonly reason: ConflictReason;
}

export interface ReleasedEntry {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly executable: boolean;
  readonly releasedAt: string;
  readonly revision: number;
}

export interface PlanCounts {
  readonly add: number;
  readonly change: number;
  readonly delete: number;
  readonly mode: number;
  readonly restore: number;
  readonly conflicts: number;
  readonly unchanged: number;
  readonly untracked: number;
  readonly released: number;
}

export interface ManagedPlanInput {
  readonly remotePath: string;
  readonly localProject: string;
  readonly baseRevision: number;
  readonly recordExists: boolean;
  readonly baseManifest: readonly ManifestEntry[] | undefined;
  readonly localFiles: readonly ManifestEntry[];
  readonly localDirectories: readonly string[];
  readonly nodeFiles: readonly ManifestEntry[];
  readonly nodeDirectories: readonly string[];
  readonly policy: ResolvedPolicy;
  readonly previousPolicy: ResolvedPolicy | undefined;
  readonly released: readonly ReleasedEntry[];
  readonly adopt: boolean;
  readonly adoptPaths: readonly string[];
  readonly restore: readonly string[];
}

export interface ManagedPlan {
  readonly remotePath: string;
  readonly baseRevision: number;
  readonly entries: readonly PlanEntry[];
  readonly conflicts: readonly PlanConflict[];
  /** Base paths that are absent on the node but equal locally; explicit restore candidates. */
  readonly restorable: readonly string[];
  readonly releasedAfter: readonly ReleasedEntry[];
  readonly directories: readonly string[];
  readonly counts: PlanCounts;
  readonly createRequired: boolean;
  readonly adoptRequired: boolean;
  readonly policyChanged: boolean;
  /** True when apply may run without a pinned preview. */
  readonly safeForRoutine: boolean;
  readonly digest: string;
}

function byPath<T extends { readonly path: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => comparePaths(left.path, right.path));
}

export function entryEqual(
  left: ManifestEntry | undefined,
  right: ManifestEntry | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.size === right.size && left.sha256 === right.sha256 && left.executable === right.executable;
}

function ancestry(path: string): string[] {
  const segments = path.split("/");
  const parents: string[] = [];
  for (let index = 1; index < segments.length; index += 1) parents.push(segments.slice(0, index).join("/"));
  return parents;
}

function duplicate(path: string): never {
  throw new NodeWorkspaceError("invalid-manifest", `the local source repeats ${path}`);
}

/**
 * Derive the exact managed source diff.
 *
 * Pure: no filesystem access. The caller supplies the persisted base (last
 * committed manifest), the independently scanned node state, and the selected
 * local manifest. A node file that differs from the base blocks every write;
 * it is never silently overwritten or deleted.
 */
export function buildManagedPlan(input: ManagedPlanInput): ManagedPlan {
  const base = new Map((input.baseManifest ?? []).map((entry) => [entry.path, entry]));
  const adoptPaths = new Set(input.adoptPaths);
  const restoreAuthorized = new Set(input.restore);
  const released = new Map(input.released.map((entry) => [entry.path, entry]));
  const entries: PlanEntry[] = [];
  const conflicts: PlanConflict[] = [];
  const restorable: string[] = [];
  const releasedAfter = new Map<string, ReleasedEntry>();
  const neededDirectories = new Set<string>();
  let unchanged = 0;
  let untracked = 0;

  const nodeFiles = new Map(input.nodeFiles.map((entry) => [entry.path, entry]));
  const localFiles = new Map(input.localFiles.map((entry) => [entry.path, entry]));
  if (localFiles.size !== input.localFiles.length) duplicate("a local path");
  const nodeDirectories = new Set(input.nodeDirectories);
  const localDirectories = new Set(input.localDirectories);

  const addConflict = (path: string, reason: ConflictReason): void => {
    conflicts.push({ path, reason });
  };

  const parentBlocked = (path: string): boolean => {
    for (const parent of ancestry(path)) {
      if (nodeFiles.has(parent)) {
        addConflict(path, "parent-not-directory");
        return true;
      }
    }
    return false;
  };

  const requireDirectories = (path: string): void => {
    for (const parent of ancestry(path)) {
      if (nodeDirectories.has(parent) || nodeFiles.has(parent)) continue;
      neededDirectories.add(parent);
    }
  };

  // Paths that were managed and are no longer selected are released, never
  // deleted. The node copy stays; provenance is kept for an explicit re-adopt.
  for (const [path, entry] of base) {
    if (isSelected(path, input.policy)) continue;
    releasedAfter.set(path, {
      path,
      sha256: entry.sha256,
      size: entry.size,
      executable: entry.executable,
      releasedAt: new Date().toISOString(),
      revision: input.baseRevision,
    });
  }
  for (const [path, entry] of released) {
    if (isSelected(path, input.policy) && !localFiles.has(path) && !base.has(path)) continue;
    releasedAfter.set(path, releasedAfter.get(path) ?? entry);
  }

  // Existing base paths.
  for (const [path, before] of base) {
    if (!isSelected(path, input.policy)) continue;
    const node = nodeFiles.get(path);
    const local = localFiles.get(path);
    const localUnchanged = entryEqual(local, before);
    const nodeUnchanged = entryEqual(node, before);

    if (local === undefined) {
      if (node === undefined) continue;
      if (nodeUnchanged) {
        entries.push({ kind: "delete", path, before, after: null });
      } else {
        addConflict(path, "node-modified");
      }
      continue;
    }

    if (node === undefined) {
      if (!localUnchanged) {
        addConflict(path, "node-missing-local-changed");
        continue;
      }
      if (restoreAuthorized.has(path)) {
        entries.push({ kind: "restore", path, before, after: local });
      } else {
        restorable.push(path);
        addConflict(path, "node-missing");
      }
      continue;
    }

    if (localUnchanged && nodeUnchanged) {
      unchanged += 1;
      continue;
    }
    if (entryEqual(node, local)) {
      // The node already holds the selected bytes. Adopt them as the base
      // without rewriting the file (and without claiming a content change).
      unchanged += 1;
      continue;
    }
    if (!nodeUnchanged && !localUnchanged) {
      addConflict(path, "node-modified");
      continue;
    }
    if (!nodeUnchanged) {
      // Node drifted but the selected local bytes still equal the base. The
      // node edit wins until an operator retrieves or discards it.
      addConflict(path, "node-modified");
      continue;
    }
    if (local.size === before.size && local.sha256 === before.sha256 && local.executable !== before.executable) {
      entries.push({ kind: "mode", path, before, after: local });
      continue;
    }
    entries.push({ kind: "change", path, before, after: local });
  }

  // Selected local paths that the base does not know yet.
  for (const [path, local] of localFiles) {
    if (base.has(path)) continue;
    if (nodeDirectories.has(path)) {
      addConflict(path, "type-collision");
      continue;
    }
    if (parentBlocked(path)) continue;
    const previousRelease = released.get(path);
    const node = nodeFiles.get(path);
    if (previousRelease !== undefined) {
      if (!adoptPaths.has(path)) {
        addConflict(path, "released-path");
        continue;
      }
      releasedAfter.delete(path);
      if (node !== undefined) {
        if (entryEqual(node, local)) {
          unchanged += 1;
        } else {
          addConflict(path, "adoption-collision");
        }
        continue;
      }
      requireDirectories(path);
      entries.push({ kind: "add", path, before: null, after: local });
      continue;
    }
    if (node !== undefined) {
      if (input.adopt) {
        if (entryEqual(node, local)) {
          unchanged += 1;
        } else {
          addConflict(path, "adoption-collision");
        }
        continue;
      }
      addConflict(path, "untracked");
      continue;
    }
    requireDirectories(path);
    entries.push({ kind: "add", path, before: null, after: local });
  }

  // Local directories that collide with a node file cannot be created.
  for (const directory of localDirectories) {
    if (nodeFiles.has(directory) && !localFiles.has(directory)) {
      addConflict(directory, "type-collision");
    }
  }

  // Node entries outside the base are untracked and preserved. They only
  // become a conflict when the selected local source wants the same path
  // (handled above).
  for (const path of nodeFiles.keys()) {
    if (!base.has(path)) untracked += 1;
  }

  const policyChanged =
    input.previousPolicy !== undefined && !policyEquals(input.policy, input.previousPolicy);
  const adoptRequired = !input.recordExists && untracked > 0 && !input.adopt;
  if (adoptRequired) addConflict(input.remotePath, "adoption-required");

  const createRequired = !input.recordExists && untracked === 0;
  const sortedEntries = byPath(entries);
  const sortedConflicts = byPath(conflicts);
  const sortedRestorable = [...restorable].sort(comparePaths);
  const sortedReleased = byPath([...releasedAfter.values()]);
  const sortedDirectories = [...neededDirectories].sort(comparePaths);

  const counts: PlanCounts = {
    add: sortedEntries.filter((entry) => entry.kind === "add").length,
    change: sortedEntries.filter((entry) => entry.kind === "change").length,
    delete: sortedEntries.filter((entry) => entry.kind === "delete").length,
    mode: sortedEntries.filter((entry) => entry.kind === "mode").length,
    restore: sortedEntries.filter((entry) => entry.kind === "restore").length,
    conflicts: sortedConflicts.length,
    unchanged,
    untracked,
    released: sortedReleased.length,
  };

  const digest = sha256Hex(
    JSON.stringify({
      version: 2,
      remotePath: input.remotePath,
      localProject: input.localProject,
      baseRevision: input.baseRevision,
      policy: input.policy,
      entries: sortedEntries,
      conflicts: sortedConflicts,
      restorable: sortedRestorable,
      released: sortedReleased.map((entry) => ({
        path: entry.path,
        sha256: entry.sha256,
        size: entry.size,
        executable: entry.executable,
        revision: entry.revision,
      })),
      directories: sortedDirectories,
      createRequired,
      adoptRequired,
      policyChanged,
    }),
  );

  return {
    remotePath: input.remotePath,
    baseRevision: input.baseRevision,
    entries: sortedEntries,
    conflicts: sortedConflicts,
    restorable: sortedRestorable,
    releasedAfter: sortedReleased,
    directories: sortedDirectories,
    counts,
    createRequired,
    adoptRequired,
    policyChanged,
    safeForRoutine:
      sortedConflicts.length === 0 &&
      counts.delete === 0 &&
      counts.restore === 0 &&
      !createRequired &&
      !adoptRequired &&
      !policyChanged &&
      input.adoptPaths.length === 0,
    digest,
  };
}

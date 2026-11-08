import fs from "node:fs/promises";
import path from "node:path";

import { NodeWorkspaceError, errorMessage } from "../errors.js";
import { isWithin } from "../paths.js";

/**
 * The local directory one Gateway call may read from or write into.
 *
 * OpenClaw resolves a workspace per session and passes it to the tool factory.
 * That workspace, not a plugin-configured list, is the authority: a path is
 * accepted only when it resolves inside it. `gateway.*` roots cannot widen the
 * boundary; when an operator sets them they can only narrow it further.
 */
export interface WorkspaceBoundary {
  /** Real, absolute path of the session workspace. */
  readonly root: string;
}

/**
 * Resolve the host-provided workspace into a boundary.
 *
 * Fails closed: a call without a workspace is refused before any filesystem
 * access, because falling back to the process working directory would grant
 * authority the host never delegated.
 */
export async function resolveWorkspaceBoundary(
  workspaceRoot: string | undefined,
  operation: string,
): Promise<WorkspaceBoundary> {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new NodeWorkspaceError(
      "workspace-unresolved",
      `the host resolved no workspace directory for this session; refusing to ${operation}`,
    );
  }
  if (workspaceRoot.includes("\0")) {
    throw new NodeWorkspaceError("path-invalid", "workspace directory must not contain a NUL byte");
  }
  const declared = path.isAbsolute(workspaceRoot) ? workspaceRoot : path.resolve(workspaceRoot);
  let real: string;
  try {
    real = await fs.realpath(declared);
  } catch (error) {
    throw new NodeWorkspaceError(
      "path-not-found",
      `workspace directory does not exist: ${declared}`,
      {},
      { cause: error },
    );
  }
  let stat;
  try {
    stat = await fs.lstat(real);
  } catch (error) {
    throw new NodeWorkspaceError(
      "io",
      `cannot inspect the workspace directory ${real}: ${errorMessage(error)}`,
      {},
      { cause: error },
    );
  }
  if (!stat.isDirectory()) {
    throw new NodeWorkspaceError("not-a-directory", `workspace is not a directory: ${real}`);
  }
  return { root: real };
}

/** True when `candidate` is the workspace itself or lies below it. */
export function isInsideWorkspace(boundary: WorkspaceBoundary, candidate: string): boolean {
  return isWithin(boundary.root, candidate);
}

async function realDirectories(roots: readonly string[]): Promise<string[]> {
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

/** True when no narrowing is configured, or `candidate` is inside one entry. */
export async function isInsideNarrowing(roots: readonly string[], candidate: string): Promise<boolean> {
  if (roots.length === 0) return true;
  const resolved = await realDirectories(roots);
  return resolved.some((root) => isWithin(root, candidate));
}

/**
 * Authorize one already-resolved local path.
 *
 * `candidate` must be a real path (the caller resolves symlinks first). The
 * boundary decides first and names the workspace on refusal; the optional
 * narrowing list is checked second, so an operator can tighten the workspace
 * without being able to widen it.
 */
export async function assertLocalAccess(
  boundary: WorkspaceBoundary,
  candidate: string,
  what: string,
  narrowing: readonly string[],
  narrowingLabel: string,
): Promise<void> {
  if (!isInsideWorkspace(boundary, candidate)) {
    throw new NodeWorkspaceError(
      "path-outside-root",
      `${what} ${candidate} is outside the session workspace ${boundary.root}`,
    );
  }
  if (!(await isInsideNarrowing(narrowing, candidate))) {
    throw new NodeWorkspaceError(
      "path-outside-root",
      `${what} ${candidate} is outside every configured ${narrowingLabel} entry`,
    );
  }
}

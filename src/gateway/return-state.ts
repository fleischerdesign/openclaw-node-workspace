import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ManifestEntry } from "../digest.js";
import { isErrno } from "../errors.js";
import { RETURN_STATE_FILE, assertSafeRelativePath } from "../paths.js";
import { parseManifestEntry } from "../protocol.js";

const RETURN_STATE_MAX_BYTES = 4 * 1024 * 1024;
const RETURN_STATE_MAX_BASES = 32;

interface ReturnBaseState {
  readonly nodeId: string;
  readonly remotePath: string;
  readonly treeDigest: string;
  readonly files: readonly ManifestEntry[];
  readonly updatedAt: string;
}

interface ReturnStateFile {
  readonly version: 1;
  readonly bases: Record<string, ReturnBaseState>;
}

/** A node identity and absolute path are both required for a baseline. */
function stateKey(nodeId: string, remotePath: string): string {
  return JSON.stringify([nodeId, remotePath]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseState(raw: unknown): ReturnStateFile | undefined {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.bases)) return undefined;
  const bases: Record<string, ReturnBaseState> = {};
  for (const [key, value] of Object.entries(raw.bases)) {
    if (!isRecord(value)) return undefined;
    if (typeof value.nodeId !== "string" || typeof value.remotePath !== "string") return undefined;
    if (typeof value.treeDigest !== "string" || !Array.isArray(value.files)) return undefined;
    if (typeof value.updatedAt !== "string") return undefined;
    const files: ManifestEntry[] = [];
    try {
      for (const candidate of value.files) {
        const parsed = parseManifestEntry(candidate);
        assertSafeRelativePath(parsed.path, "return state path");
        files.push(parsed);
      }
    } catch {
      return undefined;
    }
    bases[key] = {
      nodeId: value.nodeId,
      remotePath: value.remotePath,
      treeDigest: value.treeDigest,
      files,
      updatedAt: value.updatedAt,
    };
  }
  return { version: 1, bases };
}

/**
 * Read the local record of the last content reconciled with one node path.
 *
 * The key is `nodeId + remotePath`: two nodes that happen to use the same
 * absolute path must never share a conflict base. An unreadable, malformed or
 * foreign file is ignored, so the caller falls back to a stricter base.
 */
export async function readReturnState(
  root: string,
  nodeId: string,
  remotePath: string,
): Promise<readonly ManifestEntry[] | undefined> {
  try {
    const statePath = path.join(root, RETURN_STATE_FILE);
    const stat = await fs.lstat(statePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > RETURN_STATE_MAX_BYTES) return undefined;
    const parsed = parseState(JSON.parse(await fs.readFile(statePath, "utf8")));
    if (!parsed) return undefined;
    return parsed.bases[stateKey(nodeId, remotePath)]?.files;
  } catch {
    return undefined;
  }
}

/**
 * Record the node content this operation reconciled for one node and path.
 *
 * A regular file that is not valid plugin state is left untouched and reported
 * as `false`; the baseline never overwrites a user file. Entries that are no
 * longer in the live tree or the publication manifest are pruned.
 */
export async function writeReturnState(
  root: string,
  nodeId: string,
  remotePath: string,
  treeDigest: string,
  files: readonly ManifestEntry[],
  keepPaths: ReadonlySet<string>,
): Promise<boolean> {
  const statePath = path.join(root, RETURN_STATE_FILE);
  try {
    const existing = await fs.lstat(statePath).catch((error: unknown) => {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    });
    if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile())) return false;
    let state: ReturnStateFile = { version: 1, bases: {} };
    if (existing !== undefined) {
      if (existing.size > RETURN_STATE_MAX_BYTES) return false;
      const parsed = parseState(JSON.parse(await fs.readFile(statePath, "utf8")));
      if (!parsed) return false;
      state = parsed;
    }
    const key = stateKey(nodeId, remotePath);
    const previous = (state.bases[key]?.files ?? []).filter((entry) => keepPaths.has(entry.path));
    const merged = new Map(previous.map((entry) => [entry.path, entry]));
    for (const entry of files) merged.set(entry.path, entry);
    const bases: Record<string, ReturnBaseState> = {
      ...state.bases,
      [key]: {
        nodeId,
        remotePath,
        treeDigest,
        files: [...merged.values()].sort((left, right) =>
          Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
        ),
        updatedAt: new Date().toISOString(),
      },
    };
    const ordered = Object.entries(bases)
      .sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt))
      .slice(0, RETURN_STATE_MAX_BASES);
    const body = JSON.stringify({ version: 1, bases: Object.fromEntries(ordered) }, null, 2) + "\n";
    if (Buffer.byteLength(body, "utf8") > RETURN_STATE_MAX_BYTES) return false;
    const temp = path.join(root, `.nodews-return-state-${randomUUID()}.tmp`);
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, statePath);
    return true;
  } catch {
    return false;
  }
}

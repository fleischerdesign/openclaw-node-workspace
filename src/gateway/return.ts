import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { GatewayConfig } from "../config.js";
import { NodeWorkspaceError, errorMessage, isErrno } from "../errors.js";
import { scanWorkspace } from "../manifest.js";
import { isWithin, normalizeAbsolutePosixPath } from "../paths.js";
import { COMMAND_RETURN, PROTOCOL_VERSION } from "../protocol.js";
import { fsyncDirectory } from "../node/fs-atomic.js";
import {
  assertControlFrame,
  controlType,
  FrameSession,
  resolveNodeId,
  type NodeTransport,
} from "../transport.js";
import { buildReturnPlan, assertPlanApplicable, type ReturnPlan, type ReturnOperation } from "../return-plan.js";
import { readNodeTree, type NodeTreeOutcome } from "./tree.js";

export interface ReturnPreviewInput {
  readonly node: string;
  readonly remotePath: string;
  readonly localPath: string;
  readonly include: readonly string[] | undefined;
  readonly exclude: readonly string[] | undefined;
  readonly signal: AbortSignal | undefined;
}

export interface ReturnPreview {
  readonly plan: ReturnPlan;
  readonly tree: NodeTreeOutcome;
}

export interface ReturnApplyInput extends ReturnPreviewInput {
  readonly planDigest: string;
  readonly progress: ((progress: ReturnProgress) => void) | undefined;
  readonly signal: AbortSignal | undefined;
}

export interface ReturnProgress {
  readonly phase: "scanning" | "receiving" | "applying" | "publishing";
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly bytesDone: number;
  readonly bytesTotal: number;
}

export interface ReturnOutcome {
  readonly nodeId: string;
  readonly localPath: string;
  readonly treeDigest: string;
  readonly planDigest: string;
  readonly applied: readonly { readonly path: string; readonly kind: ReturnOperation["kind"] }[];
  readonly unchanged: number;
  readonly removedOnNode: readonly string[];
  readonly bytesTransferred: number;
  readonly durationMs: number;
}

async function realRoots(roots: readonly string[]): Promise<string[]> {
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

/**
 * Resolve the local project directory a return may write into.
 *
 * The target must already exist as a real directory inside a configured
 * `gateway.returnRoots` entry. The plugin never creates the project root
 * itself, so a typo cannot invent a tree outside the operator's intent.
 */
async function resolveLocalTarget(
  localPath: string,
  config: GatewayConfig,
): Promise<{ directory: string; root: string }> {
  if (config.returnRoots.length === 0) {
    throw new NodeWorkspaceError(
      "config-invalid",
      "gateway.returnRoots is empty; configure at least one absolute directory before returning a project tree",
    );
  }
  const normalized = normalizeAbsolutePosixPath(localPath);
  let stat;
  try {
    stat = await fs.lstat(normalized);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new NodeWorkspaceError("path-not-found", `local project directory does not exist: ${normalized}`);
    }
    throw new NodeWorkspaceError("io", `cannot inspect ${normalized}: ${errorMessage(error)}`, {}, { cause: error });
  }
  if (stat.isSymbolicLink()) {
    throw new NodeWorkspaceError("symlink-rejected", "the local project directory must not be a symlink");
  }
  if (!stat.isDirectory()) {
    throw new NodeWorkspaceError("not-a-directory", `local target is not a directory: ${normalized}`);
  }
  const real = await fs.realpath(normalized);
  const roots = await realRoots(config.returnRoots);
  const match = roots.find((root) => isWithin(root, real));
  if (match === undefined) {
    throw new NodeWorkspaceError(
      "path-outside-root",
      `local target ${real} is outside every configured gateway.returnRoots entry`,
    );
  }
  return { directory: real, root: match };
}

async function digestFile(absolutePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(absolutePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Compute what returning one node directory would change locally.
 *
 * The node manifest and the local manifest are independent scans. A file that
 * differs from the last published generation and from the node copy is a
 * conflict. Nothing is written by this function.
 */
export async function previewReturn(
  transport: NodeTransport,
  config: GatewayConfig,
  input: ReturnPreviewInput,
): Promise<ReturnPreview> {
  const nodeId = await resolveNodeId(transport, input.node);
  const local = await resolveLocalTarget(input.localPath, config);
  const remotePath = normalizeAbsolutePosixPath(input.remotePath);
  const tree = await readNodeTree(transport, config, {
    node: nodeId,
    remotePath,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const deadline = Date.now() + config.timeoutMs;
  const localScan = await scanWorkspace({
    root: local.directory,
    exclude: [...config.exclude, ...(input.exclude ?? []), RETURN_STAGING_PATTERN],
    symlinks: "skip",
    maxFiles: config.maxFiles,
    maxFileBytes: config.maxFileBytes,
    maxTotalBytes: config.maxTotalBytes,
    signal: input.signal,
    deadline,
  });
  const baseManifest =
    tree.marker !== null && tree.marker.state === "complete" && tree.marker.manifest !== undefined
      ? tree.marker.manifest
      : undefined;
  const plan = buildReturnPlan({
    nodeId,
    remotePath,
    localPath: local.directory,
    treeDigest: tree.treeDigest,
    nodeFiles: tree.files,
    nodeDirectories: tree.directories,
    baseManifest,
    localFiles: new Map(localScan.files.map((entry) => [entry.path, entry])),
    localDirectories: new Set(localScan.directories),
    localSymlinks: new Set(localScan.skipped.filter((entry) => entry.reason === "symlink").map((entry) => entry.path)),
    include: input.include ?? [],
    exclude: [...config.exclude, ...(input.exclude ?? [])],
  });
  return { plan, tree };
}

const RETURN_STAGING_PATTERN = "**/.nodews-return-*";

function targetPath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

async function lstatOrUndefined(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw new NodeWorkspaceError("io", `cannot inspect ${target}: ${errorMessage(error)}`, {}, { cause: error });
  }
}

/** Every existing component between the root and the parent must be a real directory. */
async function assertRealParent(root: string, relativePath: string): Promise<void> {
  const segments = relativePath.split("/");
  segments.pop();
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await lstatOrUndefined(current);
    if (stat === undefined) return;
    if (stat.isSymbolicLink()) {
      throw new NodeWorkspaceError("local-conflict", `parent is a symlink: ${relativePath}`);
    }
    if (!stat.isDirectory()) {
      throw new NodeWorkspaceError("local-conflict", `parent is not a directory: ${relativePath}`);
    }
  }
}

async function preflight(
  root: string,
  plan: ReturnPlan,
  staged: ReadonlyMap<string, { readonly size: number; readonly sha256: string; readonly executable: boolean }>,
): Promise<void> {
  for (const operation of plan.operations) {
    const target = targetPath(root, operation.path);
    await assertRealParent(root, operation.path);
    const stat = await lstatOrUndefined(target);
    if (operation.kind === "add") {
      if (stat !== undefined) {
        throw new NodeWorkspaceError(
          "local-conflict",
          `a file appeared at ${operation.path} after the preview; nothing was written. Request a new preview.`,
        );
      }
      const entry = staged.get(operation.path);
      if (!entry) throw new NodeWorkspaceError("protocol", `missing staged file for ${operation.path}`);
      continue;
    }
    if (stat === undefined) {
      throw new NodeWorkspaceError(
        "local-conflict",
        `${operation.path} disappeared after the preview; nothing was written. Request a new preview.`,
      );
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new NodeWorkspaceError("local-conflict", `${operation.path} is not a regular file`);
    }
    if (operation.kind === "modify") {
      const current = await digestFile(target);
      if (current !== operation.baseSha256) {
        throw new NodeWorkspaceError(
          "local-conflict",
          `${operation.path} changed after the preview; nothing was written. Request a new preview.`,
        );
      }
    }
  }
}

type Applied =
  | { readonly kind: "add"; readonly path: string }
  | { readonly kind: "modify"; readonly path: string; readonly backup: string }
  | { readonly kind: "chmod"; readonly path: string; readonly mode: number };

async function rollback(
  root: string,
  applied: readonly Applied[],
  createdDirectories: readonly string[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const entry of [...applied].reverse()) {
    const target = targetPath(root, entry.path);
    try {
      if (entry.kind === "add") {
        await fs.rm(target, { force: true });
      } else if (entry.kind === "modify") {
        await fs.rename(entry.backup, target);
      } else {
        await fs.chmod(target, entry.mode);
      }
    } catch (error) {
      failures.push(`${entry.path}: ${errorMessage(error)}`);
    }
  }
  for (const directory of [...createdDirectories].reverse()) {
    await fs.rmdir(directory).catch((error: unknown) => {
      if (!isErrno(error, "ENOENT", "ENOTEMPTY", "EEXIST")) {
        failures.push(`${directory}: ${errorMessage(error)}`);
      }
    });
  }
  return failures;
}

interface StagedFile {
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
  readonly absolute: string;
}

async function publishExclusive(source: string, destination: string): Promise<void> {
  try {
    await fs.link(source, destination);
    return;
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new NodeWorkspaceError("local-conflict", `destination appeared during return: ${destination}`);
    }
    if (!isErrno(error, "EPERM", "ENOTSUP", "EXDEV", "EOPNOTSUPP")) {
      throw new NodeWorkspaceError("io", `cannot publish ${destination}: ${errorMessage(error)}`, {}, { cause: error });
    }
  }
  try {
    await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new NodeWorkspaceError("local-conflict", `destination appeared during return: ${destination}`);
    }
    throw new NodeWorkspaceError("io", `cannot publish ${destination}: ${errorMessage(error)}`, {}, { cause: error });
  }
}

async function applyStaged(
  root: string,
  plan: ReturnPlan,
  staged: ReadonlyMap<string, StagedFile>,
  stagingDirectory: string,
): Promise<string[]> {
  await preflight(root, plan, staged);
  const applied: Applied[] = [];
  const createdDirectories: string[] = [];
  try {
    for (const relative of plan.directories) {
      const directory = targetPath(root, relative);
      try {
        await fs.mkdir(directory, { mode: 0o700 });
        createdDirectories.push(directory);
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        const stat = await fs.lstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new NodeWorkspaceError("local-conflict", `directory path is not a real directory: ${relative}`);
        }
      }
    }
    for (const operation of plan.operations) {
      const target = targetPath(root, operation.path);
      if (operation.kind === "chmod") {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new NodeWorkspaceError("local-conflict", `${operation.path} is no longer a regular file`);
        }
        const previousMode = stat.mode & 0o777;
        await fs.chmod(target, operation.executable ? 0o700 : 0o600);
        applied.push({ kind: "chmod", path: operation.path, mode: previousMode });
        continue;
      }
      const entry = staged.get(operation.path);
      if (!entry) throw new NodeWorkspaceError("protocol", `missing staged file for ${operation.path}`);
      if (operation.kind === "add") {
        await publishExclusive(entry.absolute, target);
        applied.push({ kind: "add", path: operation.path });
        await fs.chmod(target, operation.executable ? 0o700 : 0o600);
        continue;
      }
      // Modify: keep a private backup inside the staging directory, re-check
      // the local content, then replace atomically on the same filesystem.
      const backup = path.join(stagingDirectory, `.backup-${applied.length}-${randomUUID()}`);
      await fs.copyFile(target, backup);
      if ((await digestFile(target)) !== operation.baseSha256) {
        await fs.rm(backup, { force: true });
        throw new NodeWorkspaceError(
          "local-conflict",
          `${operation.path} changed immediately before it was replaced; nothing was overwritten`,
        );
      }
      await fs.rename(entry.absolute, target);
      applied.push({ kind: "modify", path: operation.path, backup });
      await fs.chmod(target, operation.executable ? 0o700 : 0o600);
    }
    return [];
  } catch (error) {
    const failures = await rollback(root, applied, createdDirectories);
    if (failures.length > 0) {
      throw new NodeWorkspaceError(
        "io",
        `${errorMessage(error)}; rollback also failed for ${failures.length} path(s): ${failures.join("; ")}. ` +
          "Inspect the project and request a fresh preview.",
        { partial: true, rollbackFailures: failures.length },
        { cause: error },
      );
    }
    throw error;
  }
}

function nodeFailure(value: Record<string, unknown>): NodeWorkspaceError {
  const code = typeof value.code === "string" ? value.code : "node-rejected";
  const message = typeof value.message === "string" ? value.message : "the node rejected the return";
  return new NodeWorkspaceError(code as NodeWorkspaceError["code"], message);
}

/**
 * Apply one previewed return.
 *
 * Files are streamed into a private staging directory first, verified, then
 * applied with conflict re-checks and rollback. A disconnect during the stream
 * therefore leaves no local change: the destination tree is only touched after
 * the node's `end` frame and the local digest checks pass.
 */
export async function applyReturn(
  transport: NodeTransport,
  config: GatewayConfig,
  input: ReturnApplyInput,
): Promise<ReturnOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + config.timeoutMs;
  const remaining = (): number => {
    const left = deadline - Date.now();
    if (left <= 0) throw new NodeWorkspaceError("timeout", "the return exceeded its time limit");
    return left;
  };
  input.progress?.({ phase: "scanning", filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
  const preview = await previewReturn(transport, config, input);
  if (preview.plan.planDigest !== input.planDigest) {
    throw new NodeWorkspaceError(
      "plan-stale",
      "the node tree or the local project changed since the preview; request a new preview. Nothing was written.",
      { planDigest: preview.plan.planDigest },
    );
  }
  assertPlanApplicable(preview.plan);
  const plan = preview.plan;
  const root = plan.localPath;
  const streamed = plan.operations.filter((entry) => entry.kind !== "chmod");
  const bytesTotal = streamed.reduce((total, entry) => total + entry.size, 0);

  if (plan.operations.length === 0) {
    return {
      nodeId: plan.nodeId,
      localPath: root,
      treeDigest: plan.treeDigest,
      planDigest: plan.planDigest,
      applied: plan.operations.map((entry) => ({ path: entry.path, kind: entry.kind })),
      unchanged: plan.counts.unchanged,
      removedOnNode: plan.removed.map((entry) => entry.path),
      bytesTransferred: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const stagingDirectory = path.join(root, `.nodews-return-${randomUUID()}`);
  let session: FrameSession | undefined;
  const staged = new Map<string, StagedFile>();
  let appliedModes: string[] = [];
  try {
    await fs.mkdir(stagingDirectory, { mode: 0o700 });
    const channel = await transport.openDuplex({
      nodeId: plan.nodeId,
      command: COMMAND_RETURN,
      timeoutMs: config.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    session = FrameSession.openSync(channel);
    await session.sendControl({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      remotePath: plan.remotePath,
      paths: streamed.map((entry) => entry.path),
      treeDigest: plan.treeDigest,
      planDigest: plan.planDigest,
    });

    for (;;) {
      const frame = await session.next(remaining());
      if (frame.kind === "data") {
        throw new NodeWorkspaceError("protocol", "the node sent file data before accepting the return");
      }
      const value = assertControlFrame(frame);
      const type = controlType(value);
      if (type === "progress") continue;
      if (type === "rejected" || type === "return-error") throw nodeFailure(value);
      if (type !== "accepted") {
        throw new NodeWorkspaceError("protocol", `unexpected control frame ${JSON.stringify(type)} before return acceptance`);
      }
      break;
    }

    let bytesDone = 0;
    let filesDone = 0;
    for (const expected of streamed) {
      const header = await session.next(remaining());
      if (header.kind === "data") {
        throw new NodeWorkspaceError("protocol", "the node sent file data without a file header");
      }
      const value = assertControlFrame(header);
      if (controlType(value) !== "file") {
        if (controlType(value) === "return-error") throw nodeFailure(value);
        throw new NodeWorkspaceError("protocol", "expected a file header from the node");
      }
      if (
        value.path !== expected.path ||
        value.size !== expected.size ||
        value.sha256 !== expected.sha256 ||
        value.executable !== expected.executable
      ) {
        throw new NodeWorkspaceError("integrity", `the node announced an unexpected version of ${expected.path}`);
      }
      const absolute = path.join(stagingDirectory, ...expected.path.split("/"));
      await fs.mkdir(path.dirname(absolute), { mode: 0o700, recursive: true });
      const handle = await fs.open(absolute, "wx", 0o600);
      const hash = createHash("sha256");
      let received = 0;
      try {
        while (received < expected.size) {
          if (input.signal?.aborted) throw new NodeWorkspaceError("canceled", "the return was canceled");
          const frame = await session.next(remaining());
          if (frame.kind !== "data") {
            throw new NodeWorkspaceError("protocol", `file ${expected.path} ended before its declared size`);
          }
          if (received + frame.data.byteLength > expected.size) {
            throw new NodeWorkspaceError("protocol", `the node sent more bytes than declared for ${expected.path}`);
          }
          await handle.write(frame.data);
          hash.update(frame.data);
          received += frame.data.byteLength;
          bytesDone += frame.data.byteLength;
          input.progress?.({
            phase: "receiving",
            filesDone,
            filesTotal: streamed.length,
            bytesDone,
            bytesTotal,
          });
        }
        await handle.sync();
      } finally {
        await handle.close().catch(() => undefined);
      }
      if (received !== expected.size || hash.digest("hex") !== expected.sha256) {
        throw new NodeWorkspaceError("integrity", `returned bytes do not match ${expected.path}`);
      }
      staged.set(expected.path, {
        size: expected.size,
        sha256: expected.sha256,
        executable: expected.executable,
        absolute,
      });
      filesDone += 1;
      input.progress?.({ phase: "receiving", filesDone, filesTotal: streamed.length, bytesDone, bytesTotal });
    }

    const tail = await session.next(remaining());
    if (tail.kind === "data") throw new NodeWorkspaceError("protocol", "the node sent unexpected file data");
    const tailValue = assertControlFrame(tail);
    const tailType = controlType(tailValue);
    if (tailType === "return-error") throw nodeFailure(tailValue);
    if (tailType !== "end") {
      throw new NodeWorkspaceError("protocol", `unexpected control frame ${JSON.stringify(tailType)} at return end`);
    }
    if (
      tailValue.treeDigest !== plan.treeDigest ||
      tailValue.files !== streamed.length ||
      tailValue.bytes !== bytesTotal
    ) {
      throw new NodeWorkspaceError("integrity", "the node completed a different return than the plan");
    }

    session.close();
    session = undefined;

    input.progress?.({
      phase: "applying",
      filesDone: streamed.length,
      filesTotal: streamed.length,
      bytesDone,
      bytesTotal,
    });
    const failures = await applyStaged(root, plan, staged, stagingDirectory);
    if (failures.length > 0) {
      throw new NodeWorkspaceError("io", `applying the return failed: ${failures.join("; ")}`);
    }
    appliedModes = plan.operations.map((entry) => entry.path);
    const touchedDirectories = new Set<string>([root]);
    for (const operation of plan.operations) {
      touchedDirectories.add(path.dirname(targetPath(root, operation.path)));
    }
    for (const directory of touchedDirectories) {
      await fsyncDirectory(directory).catch(() => undefined);
    }
    return {
      nodeId: plan.nodeId,
      localPath: root,
      treeDigest: plan.treeDigest,
      planDigest: plan.planDigest,
      applied: plan.operations.map((entry) => ({ path: entry.path, kind: entry.kind })),
      unchanged: plan.counts.unchanged,
      removedOnNode: plan.removed.map((entry) => entry.path),
      bytesTransferred: bytesTotal,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (
      error instanceof NodeWorkspaceError &&
      ["transport", "timeout", "protocol"].includes(error.code) &&
      staged.size > 0
    ) {
      throw new NodeWorkspaceError(
        error.code,
        `${error.message}. The return was staged but not applied; no local file was changed. ` +
          "Request a fresh preview before retrying.",
        { remotePath: plan.remotePath, planDigest: plan.planDigest },
        { cause: error },
      );
    }
    if (error instanceof NodeWorkspaceError) {
      throw new NodeWorkspaceError(
        error.code,
        error.message,
        { remotePath: plan.remotePath, planDigest: plan.planDigest, applied: appliedModes.length, ...error.details },
        { cause: error },
      );
    }
    throw error;
  } finally {
    session?.close();
    await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

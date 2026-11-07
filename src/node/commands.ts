import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import type { NodeConfig } from "../config.js";
import {
  sessionFromFrames,
  readControl,
  remaining,
  lstatOrUndefined,
  NODE_OPERATION_TIMEOUT_MS,
  type NodeHostCommandIo,
} from "./session.js";

export type { NodeHostCommandIo } from "./session.js";
import { resolvePluginConfig } from "../config.js";
import { treeDigest } from "../digest.js";
import { NodeWorkspaceError, errorMessage, isErrno } from "../errors.js";
import { assertControlFrame, controlType } from "../transport.js";
import {
  COMMAND_FETCH,
  COMMAND_PUSH,
  COMMAND_RETURN,
  COMMAND_STATUS,
  COMMAND_TREE,
  parseFetchRequest,
  parsePushHello,
  type PushHello,
} from "../protocol.js";
import { validateManifestShape } from "../manifest.js";
import { handleReturn, handleTree } from "./return.js";
import {
  assertDestinationAllowed,
  assertSafeParent,
  claimDestination,
  cleanupIncomplete,
  fsyncDirectory,
  fsyncTreeDirectories,
  fsyncTreeFiles,
  readMarker,
  resolveArtifactSource,
  resolvePushDestination,
  safeArtifactMode,
  verifyStagedTree,
  verifyTreeMatches,
  writeMarker,
} from "./fs-atomic.js";
const FETCH_CHUNK_BYTES = 64 * 1024;

export interface NodeHostCommandContext {
  readonly signal?: AbortSignal;
  readonly sessionKey?: string;
}

export interface NodeHostCommand {
  readonly command: string;
  readonly duplex?: boolean;
  readonly dangerous?: boolean;
  readonly hasActiveWork: () => boolean;
  readonly handle: (
    paramsJSON?: string | null,
    io?: NodeHostCommandIo,
    context?: NodeHostCommandContext,
  ) => Promise<string>;
}

interface ConfigState {
  readonly config: ReturnType<typeof resolvePluginConfig> | undefined;
  readonly error: string | undefined;
}

function loadConfig(raw: unknown): ConfigState {
  try {
    return { config: resolvePluginConfig(raw), error: undefined };
  } catch (error) {
    return { config: undefined, error: errorMessage(error) };
  }
}

function nodeConfig(state: ConfigState): NodeConfig {
  if (!state.config) {
    throw new NodeWorkspaceError("config-invalid", state.error ?? "plugin configuration is invalid");
  }
  return state.config.node;
}

async function handlePush(
  state: ConfigState,
  _paramsJSON: string | null | undefined,
  io: NodeHostCommandIo | undefined,
): Promise<string> {
  const session = sessionFromFrames(io);
  let claimed: string | undefined;
  let published = false;

  try {
    const config = nodeConfig(state);
    const deadline = Date.now() + NODE_OPERATION_TIMEOUT_MS;
    const helloValue = await readControl(session, ["hello"], deadline);
    const hello = parsePushHello(helloValue);
    validateManifestShape(hello, config);
    const resolved = await resolvePushDestination(hello.remotePath, config.pushRoots);
    const destination = resolved.destination;
    const reuse = new Set(hello.reuse ?? []);
    const reuseEntries = hello.manifest.filter((entry) => reuse.has(entry.path));

    // An incremental base is read-only. Validate it before the destination is
    // claimed so a bad base cannot leave a half-published generation behind.
    let baseDirectory: string | undefined;
    if (hello.base !== undefined) {
      const baseResolved = await resolvePushDestination(hello.base.remotePath, config.pushRoots);
      if (baseResolved.destination === destination) {
        throw new NodeWorkspaceError("conflict", "the incremental base must differ from the new destination");
      }
      const baseStat = await lstatOrUndefined(baseResolved.destination);
      if (baseStat === undefined) {
        throw new NodeWorkspaceError("path-not-found", `incremental base does not exist: ${baseResolved.destination}`);
      }
      if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
        throw new NodeWorkspaceError("symlink-rejected", "incremental base must be a real directory");
      }
      const baseMarker = await readMarker(baseResolved.destination);
      if (
        baseMarker === undefined ||
        baseMarker.state !== "complete" ||
        baseMarker.manifest === undefined ||
        baseMarker.directories === undefined
      ) {
        throw new NodeWorkspaceError(
          "conflict",
          "incremental base is not a complete plugin publication; publish a full generation and use that as the base",
        );
      }
      if (baseMarker.digest !== hello.base.digest) {
        throw new NodeWorkspaceError(
          "destination-drifted",
          "the incremental base no longer matches the digest the Gateway scanned; request a new preview and retry",
        );
      }
      const baseFiles = new Map(baseMarker.manifest.map((entry) => [entry.path, entry]));
      for (const entry of reuseEntries) {
        const baseEntry = baseFiles.get(entry.path);
        if (
          baseEntry === undefined ||
          baseEntry.size !== entry.size ||
          baseEntry.sha256 !== entry.sha256 ||
          baseEntry.executable !== entry.executable
        ) {
          throw new NodeWorkspaceError(
            "destination-drifted",
            `the incremental base does not contain the expected version of ${entry.path}`,
          );
        }
      }
      baseDirectory = baseResolved.destination;
    }

    const existing = await lstatOrUndefined(destination);
    if (existing) {
      if (existing.isSymbolicLink()) {
        throw new NodeWorkspaceError("symlink-rejected", "destination must not be a symlink");
      }
      if (!existing.isDirectory()) {
        throw new NodeWorkspaceError("destination-exists", "destination exists and is not a directory");
      }
      const marker = await readMarker(destination);
      if (
        marker !== undefined &&
        (marker.state === "complete" || marker.state === "legacy") &&
        marker.pushId === hello.pushId &&
        marker.digest === hello.treeDigest
      ) {
        // A marker records what a previous push claimed. Prove the current
        // bytes still match before telling the caller nothing needs to happen.
        await verifyTreeMatches(destination, hello.manifest, hello.directories, { deadline });
        await session.sendControl({
          t: "result",
          ok: true,
          pushId: hello.pushId,
          digest: hello.treeDigest,
          files: hello.manifest.length,
          bytes: hello.totalBytes,
        });
        return JSON.stringify({ ok: true, alreadyApplied: true, pushId: hello.pushId });
      }
      throw new NodeWorkspaceError(
        "destination-exists",
        marker?.state === "incomplete"
          ? "destination holds an incomplete publication; inspect it with node_workspace_status and remove it yourself before retrying"
          : "destination exists with different content; this plugin never replaces an existing directory. Choose a new remotePath or remove the old copy yourself.",
      );
    }

    // mkdir(2) is the no-clobber claim. It fails for an empty directory too,
    // unlike rename(2), which would silently replace one.
    await claimDestination(destination);
    claimed = destination;
    await writeMarker(destination, {
      plugin: "node-workspace",
      protocol: 1,
      pushId: hello.pushId,
      digest: hello.treeDigest,
      files: hello.manifest.length,
      bytes: hello.totalBytes,
      createdAt: new Date().toISOString(),
      state: "incomplete",
      manifest: hello.manifest,
      directories: hello.directories,
    });

    await session.sendControl({ t: "accepted", pushId: hello.pushId });

    for (const relative of hello.directories) {
      await assertSafeParent(destination, relative);
      const absolute = path.join(destination, ...relative.split("/"));
      try {
        await fs.mkdir(absolute, { mode: 0o700 });
      } catch (error) {
        if (isErrno(error, "EEXIST")) {
          throw new NodeWorkspaceError("destination-drifted", `directory appeared during publication: ${relative}`);
        }
        throw error;
      }
    }

    let reusedBytes = 0;
    if (baseDirectory !== undefined) {
      for (const entry of reuseEntries) {
        await assertSafeParent(destination, entry.path);
        await assertSafeParent(baseDirectory, entry.path);
        const from = path.join(baseDirectory, ...entry.path.split("/"));
        const to = path.join(destination, ...entry.path.split("/"));
        let sourceStat;
        try {
          sourceStat = await fs.lstat(from);
        } catch (error) {
          throw new NodeWorkspaceError(
            "destination-drifted",
            `incremental base entry disappeared: ${entry.path}`,
            {},
            { cause: error },
          );
        }
        if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
          throw new NodeWorkspaceError("destination-drifted", `incremental base entry is not a regular file: ${entry.path}`);
        }
        try {
          await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
        } catch (error) {
          if (isErrno(error, "EEXIST")) {
            throw new NodeWorkspaceError("destination-drifted", `file appeared during publication: ${entry.path}`);
          }
          throw new NodeWorkspaceError("io", `cannot reuse ${entry.path}: ${errorMessage(error)}`, {}, { cause: error });
        }
        await fs.chmod(to, entry.executable ? 0o700 : 0o600);
        reusedBytes += entry.size;
      }
      // The copy is verified against the incoming manifest, not the base
      // marker. A base modified between its marker and this copy fails here.
      await verifyStagedTree(destination, reuseEntries);
    }

    let index = 0;
    let bytesDone = reusedBytes;
    let lastProgressAt = 0;
    let open: { entry: PushHello["manifest"][number]; handle: FileHandle; hash: ReturnType<typeof createHash>; received: number } | undefined;
    const pendingAcks: { path: string; bytes: number; sha256: string }[] = [];
    let pendingAckBytes = 0;

    const flushAcks = async (): Promise<void> => {
      if (pendingAcks.length === 0) return;
      await session.sendControl({ t: "files-ok", files: pendingAcks });
      pendingAcks.length = 0;
      pendingAckBytes = 0;
    };

    const advanceReuse = (): void => {
      while (index < hello.manifest.length && reuse.has(hello.manifest[index]?.path ?? "")) index += 1;
    };
    advanceReuse();

    const finishFile = async (): Promise<void> => {
      if (!open) return;
      const current = open;
      open = undefined;
      // Data is made durable in one bounded phase before the complete marker;
      // a per-file fsync here is not needed for the crash guarantee.
      await current.handle.close();
      const actual = current.hash.digest("hex");
      if (actual !== current.entry.sha256 || current.received !== current.entry.size) {
        throw new NodeWorkspaceError("integrity", `file failed verification: ${current.entry.path}`);
      }
      pendingAcks.push({ path: current.entry.path, bytes: current.received, sha256: actual });
      pendingAckBytes += current.received;
    };

    for (;;) {
      const frame = await session.next(remaining(deadline));
      if (frame.kind === "data") {
        if (!open) throw new NodeWorkspaceError("protocol", "received file data without a file header");
        const remainingBytes = open.entry.size - open.received;
        if (frame.data.byteLength > remainingBytes) {
          throw new NodeWorkspaceError("protocol", `received more data than declared for ${open.entry.path}`);
        }
        await open.handle.write(frame.data);
        open.hash.update(frame.data);
        open.received += frame.data.byteLength;
        bytesDone += frame.data.byteLength;
        if (open.received === open.entry.size) await finishFile();
        const now = Date.now();
        if (now - lastProgressAt > 500) {
          lastProgressAt = now;
          await session.sendControl({
            t: "progress",
            phase: "receiving",
            filesDone: index,
            bytesDone,
          });
        }
        continue;
      }

      const value = assertControlFrame(frame);
      const type = controlType(value);
      if (type === "batch") {
        if (open) throw new NodeWorkspaceError("protocol", "batch received while a file is incomplete");
        if (
          typeof value.files !== "number" ||
          !Number.isSafeInteger(value.files) ||
          value.files < 0 ||
          typeof value.bytes !== "number" ||
          !Number.isSafeInteger(value.bytes) ||
          value.bytes < 0
        ) {
          throw new NodeWorkspaceError("protocol", "batch acknowledgement header is malformed");
        }
        if (value.files !== pendingAcks.length || value.bytes !== pendingAckBytes) {
          throw new NodeWorkspaceError(
            "protocol",
            `batch acknowledgement mismatch: expected ${pendingAcks.length} files/${pendingAckBytes} bytes, received ${value.files}/${value.bytes}`,
          );
        }
        await flushAcks();
        continue;
      }
      if (type === "file") {
        if (open) throw new NodeWorkspaceError("protocol", "new file header before the previous file completed");
        advanceReuse();
        const entry = hello.manifest[index];
        if (!entry) throw new NodeWorkspaceError("protocol", "received more files than the manifest declares");
        if (typeof value.path !== "string" || value.path !== entry.path) {
          throw new NodeWorkspaceError("protocol", `expected file ${entry.path}, received ${String(value.path)}`);
        }
        await assertSafeParent(destination, entry.path);
        const absolute = path.join(destination, ...entry.path.split("/"));
        const handle = await fs.open(absolute, "wx", entry.executable ? 0o700 : 0o600);
        open = { entry, handle, hash: createHash("sha256"), received: 0 };
        if (entry.size === 0) await finishFile();
        index += 1;
        advanceReuse();
        continue;
      }
      if (type === "end") {
        if (open) throw new NodeWorkspaceError("protocol", "end received before the current file completed");
        if (pendingAcks.length > 0) {
          throw new NodeWorkspaceError("protocol", "end received before the final batch acknowledgement");
        }
        advanceReuse();
        if (index !== hello.manifest.length) {
          throw new NodeWorkspaceError("protocol", "end received before every declared file was sent");
        }
        break;
      }
      throw new NodeWorkspaceError("protocol", `unexpected control frame ${JSON.stringify(type)} during push`);
    }

    await verifyTreeMatches(destination, hello.manifest, hello.directories, { deadline });
    const digest = treeDigest({ version: 1, files: hello.manifest, directories: hello.directories });
    if (digest !== hello.treeDigest) {
      throw new NodeWorkspaceError("integrity", "recomputed tree digest does not match the declared digest");
    }
    // Crash ordering: every file's data and every directory entry, including
    // the destination's parent entry, become durable before the complete
    // marker is written. A crash before the marker leaves an incomplete
    // publication; after the marker the publication is durable.
    await fsyncTreeFiles(destination, hello.manifest);
    await fsyncTreeDirectories(destination);
    await fsyncDirectory(resolved.parent);
    // Replace only our own marker file atomically; the destination name was
    // already claimed and is never renamed over.
    await writeMarker(destination, {
      plugin: "node-workspace",
      protocol: 1,
      pushId: hello.pushId,
      digest,
      files: hello.manifest.length,
      bytes: hello.totalBytes,
      createdAt: new Date().toISOString(),
      state: "complete",
      manifest: hello.manifest,
      directories: hello.directories,
    });
    // The complete marker is now durable-or-at-least-written; every later
    // failure is published=true and therefore an unknown outcome.
    published = true;

    await session.sendControl({
      t: "result",
      ok: true,
      pushId: hello.pushId,
      digest,
      files: hello.manifest.length,
      bytes: hello.totalBytes,
    });
    return JSON.stringify({
      ok: true,
      pushId: hello.pushId,
      digest,
      reusedFiles: reuseEntries.length,
      reusedBytes,
    });
  } catch (error) {
    const failure = error instanceof NodeWorkspaceError
      ? error
      : new NodeWorkspaceError("io", errorMessage(error), {}, { cause: error });
    const partial = claimed !== undefined && !published ? await cleanupIncomplete(claimed) : false;
    const message = partial
      ? `${failure.message} (an incomplete publication remains at the destination; inspect it with node_workspace_status)`
      : failure.message;
    await session
      .sendControl({
        t: "result",
        ok: false,
        code: failure.code,
        message,
        published,
        partial,
      })
      .catch(() => undefined);
    return JSON.stringify({ ok: false, code: failure.code, published, partial });
  } finally {
    session.close();
  }
}

async function handleFetch(
  state: ConfigState,
  paramsJSON: string | null | undefined,
  io: NodeHostCommandIo | undefined,
): Promise<string> {
  const session = sessionFromFrames(io);
  let metaSent = false;
  try {
    const config = nodeConfig(state);
    const deadline = Date.now() + NODE_OPERATION_TIMEOUT_MS;
    let raw: unknown;
    try {
      raw = JSON.parse(paramsJSON ?? "{}");
    } catch {
      throw new NodeWorkspaceError("protocol", "fetch parameters are not valid JSON");
    }
    const request = parseFetchRequest(raw, config.maxArtifactBytes);
    const source = await resolveArtifactSource(request.remotePath, config.artifactRoots);
    const stat = await fs.lstat(source);
    const limit = Math.min(request.maxBytes, config.maxArtifactBytes);
    if (stat.size > limit) {
      throw new NodeWorkspaceError("limit-exceeded", `artifact is ${stat.size} bytes, above the limit ${limit}`);
    }

    const handle = await fs.open(source, "r");
    try {
      await session.sendControl({ t: "meta", size: stat.size, sha256: null, mode: safeArtifactMode(stat.mode) });
      metaSent = true;
      const hash = createHash("sha256");
      let sent = 0;
      const buffer = Buffer.allocUnsafe(FETCH_CHUNK_BYTES);
      for (;;) {
        if (Date.now() > deadline) throw new NodeWorkspaceError("timeout", "artifact read exceeded its time limit");
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, sent);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await session.sendData(chunk);
        sent += bytesRead;
        if (sent > limit) throw new NodeWorkspaceError("limit-exceeded", "artifact grew beyond the size limit");
      }
      if (sent !== stat.size) {
        throw new NodeWorkspaceError("io", "artifact changed while it was being read");
      }
      const digest = hash.digest("hex");
      await session.sendControl({ t: "done", sha256: digest, bytes: sent });
      return JSON.stringify({ ok: true, sha256: digest, bytes: sent });
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    const failure = error instanceof NodeWorkspaceError
      ? error
      : new NodeWorkspaceError("io", errorMessage(error), {}, { cause: error });
    const message = { t: metaSent ? "fetch-error" : "rejected", code: failure.code, message: failure.message };
    await session.sendControl(message).catch(() => undefined);
    return JSON.stringify({ ok: false, code: failure.code });
  } finally {
    session.close();
  }
}

async function handleStatus(
  state: ConfigState,
  paramsJSON: string | null | undefined,
): Promise<string> {
  const config = nodeConfig(state);
  let raw: unknown;
  try {
    raw = JSON.parse(paramsJSON ?? "{}");
  } catch {
    throw new NodeWorkspaceError("protocol", "status parameters are not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new NodeWorkspaceError("protocol", "status parameters must be an object");
  }
  const remotePath = (raw as Record<string, unknown>).remotePath;
  if (typeof remotePath !== "string") {
    throw new NodeWorkspaceError("protocol", "status.remotePath must be a string");
  }
  const normalized = await assertDestinationAllowed(remotePath, config.pushRoots);
  const parent = path.posix.dirname(normalized);
  const parentStat = await lstatOrUndefined(parent);
  if (!parentStat || parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    return JSON.stringify({ exists: false, parentExists: false, owned: false, verified: false, marker: null });
  }
  const resolved = await resolvePushDestination(normalized, config.pushRoots);
  const existing = await lstatOrUndefined(resolved.destination);
  if (!existing) {
    return JSON.stringify({ exists: false, parentExists: true, owned: false, verified: false, marker: null });
  }
  if (!existing.isDirectory()) {
    return JSON.stringify({ exists: true, parentExists: true, owned: false, verified: false, marker: null, kind: "file" });
  }
  const marker = await readMarker(resolved.destination);
  if (!marker) {
    return JSON.stringify({ exists: true, parentExists: true, owned: false, verified: false, marker: null });
  }
  let verified = false;
  let drift: string | undefined;
  if (marker.state === "incomplete") {
    drift = "publication is incomplete";
  } else if (marker.manifest === undefined || marker.directories === undefined) {
    drift = "legacy marker has no manifest to verify";
  } else {
    try {
      await verifyTreeMatches(resolved.destination, marker.manifest, marker.directories, {
        deadline: Date.now() + NODE_OPERATION_TIMEOUT_MS,
      });
      verified = true;
    } catch (error) {
      drift = errorMessage(error);
    }
  }
  return JSON.stringify({
    exists: true,
    parentExists: true,
    owned: true,
    complete: marker.state === "complete",
    verified,
    drift: drift ?? null,
    marker,
  });
}

export interface NodeCommandSet {
  readonly commands: readonly NodeHostCommand[];
  readonly configError: string | undefined;
}

export function createNodeCommands(rawConfig: unknown): NodeCommandSet {
  const state = loadConfig(rawConfig);
  // Every command finishes inside handle(); the node host separately tracks
  // in-flight invocations, so no retained background work remains afterwards.
  const commands: NodeHostCommand[] = [
    {
      command: COMMAND_PUSH,
      duplex: true,
      dangerous: true,
      hasActiveWork: () => false,
      handle: (paramsJSON, io) => handlePush(state, paramsJSON, io),
    },
    {
      command: COMMAND_FETCH,
      duplex: true,
      dangerous: true,
      hasActiveWork: () => false,
      handle: (paramsJSON, io) => handleFetch(state, paramsJSON, io),
    },
    {
      command: COMMAND_STATUS,
      dangerous: true,
      hasActiveWork: () => false,
      handle: (paramsJSON) => handleStatus(state, paramsJSON),
    },
    {
      command: COMMAND_TREE,
      dangerous: true,
      hasActiveWork: () => false,
      handle: (paramsJSON) => handleTree(nodeConfig(state), paramsJSON),
    },
    {
      command: COMMAND_RETURN,
      duplex: true,
      dangerous: true,
      hasActiveWork: () => false,
      handle: (_paramsJSON, io) => handleReturn(nodeConfig(state), io),
    },
  ];
  return { commands, configError: state.error };
}

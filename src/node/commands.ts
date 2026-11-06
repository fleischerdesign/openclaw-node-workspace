import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import type { NodeConfig } from "../config.js";
import { resolvePluginConfig } from "../config.js";
import { treeDigest } from "../digest.js";
import { NodeWorkspaceError, errorMessage, isErrno } from "../errors.js";
import { assertControlFrame, controlType, FrameSession, type DuplexChannel } from "../transport.js";
import {
  COMMAND_FETCH,
  COMMAND_PUSH,
  COMMAND_STATUS,
  parseFetchRequest,
  parsePushHello,
  type PushHello,
} from "../protocol.js";
import { validateManifestShape } from "../manifest.js";
import {
  assertDestinationAllowed,
  fsyncDirectory,
  fsyncTreeDirectories,
  markerMatches,
  readMarker,
  resolveArtifactSource,
  resolvePushDestination,
  safeArtifactMode,
  verifyStagedTree,
  verifyTreeMatches,
  writeMarker,
} from "./fs-atomic.js";

const CONTROL_TIMEOUT_MS = 120_000;
const NODE_OPERATION_TIMEOUT_MS = 5 * 60_000;
const FETCH_CHUNK_BYTES = 64 * 1024;

/** Structural subset of the node-host command contract this plugin uses. */
export interface NodeHostCommandIo {
  readonly frames?: {
    send(message: Uint8Array): Promise<void>;
    onMessage(listener: (message: Uint8Array) => void | Promise<void>): () => void;
  };
  readonly signal?: AbortSignal;
}

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

function sessionFromFrames(io: NodeHostCommandIo | undefined): FrameSession {
  const frames = io?.frames;
  if (!frames) {
    throw new NodeWorkspaceError("protocol", "this node does not support framed node commands");
  }
  const signal = io?.signal;
  const closed = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    const fail = () =>
      reject(new NodeWorkspaceError("canceled", "the Gateway canceled the node command", {}, { cause: signal.reason }));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  // Swallow an unhandled rejection when the channel closes after success.
  closed.catch(() => undefined);
  const channel: DuplexChannel = {
    send: (message) => frames.send(message),
    onMessage: (listener) => frames.onMessage(listener),
    closed,
    close: () => undefined,
  };
  return FrameSession.openSync(channel);
}

async function readControl(
  session: FrameSession,
  expected: readonly string[],
  deadline: number,
): Promise<Record<string, unknown>> {
  for (;;) {
    const frame = await session.next(remaining(deadline));
    const value = assertControlFrame(frame);
    const type = controlType(value);
    if (expected.includes(type)) return value;
    throw new NodeWorkspaceError("protocol", `unexpected control frame ${JSON.stringify(type)}`);
  }
}

function remaining(deadline: number): number {
  const left = deadline - Date.now();
  if (left <= 0) throw new NodeWorkspaceError("timeout", "the node operation exceeded its time limit");
  return Math.min(left, CONTROL_TIMEOUT_MS);
}

function nodeConfig(state: ConfigState): NodeConfig {
  if (!state.config) {
    throw new NodeWorkspaceError("config-invalid", state.error ?? "plugin configuration is invalid");
  }
  return state.config.node;
}

async function lstatOrUndefined(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw new NodeWorkspaceError("io", `cannot inspect ${target}: ${errorMessage(error)}`, {}, { cause: error });
  }
}

async function handlePush(
  state: ConfigState,
  _paramsJSON: string | null | undefined,
  io: NodeHostCommandIo | undefined,
): Promise<string> {
  const session = sessionFromFrames(io);
  let staging: string | undefined;
  let committed = false;

  try {
    const config = nodeConfig(state);
    const deadline = Date.now() + NODE_OPERATION_TIMEOUT_MS;
    const helloValue = await readControl(session, ["hello"], deadline);
    const hello = parsePushHello(helloValue);
    validateManifestShape(hello, config);
    const resolved = await resolvePushDestination(hello.remotePath, config.pushRoots);
    const destination = resolved.destination;

    const existing = await lstatOrUndefined(destination);
    if (existing) {
      if (existing.isSymbolicLink()) {
        throw new NodeWorkspaceError("symlink-rejected", "destination must not be a symlink");
      }
      if (!existing.isDirectory()) {
        throw new NodeWorkspaceError("destination-exists", "destination exists and is not a directory");
      }
      if (await markerMatches(destination, hello.pushId, hello.treeDigest)) {
        // A marker records what a previous push claimed. Prove the current
        // bytes still match before telling the caller nothing needs to happen.
        await verifyTreeMatches(destination, hello.manifest, hello.directories);
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
        "destination exists with different content; this plugin never replaces an existing directory. Choose a new remotePath or remove the old copy yourself.",
      );
    }

    const suffix = randomUUID().slice(0, 8);
    staging = path.posix.join(
      resolved.parent,
      `.${path.posix.basename(destination)}.nodews-${hello.pushId}-${suffix}`,
    );
    await fs.mkdir(staging, { mode: 0o700 });
    const stagingDir = staging;

    for (const relative of hello.directories) {
      const absolute = path.join(stagingDir, ...relative.split("/"));
      await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
    }

    await session.sendControl({ t: "accepted", pushId: hello.pushId });

    let index = 0;
    let bytesDone = 0;
    let lastProgressAt = 0;
    let open: { entry: PushHello["manifest"][number]; handle: FileHandle; hash: ReturnType<typeof createHash>; received: number } | undefined;

    const finishFile = async (): Promise<void> => {
      if (!open) return;
      const current = open;
      open = undefined;
      await current.handle.sync();
      await current.handle.close();
      const actual = current.hash.digest("hex");
      if (actual !== current.entry.sha256 || current.received !== current.entry.size) {
        throw new NodeWorkspaceError("integrity", `file failed verification: ${current.entry.path}`);
      }
      await session.sendControl({
        t: "file-ok",
        path: current.entry.path,
        bytes: current.received,
        sha256: actual,
      });
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
        if (now - lastProgressAt > 500 || index >= hello.manifest.length) {
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
      if (type === "file") {
        if (open) throw new NodeWorkspaceError("protocol", "new file header before the previous file completed");
        const entry = hello.manifest[index];
        if (!entry) throw new NodeWorkspaceError("protocol", "received more files than the manifest declares");
        if (typeof value.path !== "string" || value.path !== entry.path) {
          throw new NodeWorkspaceError("protocol", `expected file ${entry.path}, received ${String(value.path)}`);
        }
        const absolute = path.join(stagingDir, ...entry.path.split("/"));
        const handle = await fs.open(absolute, "wx", entry.executable ? 0o700 : 0o600);
        open = { entry, handle, hash: createHash("sha256"), received: 0 };
        if (entry.size === 0) await finishFile();
        index += 1;
        continue;
      }
      if (type === "end") {
        if (open) throw new NodeWorkspaceError("protocol", "end received before the current file completed");
        if (index !== hello.manifest.length) {
          throw new NodeWorkspaceError("protocol", "end received before every declared file was sent");
        }
        break;
      }
      throw new NodeWorkspaceError("protocol", `unexpected control frame ${JSON.stringify(type)} during push`);
    }

    await verifyStagedTree(stagingDir, hello.manifest);
    const digest = treeDigest({ version: 1, files: hello.manifest, directories: hello.directories });
    if (digest !== hello.treeDigest) {
      throw new NodeWorkspaceError("integrity", "recomputed tree digest does not match the declared digest");
    }
    await writeMarker(stagingDir, {
      plugin: "node-workspace",
      protocol: 1,
      pushId: hello.pushId,
      digest,
      files: hello.manifest.length,
      bytes: hello.totalBytes,
      createdAt: new Date().toISOString(),
      manifest: hello.manifest,
      directories: hello.directories,
    });
    await fsyncTreeDirectories(stagingDir);

    try {
      await fs.rename(stagingDir, destination);
    } catch (error) {
      if (isErrno(error, "EEXIST", "ENOTEMPTY")) {
        throw new NodeWorkspaceError("destination-exists", "destination appeared while the push was staged");
      }
      throw new NodeWorkspaceError("io", `failed to publish the staged workspace: ${errorMessage(error)}`, {}, {
        cause: error,
      });
    }
    committed = true;
    staging = undefined;

    // Durability of the rename precedes the success acknowledgement. If this
    // fails, the node reports published=true and the Gateway treats the
    // outcome as unknown rather than claiming a durable publication.
    await fsyncDirectory(resolved.parent);

    await session.sendControl({
      t: "result",
      ok: true,
      pushId: hello.pushId,
      digest,
      files: hello.manifest.length,
      bytes: hello.totalBytes,
    });
    return JSON.stringify({ ok: true, pushId: hello.pushId, digest });
  } catch (error) {
    const failure = error instanceof NodeWorkspaceError
      ? error
      : new NodeWorkspaceError("io", errorMessage(error), {}, { cause: error });
    await session
      .sendControl({ t: "result", ok: false, code: failure.code, message: failure.message, published: committed })
      .catch(() => undefined);
    return JSON.stringify({ ok: false, code: failure.code, published: committed });
  } finally {
    if (staging && !committed) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
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
  try {
    await verifyTreeMatches(resolved.destination, marker.manifest, marker.directories);
    verified = true;
  } catch (error) {
    drift = errorMessage(error);
  }
  return JSON.stringify({
    exists: true,
    parentExists: true,
    owned: true,
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
  ];
  return { commands, configError: state.error };
}

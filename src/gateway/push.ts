import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { GatewayConfig } from "../config.js";
import { derivePushId } from "../digest.js";
import { NodeWorkspaceError, errorMessage } from "../errors.js";
import { scanWorkspace, type ScanResult } from "../manifest.js";
import { isWithin, normalizeAbsolutePosixPath } from "../paths.js";
import { COMMAND_PUSH, PROTOCOL_VERSION } from "../protocol.js";
import {
  assertControlFrame,
  controlType,
  FrameSession,
  resolveNodeId,
  type NodeTransport,
} from "../transport.js";

export interface PushProgress {
  readonly phase: "scanning" | "sending" | "publishing";
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly bytesDone: number;
  readonly bytesTotal: number;
}

export interface PushInput {
  readonly node: string;
  readonly localPath: string;
  readonly remotePath: string;
  readonly exclude: readonly string[] | undefined;
  readonly signal: AbortSignal | undefined;
  readonly progress: ((progress: PushProgress) => void) | undefined;
}

export interface PushOutcome {
  readonly status: "published" | "already-applied";
  readonly nodeId: string;
  readonly cwd: string;
  readonly pushId: string;
  readonly digest: string;
  readonly files: number;
  readonly bytes: number;
  readonly durationMs: number;
  readonly skipped: readonly { readonly path: string; readonly reason: "symlink" | "excluded" }[];
}

const DEFAULT_FRAME_TIMEOUT_MS = 120_000;

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new NodeWorkspaceError("canceled", "the push was canceled", {}, { cause: signal.reason });
  }
}

async function resolveLocalWorkspace(localPath: string, config: GatewayConfig): Promise<string> {
  if (config.localRoots.length === 0) {
    throw new NodeWorkspaceError(
      "config-invalid",
      "gateway.localRoots is empty; configure at least one absolute directory before pushing",
    );
  }
  const normalized = normalizeAbsolutePosixPath(localPath);
  let real: string;
  try {
    real = await fs.realpath(normalized);
  } catch (error) {
    throw new NodeWorkspaceError("path-not-found", `workspace does not exist: ${normalized}`, {}, { cause: error });
  }
  const stat = await fs.lstat(real);
  if (!stat.isDirectory()) {
    throw new NodeWorkspaceError("not-a-directory", `workspace is not a directory: ${real}`);
  }

  const roots: string[] = [];
  for (const root of config.localRoots) {
    try {
      const realRoot = await fs.realpath(root);
      const rootStat = await fs.lstat(realRoot);
      if (rootStat.isDirectory()) roots.push(realRoot);
    } catch {
      // A configured root that does not exist grants nothing.
    }
  }
  const allowed = roots.some((root) => isWithin(root, real));
  if (!allowed) {
    throw new NodeWorkspaceError(
      "path-outside-root",
      `workspace ${real} is outside every configured gateway.localRoots entry`,
    );
  }
  return real;
}

function mapRejected(value: Record<string, unknown>): NodeWorkspaceError {
  if (value.ok === false && value.published === true) {
    return new NodeWorkspaceError(
      "unknown-outcome",
      "the node reported that it published the workspace but the operation failed afterwards. " +
        "Do not retry blindly; call node_workspace_status with the same remotePath.",
    );
  }
  const code = typeof value.code === "string" ? value.code : "node-rejected";
  const message = typeof value.message === "string" ? value.message : "the node rejected the operation";
  return new NodeWorkspaceError(code as NodeWorkspaceError["code"], message, {
    ...(value.partial === true ? { partial: true } : {}),
  });
}

export async function pushWorkspace(
  transport: NodeTransport,
  config: GatewayConfig,
  input: PushInput,
): Promise<PushOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + config.timeoutMs;
  const nodeId = await resolveNodeId(transport, input.node);
  const root = await resolveLocalWorkspace(input.localPath, config);
  const remotePath = normalizeAbsolutePosixPath(input.remotePath);
  const exclude = [...config.exclude, ...(input.exclude ?? [])];

  input.progress?.({
    phase: "scanning",
    filesDone: 0,
    filesTotal: 0,
    bytesDone: 0,
    bytesTotal: 0,
  });
  const scan: ScanResult = await scanWorkspace({
    root,
    exclude,
    symlinks: config.symlinks,
    maxFiles: config.maxFiles,
    maxFileBytes: config.maxFileBytes,
    maxTotalBytes: config.maxTotalBytes,
    signal: input.signal,
    deadline,
  });
  checkAborted(input.signal);

  const pushId = derivePushId(nodeId, remotePath, scan.treeDigest);
  let session: FrameSession | undefined;
  let accepted = false;
  let resultReceived = false;

  const remaining = (): number => {
    const left = deadline - Date.now();
    if (left <= 0) throw new NodeWorkspaceError("timeout", "the push exceeded its time limit");
    return Math.min(left, DEFAULT_FRAME_TIMEOUT_MS);
  };

  try {
    const channel = await transport.openDuplex({
      nodeId,
      command: COMMAND_PUSH,
      idempotencyKey: pushId,
      timeoutMs: config.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    session = FrameSession.openSync(channel);

    await session.sendControl({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      pushId,
      remotePath,
      totalBytes: scan.totalBytes,
      treeDigest: scan.treeDigest,
      manifest: scan.files,
      directories: scan.directories,
    });

    const accept = async (): Promise<Record<string, unknown> | undefined> => {
      for (;;) {
        const frame = await session?.next(remaining());
        if (!frame) throw new NodeWorkspaceError("transport", "node channel disappeared");
        if (frame.kind === "data") {
          throw new NodeWorkspaceError("protocol", "the node sent file data before accepting the push");
        }
        const value = assertControlFrame(frame);
        const type = controlType(value);
        if (type === "progress") continue;
        if (type === "rejected") throw mapRejected(value);
        if (type === "result") {
          if (value.ok === true) return value;
          throw mapRejected(value);
        }
        if (type === "accepted") {
          accepted = true;
          return undefined;
        }
        throw new NodeWorkspaceError("protocol", `unexpected control frame ${JSON.stringify(type)} before acceptance`);
      }
    };

    const early = await accept();
    if (early) {
      resultReceived = true;
      const digest = early.digest;
      const files = early.files;
      const bytes = early.bytes;
      if (digest !== scan.treeDigest || files !== scan.files.length || bytes !== scan.totalBytes) {
        throw new NodeWorkspaceError("integrity", "the node reported an already-applied push with different content");
      }
      return {
        status: "already-applied",
        nodeId,
        cwd: remotePath,
        pushId,
        digest: scan.treeDigest,
        files: scan.files.length,
        bytes: scan.totalBytes,
        durationMs: Date.now() - startedAt,
        skipped: scan.skipped,
      };
    }

    let bytesDone = 0;
    let lastProgressAt = 0;
    let filesDone = 0;
    const report = (phase: PushProgress["phase"], force = false): void => {
      const now = Date.now();
      if (!force && now - lastProgressAt < 150) return;
      lastProgressAt = now;
      input.progress?.({ phase, filesDone, filesTotal: scan.files.length, bytesDone, bytesTotal: scan.totalBytes });
    };

    for (const entry of scan.files) {
      checkAborted(input.signal);
      if (Date.now() >= deadline) throw new NodeWorkspaceError("timeout", "the push exceeded its time limit");
      await session.sendControl({ t: "file", path: entry.path });
      const absolute = path.join(root, ...entry.path.split("/"));
      const handle = await fs.open(absolute, "r");
      try {
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(config.chunkBytes);
        let sent = 0;
        for (;;) {
          checkAborted(input.signal);
          if (Date.now() >= deadline) throw new NodeWorkspaceError("timeout", "the push exceeded its time limit");
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, sent);
          if (bytesRead === 0) break;
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          await session.sendData(chunk);
          sent += bytesRead;
          bytesDone += bytesRead;
          if (sent > entry.size) throw new NodeWorkspaceError("integrity", `file grew during transfer: ${entry.path}`);
          report("sending");
        }
        if (sent !== entry.size || hash.digest("hex") !== entry.sha256) {
          throw new NodeWorkspaceError("integrity", `file changed after it was scanned: ${entry.path}`);
        }
      } finally {
        await handle.close().catch(() => undefined);
      }

      // Wait for this file's acknowledgement, forwarding node progress.
      for (;;) {
        const frame = await session.next(remaining());
        if (frame.kind === "data") {
          throw new NodeWorkspaceError("protocol", "the node sent file data while receiving a file");
        }
        const value = assertControlFrame(frame);
        const type = controlType(value);
        if (type === "progress") {
          const filesDoneValue = typeof value.filesDone === "number" ? value.filesDone : filesDone;
          const bytesDoneValue = typeof value.bytesDone === "number" ? value.bytesDone : bytesDone;
          input.progress?.({
            phase: "sending",
            filesDone: filesDoneValue,
            filesTotal: scan.files.length,
            bytesDone: bytesDoneValue,
            bytesTotal: scan.totalBytes,
          });
          continue;
        }
        if (type === "file-error" || type === "rejected") throw mapRejected(value);
        if (type === "result") {
          resultReceived = true;
          throw mapRejected(value);
        }
        if (type !== "file-ok") {
          throw new NodeWorkspaceError("protocol", `unexpected control frame ${JSON.stringify(type)} while sending`);
        }
        if (value.path !== entry.path || value.sha256 !== entry.sha256 || value.bytes !== entry.size) {
          throw new NodeWorkspaceError("integrity", `node acknowledgement does not match ${entry.path}`);
        }
        filesDone += 1;
        report("sending", true);
        break;
      }
    }

    report("publishing", true);
    await session.sendControl({ t: "end" });

    for (;;) {
      const frame = await session.next(remaining());
      if (frame.kind === "data") throw new NodeWorkspaceError("protocol", "the node sent file data after the push ended");
      const value = assertControlFrame(frame);
      const type = controlType(value);
      if (type === "progress") continue;
      if (type === "rejected") throw mapRejected(value);
      if (type === "result") {
        resultReceived = true;
        if (value.ok !== true) throw mapRejected(value);
        if (
          value.pushId !== pushId ||
          value.digest !== scan.treeDigest ||
          value.files !== scan.files.length ||
          value.bytes !== scan.totalBytes
        ) {
          throw new NodeWorkspaceError("integrity", "the node published a workspace whose digest does not match");
        }
        return {
          status: "published",
          nodeId,
          cwd: remotePath,
          pushId,
          digest: scan.treeDigest,
          files: scan.files.length,
          bytes: scan.totalBytes,
          durationMs: Date.now() - startedAt,
          skipped: scan.skipped,
        };
      }
      throw new NodeWorkspaceError("protocol", `unexpected control frame ${JSON.stringify(type)} after the push`);
    }
  } catch (error) {
    if (
      accepted &&
      !resultReceived &&
      (error instanceof NodeWorkspaceError
        ? ["transport", "timeout", "canceled", "protocol"].includes(error.code)
        : true)
    ) {
      const detail = errorMessage(error);
      throw new NodeWorkspaceError(
        "unknown-outcome",
        `the node may or may not have published the workspace (pushId ${pushId}, node ${nodeId}): ${detail}. ` +
          `Do not retry blindly. Call node_workspace_status with remotePath ${JSON.stringify(remotePath)} first.`,
        { pushId, nodeId, remotePath, cause: detail },
        { cause: error },
      );
    }
    if (error instanceof NodeWorkspaceError) {
      throw new NodeWorkspaceError(
        error.code,
        error.message,
        { pushId, nodeId, remotePath, ...error.details },
        { cause: error },
      );
    }
    throw error;
  } finally {
    session?.close();
  }
}

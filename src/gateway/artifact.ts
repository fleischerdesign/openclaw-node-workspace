import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import type { GatewayConfig } from "../config.js";
import { NodeWorkspaceError, errorMessage, isErrno } from "../errors.js";
import { normalizeAbsolutePosixPath } from "../paths.js";
import { COMMAND_FETCH } from "../protocol.js";
import {
  assertControlFrame,
  controlType,
  FrameSession,
  resolveNodeId,
  type NodeTransport,
} from "../transport.js";

export interface ArtifactInput {
  readonly node: string;
  readonly remotePath: string;
  readonly localPath: string;
  readonly signal: AbortSignal | undefined;
  readonly progress: ((bytesDone: number, bytesTotal: number) => void) | undefined;
}

export interface ArtifactOutcome {
  readonly nodeId: string;
  readonly localPath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mode: number;
}
async function resolveLocalDestination(
  localPath: string,
  config: GatewayConfig,
): Promise<{ destination: string; parent: string; root: string }> {
  if (config.artifactRoots.length === 0) {
    throw new NodeWorkspaceError(
      "config-invalid",
      "gateway.artifactRoots is empty; configure at least one absolute directory before fetching artifacts",
    );
  }
  const normalized = normalizeAbsolutePosixPath(localPath);
  const parentCandidate = path.posix.dirname(normalized);
  const name = path.posix.basename(normalized);
  if (name.length === 0 || name === "." || name === "..") {
    throw new NodeWorkspaceError("path-invalid", "artifact destination must name a file");
  }
  let parentStat;
  try {
    parentStat = await fs.lstat(parentCandidate);
  } catch (error) {
    throw new NodeWorkspaceError("path-not-found", `destination parent does not exist: ${parentCandidate}`, {}, {
      cause: error,
    });
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new NodeWorkspaceError("path-invalid", "destination parent must be a real directory");
  }
  const parent = await fs.realpath(parentCandidate);
  const roots: string[] = [];
  for (const root of config.artifactRoots) {
    try {
      const realRoot = await fs.realpath(root);
      const stat = await fs.lstat(realRoot);
      if (stat.isDirectory()) roots.push(realRoot);
    } catch {
      // A configured root that does not exist grants nothing.
    }
  }
  const match = roots.find((root) => parent === root || parent.startsWith(`${root}/`));
  if (match === undefined) {
    throw new NodeWorkspaceError(
      "path-outside-root",
      `destination parent ${parent} is outside every configured gateway.artifactRoots entry`,
    );
  }
  try {
    await fs.lstat(normalized);
    throw new NodeWorkspaceError(
      "destination-exists",
      `destination already exists and is never overwritten: ${normalized}`,
    );
  } catch (error) {
    if (error instanceof NodeWorkspaceError) throw error;
    if (!isErrno(error, "ENOENT")) {
      throw new NodeWorkspaceError("io", `cannot inspect ${normalized}: ${errorMessage(error)}`, {}, { cause: error });
    }
  }
  return { destination: path.posix.join(parent, name), parent, root: match };
}

async function publishExclusive(temp: string, destination: string): Promise<"linked" | "copied"> {
  try {
    await fs.link(temp, destination);
    return "linked";
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new NodeWorkspaceError("destination-exists", `destination appeared during the fetch: ${destination}`);
    }
    if (!isErrno(error, "EPERM", "ENOTSUP", "EXDEV", "EOPNOTSUPP")) {
      throw new NodeWorkspaceError("io", `cannot publish artifact: ${errorMessage(error)}`, {}, { cause: error });
    }
  }
  try {
    await fs.copyFile(temp, destination, fsConstants.COPYFILE_EXCL);
    return "copied";
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new NodeWorkspaceError("destination-exists", `destination appeared during the fetch: ${destination}`);
    }
    throw new NodeWorkspaceError("io", `cannot publish artifact: ${errorMessage(error)}`, {}, { cause: error });
  }
}

export async function fetchArtifact(
  transport: NodeTransport,
  config: GatewayConfig,
  input: ArtifactInput,
): Promise<ArtifactOutcome> {
  const nodeId = await resolveNodeId(transport, input.node);
  const remotePath = normalizeAbsolutePosixPath(input.remotePath);
  const local = await resolveLocalDestination(input.localPath, config);
  if (input.signal?.aborted) throw new NodeWorkspaceError("canceled", "the fetch was canceled");

  const temp = path.posix.join(local.parent, `.${path.basename(local.destination)}.nodews-part-${randomUUID()}`);
  let session: FrameSession | undefined;
  let tempHandle: FileHandle | undefined;
  try {
    const channel = await transport.openDuplex({
      nodeId,
      command: COMMAND_FETCH,
      params: { remotePath, maxBytes: config.maxArtifactBytes },
      timeoutMs: config.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    session = FrameSession.openSync(channel);

    const metaValue = await (async (): Promise<Record<string, unknown>> => {
      for (;;) {
        const frame = await session.next(config.timeoutMs);
        if (frame.kind === "data") {
          throw new NodeWorkspaceError("protocol", "the node sent artifact bytes before metadata");
        }
        const value = assertControlFrame(frame);
        const type = controlType(value);
        if (type === "rejected") {
          throw new NodeWorkspaceError(
            typeof value.code === "string" ? (value.code as NodeWorkspaceError["code"]) : "node-rejected",
            typeof value.message === "string" ? value.message : "the node rejected the fetch",
          );
        }
        if (type !== "meta") {
          throw new NodeWorkspaceError("protocol", `unexpected control frame ${JSON.stringify(type)} before metadata`);
        }
        return value;
      }
    })();

    const size = metaValue.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new NodeWorkspaceError("protocol", "artifact metadata has an invalid size");
    }
    if (size > config.maxArtifactBytes) {
      throw new NodeWorkspaceError("limit-exceeded", `artifact exceeds the configured ${config.maxArtifactBytes} bytes`);
    }
    const mode = typeof metaValue.mode === "number" ? metaValue.mode & 0o777 : 0o644;
    tempHandle = await fs.open(temp, "wx", 0o600);
    const hash = createHash("sha256");
    let received = 0;
    let done: { sha256: string; bytes: number } | undefined;

    while (!done) {
      if (input.signal?.aborted) throw new NodeWorkspaceError("canceled", "the fetch was canceled");
      const frame = await session.next(config.timeoutMs);
      if (frame.kind === "data") {
        if (received + frame.data.byteLength > size) {
          throw new NodeWorkspaceError("protocol", "the node sent more bytes than it announced");
        }
        await tempHandle.write(frame.data);
        hash.update(frame.data);
        received += frame.data.byteLength;
        input.progress?.(received, size);
        continue;
      }
      const value = assertControlFrame(frame);
      const type = controlType(value);
      if (type === "fetch-error") {
        throw new NodeWorkspaceError(
          typeof value.code === "string" ? (value.code as NodeWorkspaceError["code"]) : "node-rejected",
          typeof value.message === "string" ? value.message : "the node failed to read the artifact",
        );
      }
      if (type !== "done") throw new NodeWorkspaceError("protocol", `unexpected control frame ${JSON.stringify(type)}`);
      if (typeof value.sha256 !== "string" || typeof value.bytes !== "number") {
        throw new NodeWorkspaceError("protocol", "artifact completion frame is malformed");
      }
      done = { sha256: value.sha256, bytes: value.bytes };
    }

    if (received !== size || done.bytes !== size) {
      throw new NodeWorkspaceError("integrity", "artifact byte count does not match the announced size");
    }
    const digest = hash.digest("hex");
    if (digest !== done.sha256) {
      throw new NodeWorkspaceError("integrity", "artifact digest does not match the node's digest");
    }
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = undefined;

    await publishExclusive(temp, local.destination);
    await fs.chmod(local.destination, mode).catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);

    return {
      nodeId,
      localPath: local.destination,
      sha256: digest,
      bytes: received,
      mode,
    };
  } catch (error) {
    if (error instanceof NodeWorkspaceError && error.code === "canceled") throw error;
    if (error instanceof NodeWorkspaceError && error.code === "destination-exists") throw error;
    throw error;
  } finally {
    await tempHandle?.close().catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);
    session?.close();
  }
}

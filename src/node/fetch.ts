import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import type { NodeConfig } from "../config.js";
import { NodeWorkspaceError, errorMessage } from "../errors.js";
import { COMMAND_FETCH, parseFetchRequest } from "../protocol.js";
import { resolveArtifactSource, safeArtifactMode } from "./fs-atomic.js";
import type { NodeHostCommand, NodeHostCommandContext } from "./managed.js";
import { sessionFromFrames, type NodeHostCommandIo } from "./session.js";

const FETCH_CHUNK_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 5 * 60_000;

async function handleFetch(
  config: NodeConfig,
  paramsJSON: string | null | undefined,
  io: NodeHostCommandIo | undefined,
): Promise<string> {
  const session = sessionFromFrames(io);
  let metaSent = false;
  try {
    const deadline = Date.now() + FETCH_TIMEOUT_MS;
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
    const failure =
      error instanceof NodeWorkspaceError
        ? error
        : new NodeWorkspaceError("io", errorMessage(error), {}, { cause: error });
    const message = { t: metaSent ? "fetch-error" : "rejected", code: failure.code, message: failure.message };
    await session.sendControl(message).catch(() => undefined);
    return JSON.stringify({ ok: false, code: failure.code });
  } finally {
    session.close();
  }
}

export function createFetchCommand(config: NodeConfig): NodeHostCommand {
  return {
    command: COMMAND_FETCH,
    duplex: true,
    dangerous: true,
    hasActiveWork: () => false,
    handle: (params, io, _context: NodeHostCommandContext | undefined) => handleFetch(config, params, io),
  };
}

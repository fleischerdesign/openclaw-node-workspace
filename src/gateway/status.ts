import type { GatewayConfig } from "../config.js";
import { NodeWorkspaceError, errorMessage } from "../errors.js";
import { normalizeAbsolutePosixPath } from "../paths.js";
import { COMMAND_STATUS } from "../protocol.js";
import { resolveNodeId, type NodeTransport } from "../transport.js";
import type { Marker } from "../node/fs-atomic.js";

export interface StatusOutcome {
  readonly nodeId: string;
  readonly remotePath: string;
  readonly exists: boolean;
  readonly parentExists: boolean;
  readonly owned: boolean;
  readonly verified: boolean;
  readonly drift: string | null;
  readonly marker: Marker | null;
}

export async function workspaceStatus(
  transport: NodeTransport,
  config: GatewayConfig,
  input: { node: string; remotePath: string; signal?: AbortSignal | undefined },
): Promise<StatusOutcome> {
  const nodeId = await resolveNodeId(transport, input.node);
  const remotePath = normalizeAbsolutePosixPath(input.remotePath);
  let raw: unknown;
  try {
    raw = await transport.invoke({
      nodeId,
      command: COMMAND_STATUS,
      params: { remotePath },
      timeoutMs: config.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    if (error instanceof NodeWorkspaceError) throw error;
    throw new NodeWorkspaceError("transport", `status request failed: ${errorMessage(error)}`, {}, { cause: error });
  }

  let value: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new NodeWorkspaceError("protocol", "node status response is not valid JSON");
    }
  } else if (typeof raw === "object" && raw !== null) {
    const envelope = raw as Record<string, unknown>;
    // The Gateway runtime may return the command result directly, its JSON
    // payload, or the full node-invoke envelope. Accept exactly those shapes.
    if (typeof envelope.payloadJSON === "string") {
      try {
        value = JSON.parse(envelope.payloadJSON) as Record<string, unknown>;
      } catch {
        throw new NodeWorkspaceError("protocol", "node status payloadJSON is not valid JSON");
      }
    } else if (typeof envelope.payload === "string") {
      try {
        value = JSON.parse(envelope.payload) as Record<string, unknown>;
      } catch {
        throw new NodeWorkspaceError("protocol", "node status payload is not valid JSON");
      }
    } else if (typeof envelope.payload === "object" && envelope.payload !== null) {
      value = envelope.payload as Record<string, unknown>;
    } else {
      value = envelope;
    }
  } else {
    throw new NodeWorkspaceError("protocol", "node status response has an unexpected shape");
  }
  if (typeof value.exists !== "boolean") {
    throw new NodeWorkspaceError("protocol", "node status response is missing exists");
  }
  const marker = (value.marker as Marker | null | undefined) ?? null;
  return {
    nodeId,
    remotePath,
    exists: value.exists,
    parentExists: value.parentExists === true,
    owned: value.owned === true,
    verified: value.verified === true,
    drift: typeof value.drift === "string" ? value.drift : null,
    marker,
  };
}

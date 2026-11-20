import type { GatewayConfig } from "../config.js";
import { NodeWorkspaceError, errorMessage } from "../errors.js";
import { COMMAND_STATUS, type StatusRequest } from "../protocol.js";
import { resolveNodeId, type NodeTransport } from "../transport.js";

export interface ManagedStatusOutcome {
  readonly nodeId: string;
  readonly value: Record<string, unknown>;
}

function unwrap(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new NodeWorkspaceError("protocol", "node status response is not valid JSON");
    }
  }
  if (typeof raw === "object" && raw !== null) {
    const envelope = raw as Record<string, unknown>;
    for (const key of ["payloadJSON", "payload"]) {
      const value = envelope[key];
      if (typeof value === "string") {
        try {
          return JSON.parse(value) as Record<string, unknown>;
        } catch {
          throw new NodeWorkspaceError("protocol", `node status ${key} is not valid JSON`);
        }
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    }
    return envelope;
  }
  throw new NodeWorkspaceError("protocol", "node status response has an unexpected shape");
}

export async function managedStatus(
  transport: NodeTransport,
  config: GatewayConfig,
  input: StatusRequest & { readonly node: string; readonly signal?: AbortSignal | undefined },
): Promise<ManagedStatusOutcome> {
  const nodeId = await resolveNodeId(transport, input.node);
  try {
    const raw = await transport.invoke({
      nodeId,
      command: COMMAND_STATUS,
      params: {
        ...(input.remotePath !== undefined ? { remotePath: input.remotePath } : {}),
        ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
        ...(input.verify !== undefined ? { verify: input.verify } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      timeoutMs: config.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return { nodeId, value: unwrap(raw) };
  } catch (error) {
    if (error instanceof NodeWorkspaceError) throw error;
    throw new NodeWorkspaceError("transport", `status request failed: ${errorMessage(error)}`, {}, { cause: error });
  }
}

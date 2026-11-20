import { NodeWorkspaceError, errorMessage, isNodeWorkspaceErrorCode } from "../errors.js";
import type { DuplexChannel, NodeTransport, OpenDuplexRequest } from "../transport.js";

interface RuntimeNodeChannel {
  send(message: Uint8Array): Promise<void>;
  onMessage(listener: (message: Uint8Array) => void | Promise<void>): () => void;
  closed: Promise<unknown>;
  close(): void;
}

interface RuntimeLike {
  nodes: {
    openDuplex(request: {
      nodeId: string;
      command: string;
      params?: unknown;
      timeoutMs?: number;
      idempotencyKey?: string;
      signal?: AbortSignal;
    }): Promise<RuntimeNodeChannel>;
    invoke(request: {
      nodeId: string;
      command: string;
      params?: unknown;
      timeoutMs?: number;
      idempotencyKey?: string;
      signal?: AbortSignal;
    }): Promise<unknown>;
    list(params?: { connected?: boolean }): Promise<{
      nodes: readonly { nodeId: string; displayName?: string; connected?: boolean }[];
    }>;
  };
}

function codedFailure(error: unknown): NodeWorkspaceError | undefined {
  if (error instanceof NodeWorkspaceError) return error;
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined;
  const candidates: Record<string, unknown>[] = [];
  if (record !== undefined) {
    candidates.push(record);
    for (const key of ["payloadJSON", "payload"] as const) {
      const raw = record[key];
      if (typeof raw === "string") {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed === "object" && parsed !== null) candidates.push(parsed as Record<string, unknown>);
        } catch {
          // Not a structured failure; fall through to transport.
        }
      } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        candidates.push(raw as Record<string, unknown>);
      }
    }
  }
  for (const candidate of candidates) {
    const code = candidate.code;
    if (!isNodeWorkspaceErrorCode(code)) continue;
    const message = typeof candidate.message === "string" ? candidate.message : `node rejected the command (${code})`;
    const details =
      typeof candidate.details === "object" && candidate.details !== null && !Array.isArray(candidate.details)
        ? (candidate.details as Record<string, unknown>)
        : {};
    return new NodeWorkspaceError(code, message, details, { cause: error });
  }
  return undefined;
}

/** Wrap the public plugin runtime in the narrow transport this plugin needs. */
export function createNodeTransport(runtime: RuntimeLike): NodeTransport {
  return {
    async openDuplex(request: OpenDuplexRequest): Promise<DuplexChannel> {
      try {
        return await runtime.nodes.openDuplex(request);
      } catch (error) {
        throw new NodeWorkspaceError("transport", `cannot open the node channel: ${errorMessage(error)}`, {}, {
          cause: error,
        });
      }
    },
    async listNodes() {
      try {
        const listed = await runtime.nodes.list({ connected: true });
        return listed.nodes;
      } catch (error) {
        throw new NodeWorkspaceError("transport", `cannot list nodes: ${errorMessage(error)}`, {}, { cause: error });
      }
    },
    async invoke(request: { nodeId: string; command: string; params?: unknown; timeoutMs?: number; signal?: AbortSignal }) {
      try {
        return await runtime.nodes.invoke(request);
      } catch (error) {
        const coded = codedFailure(error);
        if (coded !== undefined) throw coded;
        throw new NodeWorkspaceError("transport", `node command failed: ${errorMessage(error)}`, {}, { cause: error });
      }
    },
  };
}

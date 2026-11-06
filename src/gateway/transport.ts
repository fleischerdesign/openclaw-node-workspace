import { NodeWorkspaceError, errorMessage } from "../errors.js";
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
        throw new NodeWorkspaceError("transport", `node command failed: ${errorMessage(error)}`, {}, { cause: error });
      }
    },
  };
}

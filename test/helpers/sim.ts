import type { DuplexChannel, NodeTransport } from "../../src/transport.js";
import type { NodeHostCommand } from "../../src/node/commands.js";

type Listener = (message: Uint8Array) => void | Promise<void>;

class MemoryChannel implements DuplexChannel {
  peer!: MemoryChannel;
  listener: Listener | undefined;
  readonly closed: Promise<unknown>;
  #resolveClosed!: (value: unknown) => void;
  #rejectClosed!: (error: Error) => void;
  #settled = false;

  constructor() {
    this.closed = new Promise((resolve, reject) => {
      this.#resolveClosed = resolve;
      this.#rejectClosed = reject;
    });
    this.closed.catch(() => undefined);
  }

  async send(message: Uint8Array): Promise<void> {
    const target = this.peer;
    if (!target.listener) throw new Error("peer has no frame listener");
    await target.listener(new Uint8Array(message));
  }

  onMessage(listener: Listener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  close(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolveClosed("closed by local side");
    this.peer.#fail(new Error("peer closed the channel"));
  }

  #fail(error: Error): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#rejectClosed(error);
  }
}

function channelPair(): [MemoryChannel, MemoryChannel] {
  const a = new MemoryChannel();
  const b = new MemoryChannel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

export interface Faults {
  /** Return a replacement gateway-to-node frame, or undefined to pass it through. */
  gatewayFrame?: (frame: Uint8Array, index: number) => Uint8Array | undefined;
  /** Return a replacement node-to-gateway frame, or undefined to pass it through. */
  nodeFrame?: (frame: Uint8Array, index: number) => Uint8Array | undefined;
  /** Close the channel when the Gateway sends its Nth frame (1-based). */
  closeAfterGatewayFrames?: number;
  /** Close the channel when the node sends its Nth frame (1-based). */
  closeAfterNodeFrames?: number;
  /** Reject openDuplex with this error. */
  openError?: Error;
}

export interface Harness {
  readonly transport: NodeTransport;
  readonly opens: string[];
  readonly nodeErrors: Error[];
}

/**
 * In-process stand-in for the Gateway-to-node transport.
 *
 * It runs the real node command handlers over a real ordered channel; only the
 * network hop is replaced. That is the level the plugin owns.
 */
export function createHarness(commands: readonly NodeHostCommand[], faults: Faults = {}): Harness {
  const opens: string[] = [];
  const nodeErrors: Error[] = [];

  const transport: NodeTransport = {
    async openDuplex(request) {
      if (faults.openError) throw faults.openError;
      const command = commands.find((entry) => entry.command === request.command);
      if (!command) throw new Error(`unknown command ${request.command}`);
      opens.push(request.command);

      const [gatewaySide, nodeSide] = channelPair();
      const controller = new AbortController();
      let gatewayFrameCount = 0;
      let nodeFrameCount = 0;

      // Fault injection happens on the Gateway-to-node direction before the
      // node sees the frame.
      const originalSend = gatewaySide.send.bind(gatewaySide);
      gatewaySide.send = async (message: Uint8Array) => {
        gatewayFrameCount += 1;
        if (faults.closeAfterGatewayFrames !== undefined && gatewayFrameCount >= faults.closeAfterGatewayFrames) {
          gatewaySide.close();
          throw new Error("simulated transport loss");
        }
        const replaced = faults.gatewayFrame?.(message, gatewayFrameCount);
        await originalSend(replaced ?? message);
      };

      // Closing the Gateway side aborts node work, as the real SDK does.
      gatewaySide.closed.then(
        () => {
          controller.abort(new Error("gateway channel closed"));
          nodeSide.close();
        },
        () => {
          controller.abort(new Error("gateway channel closed"));
          nodeSide.close();
        },
      );

      const io = {
        frames: {
          send: async (message: Uint8Array) => {
            nodeFrameCount += 1;
            if (faults.closeAfterNodeFrames !== undefined && nodeFrameCount >= faults.closeAfterNodeFrames) {
              nodeSide.close();
              throw new Error("simulated node-side transport loss");
            }
            const replaced = faults.nodeFrame?.(message, nodeFrameCount);
            await nodeSide.send(replaced ?? message);
          },
          onMessage: (listener: Listener) => nodeSide.onMessage(listener),
        },
        signal: controller.signal,
      };
      const params = request.params === undefined ? null : JSON.stringify(request.params);
      void Promise.resolve(command.handle(params, io, {}))
        .catch((error: unknown) => {
          nodeErrors.push(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          nodeSide.close();
        });

      return gatewaySide;
    },

    async invoke(request) {
      if (faults.openError) throw faults.openError;
      const command = commands.find((entry) => entry.command === request.command);
      if (!command) throw new Error(`unknown command ${request.command}`);
      opens.push(request.command);
      return await command.handle(request.params === undefined ? null : JSON.stringify(request.params), undefined, {});
    },

    async listNodes() {
      return [{ nodeId: "node-1", displayName: "Node One", connected: true }];
    },
  };

  return { transport, opens, nodeErrors };
}

import { decodeFrame, encodeControl, encodeData, type Frame } from "./frames.js";
import { NodeWorkspaceError, asError, errorMessage } from "./errors.js";

/** The framed binary channel exposed by the OpenClaw plugin runtime. */
export interface DuplexChannel {
  send(message: Uint8Array): Promise<void>;
  onMessage(listener: (message: Uint8Array) => void | Promise<void>): () => void;
  readonly closed: Promise<unknown>;
  close(): void;
}

export interface OpenDuplexRequest {
  readonly nodeId: string;
  readonly command: string;
  readonly params?: unknown;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface NodeTransport {
  openDuplex(request: OpenDuplexRequest): Promise<DuplexChannel>;
  invoke(request: {
    nodeId: string;
    command: string;
    params?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
  listNodes(): Promise<readonly { nodeId: string; displayName?: string; connected?: boolean }[]>;
}

interface Waiter {
  resolve: (frame: Frame) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A promise queue over one duplex channel.
 *
 * OpenClaw delivers complete messages; this class only orders them and turns a
 * closed channel into a typed error. It never reconnects.
 */
export class FrameSession {
  readonly #channel: DuplexChannel;
  #queue: Frame[] = [];
  #waiter: Waiter | undefined;
  #closedError: Error | undefined;
  #closeReason: Error | undefined;
  #disposed = false;

  private constructor(channel: DuplexChannel) {
    this.#channel = channel;
    channel.onMessage((message) => {
      let frame: Frame;
      try {
        frame = decodeFrame(message);
      } catch (error) {
        this.#fail(asError(error));
        return;
      }
      if (this.#waiter) {
        const waiter = this.#waiter;
        this.#waiter = undefined;
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
        return;
      }
      // Bounded: a peer that streams without being read must not grow memory.
      // 512 small progress frames cover a 120 s file transfer at a 500 ms cadence.
      if (this.#queue.length >= 512) {
        this.#fail(new NodeWorkspaceError("protocol", "peer sent more than 512 unread frames"));
        return;
      }
      this.#queue.push(frame);
    });
    void channel.closed.then(
      (value) => {
        this.#closeReason = new NodeWorkspaceError("transport", `node command channel closed: ${String(value)}`);
        this.#fail(this.#closeReason);
      },
      (error: unknown) => {
        this.#closeReason = new NodeWorkspaceError("transport", `node command channel failed: ${errorMessage(error)}`, {}, {
          cause: error,
        });
        this.#fail(this.#closeReason);
      },
    );
  }

  static openSync(channel: DuplexChannel): FrameSession {
    return new FrameSession(channel);
  }

  static async open(channel: DuplexChannel): Promise<FrameSession> {
    // Register the listener synchronously after open resolves, as the SDK
    // requires, before the node announces framed readiness.
    return new FrameSession(channel);
  }

  #fail(error: Error): void {
    if (this.#disposed || this.#closedError) return;
    this.#closedError = error;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  async sendControl(value: unknown): Promise<void> {
    await this.#send(encodeControl(value));
  }

  async sendData(data: Uint8Array): Promise<void> {
    await this.#send(encodeData(data));
  }

  async #send(message: Uint8Array): Promise<void> {
    if (this.#closedError) throw this.#closedError;
    try {
      await this.#channel.send(message);
    } catch (error) {
      // A send failure says nothing about whether earlier frames were applied.
      throw new NodeWorkspaceError("transport", `failed to send a frame to the node: ${errorMessage(error)}`, {}, {
        cause: error,
      });
    }
  }

  async next(timeoutMs: number): Promise<Frame> {
    if (this.#queue.length > 0) return this.#queue.shift() as Frame;
    if (this.#closedError) throw this.#closedError;
    return await new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#waiter) this.#waiter = undefined;
        reject(new NodeWorkspaceError("timeout", `no frame from the node within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#waiter = { resolve, reject, timer };
    });
  }

  close(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#closeReason) this.#closedError ??= this.#closeReason;
    try {
      this.#channel.close();
    } catch {
      // Closing an already closed channel is harmless.
    }
  }
}

export function assertControlFrame(frame: Frame): Record<string, unknown> {
  if (frame.kind !== "control") {
    throw new NodeWorkspaceError("protocol", "expected a control frame, received file data");
  }
  const value = frame.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NodeWorkspaceError("protocol", "control frame must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function controlType(value: Record<string, unknown>): string {
  const type = value.t;
  return typeof type === "string" ? type : "";
}

/** Resolve a node id or an exact display name to the canonical node id. */
export async function resolveNodeId(transport: NodeTransport, query: string): Promise<string> {
  const trimmed = query.trim();
  if (trimmed.length === 0) throw new NodeWorkspaceError("path-invalid", "node must not be empty");
  const nodes = await transport.listNodes();
  const byId = nodes.find((node) => node.nodeId === trimmed);
  if (byId) return byId.nodeId;
  const matches = nodes.filter((node) => node.displayName?.toLowerCase() === trimmed.toLowerCase());
  if (matches.length === 1 && matches[0]) return matches[0].nodeId;
  if (matches.length > 1) {
    throw new NodeWorkspaceError("conflict", `node name ${JSON.stringify(query)} is ambiguous; use a node id`);
  }
  throw new NodeWorkspaceError("path-not-found", `no paired node matches ${JSON.stringify(query)}`);
}

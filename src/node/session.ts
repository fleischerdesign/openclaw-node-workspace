import fs from "node:fs/promises";

import { NodeWorkspaceError, errorMessage, isErrno } from "../errors.js";
import { assertControlFrame, controlType, FrameSession, type DuplexChannel } from "../transport.js";
/** Structural subset of the node-host command contract this plugin uses. */
export interface NodeHostCommandIo {
  readonly frames?: {
    send(message: Uint8Array): Promise<void>;
    onMessage(listener: (message: Uint8Array) => void | Promise<void>): () => void;
  };
  readonly signal?: AbortSignal;
}

export const CONTROL_TIMEOUT_MS = 120_000;
export const NODE_OPERATION_TIMEOUT_MS = 5 * 60_000;

/** Build a framed session from the node command's duplex io. */
export function sessionFromFrames(io: NodeHostCommandIo | undefined): FrameSession {
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

export async function readControl(
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

export function remaining(deadline: number): number {
  const left = deadline - Date.now();
  if (left <= 0) throw new NodeWorkspaceError("timeout", "the node operation exceeded its time limit");
  return Math.min(left, CONTROL_TIMEOUT_MS);
}

export async function lstatOrUndefined(
  target: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw new NodeWorkspaceError("io", `cannot inspect ${target}: ${errorMessage(error)}`, {}, { cause: error });
  }
}

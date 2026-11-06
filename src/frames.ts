import { NodeWorkspaceError } from "./errors.js";

const FRAME_DATA = 1;
const FRAME_CONTROL = 2;

/** Data frames are one chunk of a file; control frames carry JSON. */
export type Frame =
  | { readonly kind: "data"; readonly data: Uint8Array }
  | { readonly kind: "control"; readonly value: unknown };

export const MAX_CONTROL_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_DATA_FRAME_BYTES = 1024 * 1024;

export function encodeData(data: Uint8Array): Uint8Array {
  if (data.byteLength === 0) throw new NodeWorkspaceError("protocol", "refusing to send an empty data frame");
  if (data.byteLength > MAX_DATA_FRAME_BYTES) {
    throw new NodeWorkspaceError("protocol", `data frame exceeds ${MAX_DATA_FRAME_BYTES} bytes`);
  }
  const frame = new Uint8Array(data.byteLength + 1);
  frame[0] = FRAME_DATA;
  frame.set(data, 1);
  return frame;
}

export function encodeControl(value: unknown): Uint8Array {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > MAX_CONTROL_FRAME_BYTES) {
    throw new NodeWorkspaceError("protocol", `control frame exceeds ${MAX_CONTROL_FRAME_BYTES} bytes`);
  }
  const frame = new Uint8Array(body.byteLength + 1);
  frame[0] = FRAME_CONTROL;
  frame.set(body, 1);
  return frame;
}

export function decodeFrame(frame: Uint8Array): Frame {
  const kind = frame[0];
  if (kind === FRAME_DATA) {
    if (frame.byteLength === 1) throw new NodeWorkspaceError("protocol", "received an empty data frame");
    return { kind: "data", data: frame.subarray(1) };
  }
  if (kind === FRAME_CONTROL) {
    if (frame.byteLength > MAX_CONTROL_FRAME_BYTES + 1) {
      throw new NodeWorkspaceError("protocol", "received an oversized control frame");
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(frame.subarray(1)).toString("utf8"));
    } catch {
      throw new NodeWorkspaceError("protocol", "received a control frame that is not valid JSON");
    }
    return { kind: "control", value };
  }
  throw new NodeWorkspaceError("protocol", `received an unknown frame type ${String(kind)}`);
}

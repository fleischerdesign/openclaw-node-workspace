import assert from "node:assert/strict";
import test from "node:test";

import { NodeWorkspaceError } from "../src/errors.js";
import { FrameSession, type DuplexChannel } from "../src/transport.js";

function channel(): DuplexChannel & { listeners: number } {
  let listener: ((message: Uint8Array) => void) | undefined;
  return {
    listeners: 0,
    async send() {},
    onMessage(next) {
      listener = next;
      this.listeners += 1;
      return () => {
        listener = undefined;
        this.listeners -= 1;
      };
    },
    closed: new Promise<never>(() => {}),
    close() {},
  };
}

test("FrameSession rejects a concurrent read instead of losing a waiter", async () => {
  const source = channel();
  const session = FrameSession.openSync(source);
  const first = session.next(50);
  await assert.rejects(
    () => session.next(50),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "protocol",
  );
  session.close();
  await assert.rejects(first, (error: unknown) => error instanceof NodeWorkspaceError && error.code === "timeout");
});

test("FrameSession unsubscribes its listener on close", () => {
  const source = channel();
  const session = FrameSession.openSync(source);
  assert.equal(source.listeners, 1);
  session.close();
  assert.equal(source.listeners, 0);
});

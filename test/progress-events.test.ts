import assert from "node:assert/strict";
import test from "node:test";

import { ProgressEventCoalescer } from "../src/gateway/progress-events.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("coalesces a progress burst to a bounded rate", async () => {
  let emits = 0;
  const coalescer = new ProgressEventCoalescer(() => (emits += 1), 30);
  coalescer.notify();
  assert.equal(emits, 1);
  for (let index = 0; index < 20; index += 1) coalescer.notify();
  assert.equal(emits, 1);
  await delay(60);
  assert.equal(emits, 2);
  coalescer.dispose();
});

test("a terminal notification is delivered immediately and cancels the pending timer", async () => {
  let emits = 0;
  const coalescer = new ProgressEventCoalescer(() => (emits += 1), 30);
  coalescer.notify();
  assert.equal(emits, 1);
  for (let index = 0; index < 5; index += 1) coalescer.notify();
  coalescer.notify(true);
  assert.equal(emits, 2);
  await delay(60);
  assert.equal(emits, 2);
  coalescer.dispose();
});

test("dispose drops a pending notification", async () => {
  let emits = 0;
  const coalescer = new ProgressEventCoalescer(() => (emits += 1), 30);
  coalescer.notify();
  coalescer.notify();
  coalescer.dispose();
  await delay(60);
  assert.equal(emits, 1);
});

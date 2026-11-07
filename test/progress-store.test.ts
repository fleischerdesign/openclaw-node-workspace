import assert from "node:assert/strict";
import test from "node:test";

import { TransferProgressStore } from "../src/gateway/progress-store.js";

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("progress snapshots are isolated by agent and session", () => {
  const store = new TransferProgressStore();
  store.begin({ sessionKey: "agent:main:a" }, "one", "push");
  store.begin({ sessionKey: "agent:main:b" }, "two", "push");
  store.begin({ sessionKey: "agent:main:a", agentId: "other" }, "three", "fetch");

  assert.deepEqual(
    store.snapshot({ sessionKey: "agent:main:a" }).map((entry) => entry.transferId),
    ["one"],
  );
  assert.deepEqual(
    store.snapshot({ sessionKey: "agent:main:b" }).map((entry) => entry.transferId),
    ["two"],
  );
  assert.deepEqual(
    store.snapshot({ sessionKey: "agent:main:a", agentId: "other" }).map((entry) => entry.transferId),
    ["three"],
  );
});

test("multiple transfers coexist and keep their own terminal state", () => {
  const c = clock();
  const store = new TransferProgressStore(c.now);
  store.begin({ sessionKey: "s" }, "first", "push");
  store.begin({ sessionKey: "s" }, "second", "fetch");
  store.updateFromPush({ sessionKey: "s" }, "first", {
    phase: "sending",
    filesDone: 3,
    filesTotal: 5,
    bytesDone: 300,
    bytesTotal: 500,
  });
  store.updateFetch({ sessionKey: "s" }, "second", 25, 100);

  const running = store.snapshot({ sessionKey: "s" });
  assert.equal(running.length, 2);
  assert.equal(running[0]?.state, "running");
  assert.equal(running[0]?.bytesDone, 300);
  assert.equal(running[1]?.kind, "fetch");
  assert.equal(running[1]?.bytesTotal, 100);

  store.finish({ sessionKey: "s" }, "first", "completed");
  store.finish({ sessionKey: "s" }, "second", "unknown");
  const finished = store.snapshot({ sessionKey: "s" });
  assert.equal(finished[0]?.state, "completed");
  assert.equal(finished[1]?.state, "unknown");
});

test("terminal entries expire without inventing a completion for running ones", () => {
  const c = clock();
  const store = new TransferProgressStore(c.now);
  store.begin({ sessionKey: "s" }, "done", "push");
  store.finish({ sessionKey: "s" }, "done", "completed");
  store.begin({ sessionKey: "s" }, "lost", "push");
  store.finish({ sessionKey: "s" }, "lost", "unknown");
  store.begin({ sessionKey: "s" }, "running", "push");

  c.advance(10_000);
  const after = store.snapshot({ sessionKey: "s" });
  assert.deepEqual(after.map((entry) => entry.transferId), ["lost", "running"]);
  assert.equal(after[0]?.state, "unknown");

  c.advance(60_000);
  const later = store.snapshot({ sessionKey: "s" });
  assert.deepEqual(later.map((entry) => entry.transferId), ["running"]);
  assert.equal(later[0]?.state, "running");
});

test("clearing a session drops every transfer for that scope only", () => {
  const store = new TransferProgressStore();
  store.begin({ sessionKey: "a" }, "one", "push");
  store.begin({ sessionKey: "b" }, "two", "push");
  assert.equal(store.clearScope({ sessionKey: "a" }), true);
  assert.equal(store.clearScope({ sessionKey: "a" }), false);
  assert.deepEqual(store.snapshot({ sessionKey: "a" }), []);
  assert.equal(store.snapshot({ sessionKey: "b" }).length, 1);
});

test("a snapshot exposes measured counters only, never paths or node identity", () => {
  const store = new TransferProgressStore();
  store.begin({ sessionKey: "s" }, "one", "push");
  const [entry] = store.snapshot({ sessionKey: "s" });
  assert.ok(entry);
  assert.deepEqual(Object.keys(entry).sort(), [
    "bytesDone",
    "bytesTotal",
    "filesDone",
    "filesTotal",
    "kind",
    "phase",
    "startedAt",
    "state",
    "transferId",
    "updatedAt",
  ]);
  assert.equal(JSON.stringify(entry).includes("localPath"), false);
  assert.equal(JSON.stringify(entry).includes("remotePath"), false);
  assert.equal(JSON.stringify(entry).includes("nodeId"), false);
});

import assert from "node:assert/strict";
import test from "node:test";

import { resolvePluginConfig } from "../src/config.js";
import { NodeWorkspaceError } from "../src/errors.js";
import { readNodeTree } from "../src/gateway/tree.js";
import { treeDigest } from "../src/digest.js";
import type { NodeTransport } from "../src/transport.js";

const config = resolvePluginConfig({}).gateway;

function transportWith(payload: Record<string, unknown>): NodeTransport {
  return {
    async invoke() {
      return { payload };
    },
    async openDuplex() {
      throw new Error("not used");
    },
    async listNodes() {
      return [{ nodeId: "node-1", displayName: "Node One", connected: true }];
    },
  };
}

const emptyDigest = treeDigest({ version: 1, files: [], directories: [] });

const base = {
  ok: true,
  remotePath: "/srv/work",
  directory: "/srv/work",
  files: [],
  directories: [],
  totalBytes: 0,
  treeDigest: emptyDigest,
  owned: false,
  complete: false,
  verified: false,
  drift: null,
  marker: null,
};

test("a node tree path with a traversal segment is rejected on the Gateway", async () => {
  const payload = {
    ...base,
    files: [{ path: "../ESCAPED.txt", size: 1, sha256: "a".repeat(64), executable: false }],
    totalBytes: 1,
  };
  await assert.rejects(
    () => readNodeTree(transportWith(payload), config, { node: "node-1", remotePath: "/srv/work" }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "path-invalid",
  );
});

test("a node tree digest that does not match its manifest is rejected", async () => {
  const files = [{ path: "a.txt", size: 1, sha256: "a".repeat(64), executable: false }];
  const payload = { ...base, files, totalBytes: 1, treeDigest: "b".repeat(64) };
  await assert.rejects(
    () => readNodeTree(transportWith(payload), config, { node: "node-1", remotePath: "/srv/work" }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "integrity",
  );
});

test("a node tree file without its declared parent directory is rejected", async () => {
  const payload = {
    ...base,
    files: [{ path: "sub/a.txt", size: 1, sha256: "a".repeat(64), executable: false }],
    totalBytes: 1,
  };
  await assert.rejects(
    () => readNodeTree(transportWith(payload), config, { node: "node-1", remotePath: "/srv/work" }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "protocol",
  );
});

test("a malformed marker manifest is ignored instead of reaching the planner", async () => {
  const payload = {
    ...base,
    marker: {
      plugin: "node-workspace",
      protocol: 1,
      pushId: "a".repeat(32),
      digest: emptyDigest,
      files: 1,
      bytes: 1,
      createdAt: "2026-11-07T00:00:00.000Z",
      state: "complete",
      manifest: [{ path: "../escape.txt", size: 1, sha256: "a".repeat(64), executable: false }],
    },
  };
  const outcome = await readNodeTree(transportWith(payload), config, { node: "node-1", remotePath: "/srv/work" });
  assert.equal(outcome.marker, null);
});

test("a marker with a non-array manifest is ignored", async () => {
  const payload = {
    ...base,
    marker: {
      plugin: "node-workspace",
      protocol: 1,
      pushId: "a".repeat(32),
      digest: "0".repeat(64),
      files: 1,
      bytes: 1,
      createdAt: "2026-11-07T00:00:00.000Z",
      state: "complete",
      manifest: "not an array",
    },
  };
  const outcome = await readNodeTree(transportWith(payload), config, { node: "node-1", remotePath: "/srv/work" });
  assert.equal(outcome.marker, null);
});

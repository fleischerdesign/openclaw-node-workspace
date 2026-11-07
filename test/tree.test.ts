import assert from "node:assert/strict";
import test from "node:test";

import { resolvePluginConfig } from "../src/config.js";
import { NodeWorkspaceError } from "../src/errors.js";
import { readNodeTree } from "../src/gateway/tree.js";
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

const base = {
  ok: true,
  remotePath: "/srv/work",
  directory: "/srv/work",
  files: [],
  directories: [],
  totalBytes: 0,
  treeDigest: "0".repeat(64),
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

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NodeWorkspaceError } from "../src/errors.js";
import { managedStatus } from "../src/gateway/managed-status.js";
import { createNodeTransport } from "../src/gateway/transport.js";
import { NODE_RESPONSE_GRACE_MS, nodeDeadline, parseFetchRequest, parseStatusRequest } from "../src/protocol.js";
import { createNodeCommands } from "../src/node/commands.js";

function isCode(code: string) {
  return (error: unknown): boolean => error instanceof NodeWorkspaceError && error.code === code;
}

test("createNodeTransport preserves a structured node failure code", async () => {
  const transport = createNodeTransport({
    nodes: {
      async openDuplex() {
        throw new Error("unused");
      },
      async invoke() {
        throw Object.assign(new Error("workspace belongs to another agent"), { code: "workspace-forbidden" });
      },
      async list() {
        return { nodes: [{ nodeId: "node-1" }] };
      },
    },
  });
  await assert.rejects(
    () => transport.invoke({ nodeId: "node-1", command: "nodews.status" }),
    isCode("workspace-forbidden"),
  );
});

test("createNodeTransport does not mistake a native errno for a node error code", async () => {
  const transport = createNodeTransport({
    nodes: {
      async openDuplex() {
        throw new Error("unused");
      },
      async invoke() {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
      async list() {
        return { nodes: [{ nodeId: "node-1" }] };
      },
    },
  });
  await assert.rejects(
    () => transport.invoke({ nodeId: "node-1", command: "nodews.status" }),
    isCode("transport"),
  );
});

test("createNodeTransport decodes a payloadJSON failure envelope", async () => {
  const transport = createNodeTransport({
    nodes: {
      async openDuplex() {
        throw new Error("unused");
      },
      async invoke() {
        throw Object.assign(new Error("node rejected"), {
          payloadJSON: JSON.stringify({ ok: false, code: "identity-unresolved", message: "no asserted owner" }),
        });
      },
      async list() {
        return { nodes: [{ nodeId: "node-1" }] };
      },
    },
  });
  await assert.rejects(
    () => transport.invoke({ nodeId: "node-1", command: "nodews.status" }),
    (error: unknown) => {
      assert.ok(isCode("identity-unresolved")(error));
      assert.match((error as Error).message, /no asserted owner/);
      return true;
    },
  );
});

test("managedStatus turns a returned failure envelope into a typed error", async () => {
  const transport = {
    async invoke() {
      return { ok: false, code: "workspace-forbidden", message: "another agent" };
    },
    async openDuplex() {
      throw new Error("unused");
    },
    async listNodes() {
      return [{ nodeId: "node-1" }];
    },
  };
  await assert.rejects(
    () =>
      managedStatus(transport, { timeoutMs: 5_000 } as never, {
        node: "node-1",
        remotePath: "/srv/app",
        owner: { agentId: "main", sessionKey: "agent:main:test" },
      }),
    isCode("workspace-forbidden"),
  );
});

test("status carries the owner assertion and the negotiated timeout", async () => {
  let captured: Record<string, unknown> | undefined;
  const transport = {
    async invoke(request: { params?: unknown }) {
      captured = request.params as Record<string, unknown>;
      return { ok: true, workspaces: [], truncated: false };
    },
    async openDuplex() {
      throw new Error("unused");
    },
    async listNodes() {
      return [{ nodeId: "node-1" }];
    },
  };
  await managedStatus(transport, { timeoutMs: 45_000 } as never, {
    node: "node-1",
    owner: { agentId: "main", sessionKey: "agent:main:test" },
  });
  assert.deepEqual(captured?.owner, { agentId: "main", sessionKey: "agent:main:test" });
  assert.equal(captured?.timeoutMs, 45_000);
});

test("the node deadline keeps a response grace inside the Gateway budget", () => {
  assert.equal(nodeDeadline(60_000, 1_000), 1_000 + 60_000 - NODE_RESPONSE_GRACE_MS);
  assert.equal(nodeDeadline(1_000, 1_000), 2_000);
});

test("status and fetch requests accept a negotiated budget", () => {
  const status = parseStatusRequest({
    owner: { agentId: "main", sessionKey: null },
    timeoutMs: 7_000,
  });
  assert.equal(status.timeoutMs, 7_000);
  assert.equal(status.owner.agentId, "main");
  const fetch = parseFetchRequest({ remotePath: "/srv/a", maxBytes: 10, timeoutMs: 6_000 }, 100);
  assert.equal(fetch.timeoutMs, 6_000);
});

test("status verification observes the invocation abort signal", async () => {
  const nodeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-status-abort-"));
  await fs.mkdir(path.join(nodeRoot, "app"));
  await fs.writeFile(path.join(nodeRoot, "app", "a.txt"), "alpha");
  const raw = { node: { pushRoots: [nodeRoot] } };
  const commands = createNodeCommands(raw).commands;
  const status = commands.find((command) => command.command === "nodews.status");
  assert.ok(status);
  const controller = new AbortController();
  controller.abort(new Error("cancelled by test"));
  await assert.rejects(
    () =>
      status.handle(
        JSON.stringify({
          owner: { agentId: "main", sessionKey: "agent:main:test" },
          remotePath: path.join(nodeRoot, "app"),
          verify: true,
        }),
        undefined,
        { signal: controller.signal, sessionKey: "agent:main:test" },
      ),
    isCode("canceled"),
  );
});

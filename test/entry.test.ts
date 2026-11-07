import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import entry from "../src/index.js";
import { createNodeCommands } from "../src/node/commands.js";
import { createHarness } from "./helpers/sim.js";

test("the plugin registers its three tools, three node commands and one invoke policy", async () => {
  const raw = {
    gateway: { localRoots: [os.tmpdir()] },
    node: { pushRoots: [os.tmpdir()] },
  };
  const harness = createHarness(createNodeCommands(raw).commands);
  const tools: string[] = [];
  const commands: string[] = [];
  const policies: { commands: string[]; dangerous?: boolean }[] = [];

  const api = {
    pluginConfig: raw,
    runtime: {
      nodes: {
        openDuplex: (request: Parameters<typeof harness.transport.openDuplex>[0]) =>
          harness.transport.openDuplex(request),
        invoke: (request: Parameters<typeof harness.transport.invoke>[0]) => harness.transport.invoke(request),
        list: async () => ({ nodes: await harness.transport.listNodes() }),
      },
    },
    session: { controls: { registerSessionAction: () => undefined } },
    registerService: () => undefined,
    registerTool: (tool: unknown) => {
      const candidates =
        typeof tool === "function"
          ? (tool as (ctx: { sessionKey?: string; agentId?: string }) => unknown)({
              sessionKey: "agent:main:test",
              agentId: "main",
            })
          : tool;
      for (const candidate of Array.isArray(candidates) ? candidates : [candidates]) {
        tools.push((candidate as { name: string }).name);
      }
    },
    registerNodeHostCommand: (command: { command: string }) => {
      commands.push(command.command);
    },
    registerNodeInvokePolicy: (policy: { commands: string[]; dangerous?: boolean }) => {
      policies.push(policy);
    },
  };

  entry.register(api as unknown as OpenClawPluginApi);
  assert.deepEqual(tools.sort(), ["node_workspace_artifact", "node_workspace_push", "node_workspace_status"]);
  assert.deepEqual(commands.sort(), ["nodews.fetch", "nodews.push", "nodews.status"]);
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0]?.commands, ["nodews.push", "nodews.fetch", "nodews.status"]);
  assert.equal(policies[0]?.dangerous, true);

  const manifest = JSON.parse(
    await fs.readFile(path.join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
  ) as { contracts: { tools: string[] } };
  assert.deepEqual([...manifest.contracts.tools].sort(), tools.sort());
});

test("the registered push tool publishes through the injected runtime and returns node plus cwd", async () => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-entry-src-"));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-entry-dst-"));
  await fs.writeFile(path.join(source, "a.txt"), "alpha");
  const raw = {
    gateway: { localRoots: [source], timeoutMs: 20_000 },
    node: { pushRoots: [destination] },
  };
  const harness = createHarness(createNodeCommands(raw).commands);
  type PushTool = {
    outputSchema?: unknown;
    execute: (
      id: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: (update: unknown) => void,
    ) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
  };
  let pushTool: PushTool | undefined;

  const api = {
    pluginConfig: raw,
    runtime: {
      nodes: {
        openDuplex: (request: Parameters<typeof harness.transport.openDuplex>[0]) =>
          harness.transport.openDuplex(request),
        invoke: (request: Parameters<typeof harness.transport.invoke>[0]) => harness.transport.invoke(request),
        list: async () => ({ nodes: await harness.transport.listNodes() }),
      },
    },
    session: {
      controls: {
        registerSessionAction: () => undefined,
      },
    },
    registerService: () => undefined,
    registerTool: (tool: unknown) => {
      const candidates =
        typeof tool === "function"
          ? (tool as (ctx: { sessionKey?: string; agentId?: string }) => unknown)({
              sessionKey: "agent:main:test",
              agentId: "main",
            })
          : tool;
      for (const candidate of Array.isArray(candidates) ? candidates : [candidates]) {
        if ((candidate as { name?: string }).name === "node_workspace_push") pushTool = candidate as PushTool;
      }
    },
    registerNodeHostCommand: () => undefined,
    registerNodeInvokePolicy: () => undefined,
  };
  entry.register(api as unknown as OpenClawPluginApi);
  assert.ok(pushTool);

  const remotePath = path.join(destination, "app");
  const result = await pushTool.execute("call-1", { node: "node-1", localPath: source, remotePath }, undefined, () => {
    // progress is exercised by the engine tests
  });
  assert.equal(result.details.nodeId, "node-1");
  assert.equal(result.details.cwd, remotePath);
  assert.match(result.content[0]?.text ?? "", /host=node/);
  assert.equal(await fs.readFile(path.join(remotePath, "a.txt"), "utf8"), "alpha");

  await fs.writeFile(path.join(source, "a.txt"), "changed");
  const conflict = await pushTool.execute("conflict", { node: "node-1", localPath: source, remotePath });
  assert.equal(conflict.details.ok, false);
  assert.equal(conflict.details.code, "destination-exists");
  assert.equal(typeof conflict.details.pushId, "string");
  const { Value } = await import("typebox/value");
  assert.equal(Value.Check(pushTool.outputSchema as never, conflict.details), true);
  assert.equal(Value.Check(pushTool.outputSchema as never, conflict.details) && conflict.details.node, "node-1");

  for (const args of [
    { node: "", localPath: source, remotePath },
    { node: "node-1", localPath: 5, remotePath },
    null,
  ]) {
    const bad = await pushTool.execute("bad", args);
    assert.equal(bad.details.ok, false);
    assert.equal(bad.details.code, "path-invalid");
    assert.match(bad.content[0]?.text ?? "", /path-invalid/);
    const { Value } = await import("typebox/value");
    assert.equal(Value.Check(pushTool.outputSchema as never, bad.details), true);
  }
});

test("toolFailure preserves unknown-outcome as an actionable tool result", async () => {
  const { toolFailure } = await import("../src/gateway/tools.js");
  const { NodeWorkspaceError } = await import("../src/errors.js");
  const result = toolFailure(
    "node_workspace_push",
    new NodeWorkspaceError("unknown-outcome", "transport died", {
      pushId: "abc",
      nodeId: "node-1",
      remotePath: "/srv/app",
    }),
  );
  assert.equal(result.details.ok, false);
  assert.equal(result.details.code, "unknown-outcome");
  assert.equal(result.details.unknownOutcome, true);
  assert.equal(result.details.pushId, "abc");
  assert.match(result.content[0]?.text ?? "", /UNKNOWN OUTCOME/);
});

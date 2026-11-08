import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import entry from "../src/index.js";
import { createNodeCommands } from "../src/node/commands.js";
import { createHarness } from "./helpers/sim.js";

test("the plugin registers its five tools, five node commands and one invoke policy", async () => {
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
    session: {
      controls: {
        registerSessionAction: () => undefined,
        registerControlUiDescriptor: () => undefined,
      },
    },
    registerService: () => undefined,
    registerTool: (tool: unknown) => {
      const candidates =
        typeof tool === "function"
          ? (tool as (ctx: { sessionKey?: string; agentId?: string; workspaceDir?: string }) => unknown)({
              sessionKey: "agent:main:test",
              agentId: "main",
              workspaceDir: os.tmpdir(),
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
  assert.deepEqual(tools.sort(), [
    "node_workspace_artifact",
    "node_workspace_changes",
    "node_workspace_push",
    "node_workspace_return",
    "node_workspace_status",
  ]);
  assert.deepEqual(commands.sort(), ["nodews.fetch", "nodews.push", "nodews.return", "nodews.status", "nodews.tree"]);
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0]?.commands, [
    "nodews.push",
    "nodews.fetch",
    "nodews.status",
    "nodews.tree",
    "nodews.return",
  ]);
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
        registerControlUiDescriptor: () => undefined,
      },
    },
    registerService: () => undefined,
    registerTool: (tool: unknown) => {
      const candidates =
        typeof tool === "function"
          ? (tool as (ctx: { sessionKey?: string; agentId?: string; workspaceDir?: string }) => unknown)({
              sessionKey: "agent:main:test",
              agentId: "main",
              workspaceDir: source,
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

  // An unchanged incremental publish reuses the whole base; the text has to say
  // so, otherwise the caller cannot tell the delta path from a full copy.
  const incrementalPath = path.join(destination, "app-incremental");
  const incremental = await pushTool.execute("call-incremental", {
    node: "node-1",
    localPath: source,
    remotePath: incrementalPath,
    incrementalFrom: remotePath,
  });
  assert.equal(incremental.details.ok, true);
  assert.equal(incremental.details.transferredBytes, 0);
  assert.ok(Number(incremental.details.reusedFiles) > 0);
  assert.match(incremental.content[0]?.text ?? "", /reused from the base/);
  assert.match(incremental.content[0]?.text ?? "", /0\.00 MiB transferred\. One-way copy/);

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

test("the tool factory falls back to the agent workspace when the session provides none", async () => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-entry-fallback-"));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-entry-fallback-dst-"));
  await fs.writeFile(path.join(source, "a.txt"), "alpha");
  const raw = { gateway: { timeoutMs: 20_000 }, node: { pushRoots: [destination] } };
  const harness = createHarness(createNodeCommands(raw).commands);
  type PushTool = {
    execute: (id: string, params: unknown) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
  };
  let pushTool: PushTool | undefined;
  let resolverCalls = 0;

  const api = {
    pluginConfig: raw,
    runtime: {
      nodes: {
        openDuplex: (request: Parameters<typeof harness.transport.openDuplex>[0]) =>
          harness.transport.openDuplex(request),
        invoke: (request: Parameters<typeof harness.transport.invoke>[0]) => harness.transport.invoke(request),
        list: async () => ({ nodes: await harness.transport.listNodes() }),
      },
      agent: {
        resolveAgentWorkspaceDir: () => {
          resolverCalls += 1;
          return source;
        },
      },
      config: { current: () => ({}) },
    },
    session: {
      controls: {
        registerSessionAction: () => undefined,
        registerControlUiDescriptor: () => undefined,
      },
    },
    registerService: () => undefined,
    registerTool: (tool: unknown) => {
      const candidates =
        typeof tool === "function"
          ? (tool as (ctx: { sessionKey?: string; agentId?: string }) => unknown)({
              sessionKey: "agent:main:fallback",
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

  const result = await pushTool.execute("call-fallback", {
    node: "node-1",
    localPath: source,
    remotePath: path.join(destination, "app"),
  });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.nodeId, "node-1");
  assert.equal(resolverCalls, 1);
  assert.equal(await fs.readFile(path.join(destination, "app", "a.txt"), "utf8"), "alpha");
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

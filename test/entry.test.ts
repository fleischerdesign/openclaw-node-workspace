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
  assert.deepEqual(tools.sort(), ["node_workspace_artifact", "node_workspace_status", "node_workspace_sync"]);
  assert.deepEqual(commands.sort(), ["nodews.fetch", "nodews.status", "nodews.sync"]);
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0]?.commands, ["nodews.sync", "nodews.fetch", "nodews.status"]);
  assert.equal(policies[0]?.dangerous, true);

  const manifest = JSON.parse(
    await fs.readFile(path.join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
  ) as { contracts: { tools: string[] } };
  assert.deepEqual([...manifest.contracts.tools].sort(), tools.sort());
});

test("the registered sync tool previews, applies through the injected runtime, and returns node plus cwd", async () => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-entry-src-"));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-entry-dst-"));
  await fs.writeFile(path.join(source, "a.txt"), "alpha");
  const raw = {
    gateway: { localRoots: [source], timeoutMs: 20_000 },
    node: { pushRoots: [destination] },
  };
  const harness = createHarness(createNodeCommands(raw).commands);
  type SyncTool = {
    outputSchema?: unknown;
    execute: (
      id: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: (update: unknown) => void,
    ) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
  };
  let syncTool: SyncTool | undefined;

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
        if ((candidate as { name?: string }).name === "node_workspace_sync") syncTool = candidate as SyncTool;
      }
    },
    registerNodeHostCommand: () => undefined,
    registerNodeInvokePolicy: () => undefined,
  };
  entry.register(api as unknown as OpenClawPluginApi);
  assert.ok(syncTool);

  const remotePath = path.join(destination, "app");
  const planned = await syncTool.execute("call-preview", {
    node: "node-1",
    localPath: source,
    remotePath,
    mode: "preview",
    create: true,
  });
  assert.equal(planned.details.ok, true);
  assert.equal(planned.details.status, "planned");
  const { Value } = await import("typebox/value");
  assert.equal(Value.Check(syncTool.outputSchema as never, planned.details), true);

  const result = await syncTool.execute("call-apply", {
    node: "node-1",
    localPath: source,
    remotePath,
    create: true,
    planDigest: planned.details.planDigest,
    operationId: "a".repeat(32),
  });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.nodeId, "node-1");
  assert.equal(result.details.cwd, remotePath);
  assert.match(result.content[0]?.text ?? "", /host=node/);
  assert.equal(await fs.readFile(path.join(remotePath, "a.txt"), "utf8"), "alpha");
  assert.equal(Value.Check(syncTool.outputSchema as never, result.details), true);

  await fs.writeFile(path.join(source, "a.txt"), "changed");
  const routine = await syncTool.execute("call-routine", {
    node: "node-1",
    localPath: source,
    remotePath,
    operationId: "b".repeat(32),
  });
  assert.equal(routine.details.ok, true);
  assert.equal(routine.details.status, "applied");
  assert.equal(await fs.readFile(path.join(remotePath, "a.txt"), "utf8"), "changed");

  for (const args of [
    { node: "", localPath: source, remotePath },
    { node: "node-1", localPath: 5, remotePath },
    null,
  ]) {
    const bad = await syncTool.execute("bad", args);
    assert.equal(bad.details.ok, false);
    assert.equal(bad.details.code, "path-invalid");
    assert.match(bad.content[0]?.text ?? "", /path-invalid/);
  }
});

test("the tool factory falls back to the agent workspace when the session provides none", async () => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-entry-fallback-"));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-entry-fallback-dst-"));
  await fs.writeFile(path.join(source, "a.txt"), "alpha");
  const raw = { gateway: { timeoutMs: 20_000 }, node: { pushRoots: [destination] } };
  const harness = createHarness(createNodeCommands(raw).commands);
  type SyncTool = {
    execute: (id: string, params: unknown) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
  };
  let syncTool: SyncTool | undefined;
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
        if ((candidate as { name?: string }).name === "node_workspace_sync") syncTool = candidate as SyncTool;
      }
    },
    registerNodeHostCommand: () => undefined,
    registerNodeInvokePolicy: () => undefined,
  };
  entry.register(api as unknown as OpenClawPluginApi);
  assert.ok(syncTool);

  const previewOutcome = await syncTool.execute("call-fallback", {
    node: "node-1",
    localPath: source,
    remotePath: path.join(destination, "app"),
    mode: "preview",
    create: true,
  });
  assert.equal(previewOutcome.details.ok, true);
  assert.equal(previewOutcome.details.nodeId, "node-1");
  assert.equal(resolverCalls, 1);
});

test("managed tools fail closed when the host supplies no agent identity", async () => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-entry-noagent-"));
  await fs.writeFile(path.join(source, "a.txt"), "alpha");
  const raw = { gateway: { timeoutMs: 20_000 }, node: { pushRoots: [source] } };
  const { createTools } = await import("../src/gateway/tools.js");
  const tools = createTools({
    transport: createHarness(createNodeCommands(raw).commands).transport,
    config: (await import("../src/config.js")).resolvePluginConfig(raw).gateway,
    configError: undefined,
    workspaceDir: source,
  });
  const syncTool = tools.find((tool) => tool.name === "node_workspace_sync");
  const statusTool = tools.find((tool) => tool.name === "node_workspace_status");
  assert.ok(syncTool && statusTool);
  const syncResult = await syncTool.execute("no-agent", {
    node: "node-1",
    localPath: source,
    remotePath: path.join(source, "app"),
    mode: "preview",
    create: true,
  });
  assert.equal(syncResult.details.code, "identity-unresolved");
  const statusResult = await statusTool.execute("no-agent", { node: "node-1", remotePath: path.join(source, "app") });
  assert.equal(statusResult.details.code, "identity-unresolved");
});

test("toolFailure preserves unknown-outcome as an actionable tool result", async () => {
  const { toolFailure } = await import("../src/gateway/tools.js");
  const { NodeWorkspaceError } = await import("../src/errors.js");
  const result = toolFailure(
    "node_workspace_sync",
    new NodeWorkspaceError("unknown-outcome", "transport died", {
      operationId: "abc",
      nodeId: "node-1",
      remotePath: "/srv/app",
    }),
  );
  assert.equal(result.details.ok, false);
  assert.equal(result.details.code, "unknown-outcome");
  assert.equal(result.details.unknownOutcome, true);
  assert.equal(result.details.operationId, "abc");
  assert.match(result.content[0]?.text ?? "", /UNKNOWN OUTCOME/);
});

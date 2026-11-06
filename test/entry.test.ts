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
    registerTool: (tool: { name: string }) => {
      tools.push(tool.name);
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
    registerTool: (tool: unknown) => {
      const candidate = tool as { name?: string };
      if (candidate.name === "node_workspace_push") pushTool = tool as PushTool;
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

  await assert.rejects(
    () => pushTool.execute("bad-1", { node: "", localPath: source, remotePath }),
    /path-invalid/,
  );
  await assert.rejects(
    () => pushTool.execute("bad-2", { node: "node-1", localPath: 5, remotePath }),
    /path-invalid/,
  );
  await assert.rejects(() => pushTool.execute("bad-3", null), /path-invalid/);
});

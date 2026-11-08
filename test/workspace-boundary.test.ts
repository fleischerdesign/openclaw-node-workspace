import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePluginConfig } from "../src/config.js";
import { NodeWorkspaceError } from "../src/errors.js";
import { pushWorkspace } from "../src/gateway/push.js";
import { createTools } from "../src/gateway/tools.js";
import {
  assertLocalAccess,
  resolveWorkspaceBoundary,
  type WorkspaceBoundary,
} from "../src/gateway/workspace-boundary.js";
import { resolveToolWorkspace } from "../src/gateway/workspace-root.js";
import { createNodeCommands } from "../src/node/commands.js";
import { createHarness } from "./helpers/sim.js";

async function directory(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function isCode(code: string) {
  return (error: unknown): boolean => error instanceof NodeWorkspaceError && error.code === code;
}

test("a path inside the session workspace is accepted", async () => {
  const workspace = await directory("nodews-bound-");
  const inside = path.join(workspace, "project");
  await fs.mkdir(inside);
  const boundary = await resolveWorkspaceBoundary(workspace, "push a workspace");
  await assert.doesNotReject(assertLocalAccess(boundary, inside, "workspace", [], "gateway.localRoots"));
  assert.equal(boundary.root, await fs.realpath(workspace));
});

test("a path outside the session workspace is refused and the workspace is named", async () => {
  const workspace = await directory("nodews-bound-");
  const outside = await directory("nodews-bound-out-");
  const boundary = await resolveWorkspaceBoundary(workspace, "push a workspace");
  await assert.rejects(assertLocalAccess(boundary, outside, "workspace", [], "gateway.localRoots"), (error: unknown) => {
    assert.ok(isCode("path-outside-root")(error));
    assert.match((error as Error).message, new RegExp(boundary.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    return true;
  });
});

test("the session workspace wins over the agent workspace and does not widen to it", async () => {
  const sessionWorkspace = await directory("nodews-session-");
  const agentWorkspace = await directory("nodews-agent-");
  const agentProject = path.join(agentWorkspace, "project");
  await fs.mkdir(agentProject);

  const resolved = resolveToolWorkspace({
    context: { workspaceDir: sessionWorkspace, agentId: "main", config: {} },
    resolveAgentWorkspaceDir: () => agentWorkspace,
  });
  assert.equal(resolved.workspaceDir, sessionWorkspace);

  const boundary = await resolveWorkspaceBoundary(resolved.workspaceDir, "push a workspace");
  // Inside the agent workspace but outside the session workspace: refused.
  await assert.rejects(
    assertLocalAccess(boundary, agentProject, "workspace", [], "gateway.localRoots"),
    isCode("path-outside-root"),
  );
});

test("the agent workspace is the fallback when the host provides no session workspace", async () => {
  const agentWorkspace = await directory("nodews-agent-");
  const calls: { config: unknown; agentId: string }[] = [];
  const config = { agents: {} };
  const resolved = resolveToolWorkspace({
    context: { agentId: "main", config },
    resolveAgentWorkspaceDir: (cfg, agentId) => {
      calls.push({ config: cfg, agentId });
      return agentWorkspace;
    },
  });
  assert.equal(resolved.workspaceDir, agentWorkspace);
  assert.deepEqual(calls, [{ config, agentId: "main" }]);
  assert.equal(resolved.workspaceError, undefined);

  const boundary: WorkspaceBoundary = await resolveWorkspaceBoundary(resolved.workspaceDir, "push a workspace");
  await assert.doesNotReject(
    assertLocalAccess(boundary, path.join(agentWorkspace, "project"), "workspace", [], "gateway.localRoots"),
  );
});

test("no workspace at all fails closed", async () => {
  const resolved = resolveToolWorkspace({
    context: { sessionKey: "agent:main:noworkspace" },
    resolveAgentWorkspaceDir: undefined,
  });
  assert.equal(resolved.workspaceDir, undefined);
  assert.ok(typeof resolved.workspaceError === "string" && resolved.workspaceError.length > 0);

  await assert.rejects(resolveWorkspaceBoundary(undefined, "push a workspace"), isCode("workspace-unresolved"));

  // The factory refuses before any path is read, and the refusal is coded.
  const raw = { gateway: {}, node: {} };
  const harness = createHarness(createNodeCommands(raw).commands);
  const tool = createTools({
    transport: harness.transport,
    config: resolvePluginConfig(raw).gateway,
    configError: undefined,
    ...(resolved.workspaceError !== undefined ? { workspaceError: resolved.workspaceError } : {}),
  }).find((candidate) => candidate.name === "node_workspace_push");
  assert.ok(tool);
  const result = await tool.execute("call-noworkspace", {
    node: "node-1",
    localPath: "/tmp",
    remotePath: "/tmp/nodews-noworkspace",
  });
  assert.equal(result.details.ok, false);
  assert.equal(result.details.code, "workspace-unresolved");
});

test("gateway.localRoots narrows the session workspace when set", async () => {
  const workspace = await directory("nodews-narrow-");
  const allowed = path.join(workspace, "allowed");
  const other = path.join(workspace, "other");
  await fs.mkdir(allowed);
  await fs.mkdir(other);
  const boundary = await resolveWorkspaceBoundary(workspace, "push a workspace");

  await assert.doesNotReject(assertLocalAccess(boundary, allowed, "workspace", [allowed], "gateway.localRoots"));
  await assert.rejects(
    assertLocalAccess(boundary, other, "workspace", [allowed], "gateway.localRoots"),
    isCode("path-outside-root"),
  );
});

test("a push outside the session workspace is refused before the channel opens", async () => {
  const workspace = await directory("nodews-push-session-");
  const source = path.join(workspace, "project");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "a.txt"), "alpha");
  const outside = await directory("nodews-push-outside-");
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
  const destination = await directory("nodews-push-session-dst-");
  const raw = { gateway: {}, node: { pushRoots: [destination] } };
  const harness = createHarness(createNodeCommands(raw).commands);
  const config = resolvePluginConfig(raw).gateway;

  await assert.rejects(
    pushWorkspace(harness.transport, config, {
      node: "node-1",
      localPath: outside,
      workspaceRoot: workspace,
      remotePath: path.join(destination, "app"),
      incrementalFrom: undefined,
      exclude: undefined,
      signal: undefined,
      progress: undefined,
    }),
    isCode("path-outside-root"),
  );
  assert.deepEqual(harness.opens, []);

  const outcome = await pushWorkspace(harness.transport, config, {
    node: "node-1",
    localPath: source,
    workspaceRoot: workspace,
    remotePath: path.join(destination, "app"),
    incrementalFrom: undefined,
    exclude: undefined,
    signal: undefined,
    progress: undefined,
  });
  assert.equal(outcome.status, "published");
});

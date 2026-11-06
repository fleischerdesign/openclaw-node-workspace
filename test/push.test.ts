import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePluginConfig } from "../src/config.js";
import { NodeWorkspaceError } from "../src/errors.js";
import { pushWorkspace, type PushProgress } from "../src/gateway/push.js";
import { createNodeCommands } from "../src/node/commands.js";
import { createHarness } from "./helpers/sim.js";

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-push-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

async function setup(source: Record<string, string>) {
  const sourceRoot = await workspace(source);
  const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-dest-"));
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-art-"));
  const raw = {
    gateway: {
      localRoots: [sourceRoot],
      artifactRoots: [artifactRoot],
      chunkBytes: 1024,
      timeoutMs: 20_000,
      maxFiles: 100,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    },
    node: {
      pushRoots: [destinationRoot],
      artifactRoots: [destinationRoot],
      maxFiles: 100,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    },
  };
  const config = resolvePluginConfig(raw);
  const node = createNodeCommands(raw);
  assert.equal(node.configError, undefined);
  const harness = createHarness(node.commands);
  return { sourceRoot, destinationRoot, artifactRoot, config, harness };
}

test("push publishes a verified one-way copy and reports the remote cwd", async () => {
  const { sourceRoot, destinationRoot, config, harness } = await setup({
    "a.txt": "alpha",
    "sub/b.txt": "beta",
    "empty/keep/.gitkeep": "",
  });
  const progress: PushProgress[] = [];
  const outcome = await pushWorkspace(harness.transport, config.gateway, {
    node: "Node One",
    localPath: sourceRoot,
    remotePath: path.join(destinationRoot, "app"),
    replace: false,
    exclude: undefined,
    signal: undefined,
    progress: (entry) => progress.push(entry),
  });

  assert.equal(outcome.status, "published");
  assert.equal(outcome.nodeId, "node-1");
  assert.equal(outcome.cwd, path.join(destinationRoot, "app"));
  assert.equal(outcome.files, 3);
  assert.equal(await fs.readFile(path.join(outcome.cwd, "a.txt"), "utf8"), "alpha");
  assert.equal(await fs.readFile(path.join(outcome.cwd, "sub/b.txt"), "utf8"), "beta");

  const marker = JSON.parse(
    await fs.readFile(path.join(outcome.cwd, ".openclaw-node-workspace.json"), "utf8"),
  ) as { pushId: string; digest: string };
  assert.equal(marker.pushId, outcome.pushId);
  assert.equal(marker.digest, outcome.digest);
  assert.ok(progress.some((entry) => entry.phase === "scanning"));
  assert.ok(progress.some((entry) => entry.phase === "sending"));
  assert.ok(progress.some((entry) => entry.phase === "publishing"));
  const leftovers = (await fs.readdir(destinationRoot)).filter((name) => name.includes(".nodews-"));
  assert.deepEqual(leftovers, []);
});

test("a repeated identical push is reported as already applied", async () => {
  const { sourceRoot, destinationRoot, config, harness } = await setup({ "a.txt": "alpha" });
  const input = {
    node: "node-1",
    localPath: sourceRoot,
    remotePath: path.join(destinationRoot, "app"),
    replace: false,
    exclude: undefined,
    signal: undefined,
    progress: undefined,
  };
  const first = await pushWorkspace(harness.transport, config.gateway, input);
  const second = await pushWorkspace(harness.transport, config.gateway, input);
  assert.equal(first.status, "published");
  assert.equal(second.status, "already-applied");
  assert.equal(second.pushId, first.pushId);
});

test("a changed workspace at an occupied destination requires an owned replace", async () => {
  const { sourceRoot, destinationRoot, config, harness } = await setup({ "a.txt": "alpha" });
  const remotePath = path.join(destinationRoot, "app");
  const base = {
    node: "node-1",
    localPath: sourceRoot,
    remotePath,
    exclude: undefined,
    signal: undefined,
    progress: undefined,
  };
  await pushWorkspace(harness.transport, config.gateway, { ...base, replace: false });

  await fs.writeFile(path.join(sourceRoot, "a.txt"), "changed");
  await assert.rejects(
    () => pushWorkspace(harness.transport, config.gateway, { ...base, replace: false }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "destination-exists",
  );

  const replaced = await pushWorkspace(harness.transport, config.gateway, { ...base, replace: true });
  assert.equal(replaced.status, "published");
  assert.equal(replaced.replaced, true);
  assert.equal(await fs.readFile(path.join(remotePath, "a.txt"), "utf8"), "changed");
});

test("replace never clobbers a foreign directory", async () => {
  const { sourceRoot, destinationRoot, config, harness } = await setup({ "a.txt": "alpha" });
  const remotePath = path.join(destinationRoot, "foreign");
  await fs.mkdir(remotePath);
  await fs.writeFile(path.join(remotePath, "precious.txt"), "keep");
  await assert.rejects(
    () =>
      pushWorkspace(harness.transport, config.gateway, {
        node: "node-1",
        localPath: sourceRoot,
        remotePath,
        replace: true,
        exclude: undefined,
        signal: undefined,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "destination-not-owned",
  );
  assert.equal(await fs.readFile(path.join(remotePath, "precious.txt"), "utf8"), "keep");
});

test("a destination outside the node roots is rejected before anything is written", async () => {
  const { sourceRoot, config, harness } = await setup({ "a.txt": "alpha" });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-outside-"));
  await assert.rejects(
    () =>
      pushWorkspace(harness.transport, config.gateway, {
        node: "node-1",
        localPath: sourceRoot,
        remotePath: path.join(outside, "app"),
        replace: false,
        exclude: undefined,
        signal: undefined,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "path-outside-root",
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test("a symlinked parent cannot escape a node push root", async () => {
  const { sourceRoot, destinationRoot, config, harness } = await setup({ "a.txt": "alpha" });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-escape-"));
  await fs.symlink(outside, path.join(destinationRoot, "link"));
  await assert.rejects(
    () =>
      pushWorkspace(harness.transport, config.gateway, {
        node: "node-1",
        localPath: sourceRoot,
        remotePath: path.join(destinationRoot, "link", "app"),
        replace: false,
        exclude: undefined,
        signal: undefined,
        progress: undefined,
      }),
    (error: unknown) =>
      error instanceof NodeWorkspaceError &&
      (error.code === "symlink-rejected" || error.code === "path-outside-root"),
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test("transport loss after acceptance is an explicit unknown outcome, not a failure", async () => {
  const sourceRoot = await workspace({ "a.txt": "alpha" });
  const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-dest-"));
  const raw = {
    gateway: { localRoots: [sourceRoot], chunkBytes: 1024, timeoutMs: 20_000 },
    node: { pushRoots: [destinationRoot] },
  };
  const config = resolvePluginConfig(raw);
  const harness = createHarness(createNodeCommands(raw).commands, { closeAfterGatewayFrames: 2 });
  await assert.rejects(
    () =>
      pushWorkspace(harness.transport, config.gateway, {
        node: "node-1",
        localPath: sourceRoot,
        remotePath: path.join(destinationRoot, "app"),
        replace: false,
        exclude: undefined,
        signal: undefined,
        progress: undefined,
      }),
    (error: unknown) => {
      assert.ok(error instanceof NodeWorkspaceError);
      assert.equal(error.code, "unknown-outcome");
      assert.match(error.message, /Do not retry blindly/);
      return true;
    },
  );
});

test("a tampered file is rejected by the node's per-file digest", async () => {
  const sourceRoot = await workspace({ "a.txt": "alpha" });
  const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-dest-"));
  const raw = {
    gateway: { localRoots: [sourceRoot], chunkBytes: 1024, timeoutMs: 20_000 },
    node: { pushRoots: [destinationRoot] },
  };
  const config = resolvePluginConfig(raw);
  const harness = createHarness(createNodeCommands(raw).commands, {
    gatewayFrame: (frame) => {
      if (frame[0] !== 1) return undefined;
      const copy = new Uint8Array(frame);
      copy[copy.length - 1] ^= 0xff;
      return copy;
    },
  });
  await assert.rejects(
    () =>
      pushWorkspace(harness.transport, config.gateway, {
        node: "node-1",
        localPath: sourceRoot,
        remotePath: path.join(destinationRoot, "app"),
        replace: false,
        exclude: undefined,
        signal: undefined,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && (error.code === "integrity" || error.code === "unknown-outcome"),
  );
  assert.equal(
    await fs
      .lstat(path.join(destinationRoot, "app"))
      .then(() => true)
      .catch(() => false),
    false,
  );
});

test("a local path outside gateway.localRoots is never scanned", async () => {
  const { config, harness } = await setup({ "a.txt": "alpha" });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-local-out-"));
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
  await assert.rejects(
    () =>
      pushWorkspace(harness.transport, config.gateway, {
        node: "node-1",
        localPath: outside,
        remotePath: path.join(outside, "copy"),
        replace: false,
        exclude: undefined,
        signal: undefined,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "path-outside-root",
  );
  assert.deepEqual(harness.opens, []);
});

test("a symlinked destination is rejected, not replaced", async () => {
  const { sourceRoot, destinationRoot, config, harness } = await setup({ "a.txt": "alpha" });
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-symlink-dest-"));
  await fs.symlink(target, path.join(destinationRoot, "app"));
  await assert.rejects(
    () =>
      pushWorkspace(harness.transport, config.gateway, {
        node: "node-1",
        localPath: sourceRoot,
        remotePath: path.join(destinationRoot, "app"),
        replace: true,
        exclude: undefined,
        signal: undefined,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "symlink-rejected",
  );
});

test("a foreign marker does not make a directory replaceable", async () => {
  const { sourceRoot, destinationRoot, config, harness } = await setup({ "a.txt": "alpha" });
  const remotePath = path.join(destinationRoot, "app");
  await fs.mkdir(remotePath);
  await fs.writeFile(
    path.join(remotePath, ".openclaw-node-workspace.json"),
    JSON.stringify({ plugin: "someone-else", protocol: 1, pushId: "a".repeat(32), digest: "b".repeat(64) }),
  );
  await assert.rejects(
    () =>
      pushWorkspace(harness.transport, config.gateway, {
        node: "node-1",
        localPath: sourceRoot,
        remotePath,
        replace: true,
        exclude: undefined,
        signal: undefined,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "destination-not-owned",
  );
});

test("the node validates a hello that never passed Gateway scanning", async () => {
  const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-dest-"));
  const raw = { node: { pushRoots: [destinationRoot] } };
  const node = createNodeCommands(raw);
  assert.equal(node.configError, undefined);
  const push = node.commands.find((command) => command.command === "nodews.push");
  assert.ok(push);
  assert.equal(push.duplex, true);
  assert.equal(push.dangerous, true);
  await assert.rejects(
    async () => push.handle(undefined, { signal: undefined }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "protocol",
  );
});

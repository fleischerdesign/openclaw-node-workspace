import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePluginConfig } from "../src/config.js";
import { NodeWorkspaceError } from "../src/errors.js";
import { pushWorkspace } from "../src/gateway/push.js";
import { createNodeCommands } from "../src/node/commands.js";
import { createHarness } from "./helpers/sim.js";

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-inc-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

async function setup(files: Record<string, string>) {
  const sourceRoot = await workspace(files);
  const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-inc-dst-"));
  const raw = {
    gateway: {
      localRoots: [sourceRoot],
      artifactRoots: [sourceRoot],
      returnRoots: [sourceRoot],
      chunkBytes: 1024,
      timeoutMs: 20_000,
      maxFiles: 100,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    },
    node: {
      pushRoots: [destinationRoot],
      artifactRoots: [destinationRoot],
      returnRoots: [destinationRoot],
      maxFiles: 100,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    },
  };
  const config = resolvePluginConfig(raw);
  const node = createNodeCommands(raw);
  assert.equal(node.configError, undefined);
  const harness = createHarness(node.commands);
  return { sourceRoot, destinationRoot, config, harness };
}

const input = (sourceRoot: string, remotePath: string) => ({
  node: "node-1",
  localPath: sourceRoot,
  remotePath,
  incrementalFrom: undefined as string | undefined,
  exclude: undefined,
  signal: undefined,
  progress: undefined,
});

test("an incremental publish reuses unchanged node files and never mutates its base", async () => {
  const { sourceRoot, destinationRoot, config, harness } = await setup({
    "keep.txt": "keep",
    "change.txt": "one",
    "gone.txt": "gone",
  });
  const base = path.join(destinationRoot, "gen1");
  const first = await pushWorkspace(harness.transport, config.gateway, input(sourceRoot, base));
  assert.equal(first.status, "published");
  assert.equal(first.reusedFiles, 0);

  await fs.writeFile(path.join(sourceRoot, "change.txt"), "two");
  await fs.rm(path.join(sourceRoot, "gone.txt"));
  await fs.writeFile(path.join(sourceRoot, "new.txt"), "new");
  const next = path.join(destinationRoot, "gen2");
  const second = await pushWorkspace(harness.transport, config.gateway, {
    ...input(sourceRoot, next),
    incrementalFrom: base,
  });

  assert.equal(second.status, "published");
  assert.equal(second.reusedFiles, 1);
  assert.equal(second.reusedBytes, Buffer.byteLength("keep"));
  assert.equal(
    second.transferredBytes,
    Buffer.byteLength("two") + Buffer.byteLength("new"),
  );
  assert.equal(await fs.readFile(path.join(next, "keep.txt"), "utf8"), "keep");
  assert.equal(await fs.readFile(path.join(next, "change.txt"), "utf8"), "two");
  assert.equal(await fs.readFile(path.join(next, "new.txt"), "utf8"), "new");
  await assert.rejects(() => fs.readFile(path.join(next, "gone.txt")), /ENOENT/);

  // Deletion is expressed as omission from the new generation. The base keeps
  // every byte it published.
  assert.equal(await fs.readFile(path.join(base, "gone.txt"), "utf8"), "gone");
  assert.equal(await fs.readFile(path.join(base, "change.txt"), "utf8"), "one");
});

test("an incremental publish with no changed files transfers nothing", async () => {
  const { sourceRoot, destinationRoot, config, harness } = await setup({ "a.txt": "alpha", "sub/b.txt": "beta" });
  const base = path.join(destinationRoot, "gen1");
  await pushWorkspace(harness.transport, config.gateway, input(sourceRoot, base));
  const next = path.join(destinationRoot, "gen2");
  const second = await pushWorkspace(harness.transport, config.gateway, { ...input(sourceRoot, next), incrementalFrom: base });
  assert.equal(second.status, "published");
  assert.equal(second.reusedFiles, 2);
  assert.equal(second.transferredBytes, 0);
  assert.equal(await fs.readFile(path.join(next, "sub/b.txt"), "utf8"), "beta");
});

test("a drifted incremental base is refused before a new destination is claimed", async () => {
  const { sourceRoot, destinationRoot, config, harness } = await setup({ "a.txt": "alpha" });
  const base = path.join(destinationRoot, "gen1");
  await pushWorkspace(harness.transport, config.gateway, input(sourceRoot, base));
  await fs.writeFile(path.join(base, "a.txt"), "tampered");

  const next = path.join(destinationRoot, "gen2");
  await assert.rejects(
    () => pushWorkspace(harness.transport, config.gateway, { ...input(sourceRoot, next), incrementalFrom: base }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "conflict",
  );
  await assert.rejects(() => fs.lstat(next), /ENOENT/);
});

test("an incremental base must be a complete plugin publication", async () => {
  const { sourceRoot, destinationRoot, config, harness } = await setup({ "a.txt": "alpha" });
  const foreign = path.join(destinationRoot, "foreign");
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, "a.txt"), "alpha");
  const next = path.join(destinationRoot, "gen2");
  await assert.rejects(
    () => pushWorkspace(harness.transport, config.gateway, { ...input(sourceRoot, next), incrementalFrom: foreign }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "conflict",
  );
  await assert.rejects(() => fs.lstat(next), /ENOENT/);
});

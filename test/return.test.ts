import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePluginConfig } from "../src/config.js";
import { NodeWorkspaceError } from "../src/errors.js";
import { pushWorkspace } from "../src/gateway/push.js";
import { applyReturn, previewReturn } from "../src/gateway/return.js";
import { createNodeCommands } from "../src/node/commands.js";
import { createHarness, type Faults } from "./helpers/sim.js";

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-ret-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

async function setup(files: Record<string, string>, faults: Faults = {}) {
  const sourceRoot = await workspace(files);
  const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-ret-dst-"));
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-ret-art-"));
  const raw = {
    gateway: {
      localRoots: [sourceRoot],
      artifactRoots: [artifactRoot],
      returnRoots: [sourceRoot],
      chunkBytes: 1024,
      timeoutMs: 20_000,
      maxFiles: 100,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    },
    node: {
      pushRoots: [destinationRoot],
      artifactRoots: [artifactRoot],
      returnRoots: [destinationRoot],
      maxFiles: 100,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    },
  };
  const config = resolvePluginConfig(raw);
  const node = createNodeCommands(raw);
  assert.equal(node.configError, undefined);
  const harness = createHarness(node.commands, faults);
  return { sourceRoot, destinationRoot, artifactRoot, config, harness, raw };
}

const pushInput = (sourceRoot: string, remotePath: string) => ({
  node: "node-1",
  localPath: sourceRoot,
  remotePath,
  incrementalFrom: undefined,
  exclude: undefined,
  signal: undefined,
  progress: undefined,
});

const previewInput = (sourceRoot: string, remotePath: string) => ({
  node: "node-1",
  remotePath,
  localPath: sourceRoot,
  include: undefined,
  exclude: undefined,
  signal: undefined,
});

async function published(files: Record<string, string>, faults: Faults = {}) {
  const context = await setup(files, faults);
  const remotePath = path.join(context.destinationRoot, "app");
  await pushWorkspace(context.harness.transport, context.config.gateway, pushInput(context.sourceRoot, remotePath));
  return { ...context, remotePath };
}

test("a return preview reports additions, safe modifications, mode changes and removals without writing", async () => {
  const { sourceRoot, remotePath, config, harness } = await published({
    "src/a.txt": "alpha",
    "src/b.txt": "beta",
    "old.txt": "old",
  });
  await fs.writeFile(path.join(remotePath, "src/a.txt"), "alpha generated");
  await fs.mkdir(path.join(remotePath, "gen"));
  await fs.writeFile(path.join(remotePath, "gen/new.txt"), "new");
  await fs.chmod(path.join(remotePath, "src/b.txt"), 0o755);
  await fs.rm(path.join(remotePath, "old.txt"));

  const preview = await previewReturn(harness.transport, config.gateway, previewInput(sourceRoot, remotePath));
  assert.equal(preview.plan.counts.additions, 1);
  assert.equal(preview.plan.counts.modifications, 1);
  assert.equal(preview.plan.counts.modeChanges, 1);
  assert.equal(preview.plan.counts.conflicts, 0);
  assert.deepEqual(preview.plan.nodeRemoved.map((entry) => entry.path), ["old.txt"]);
  assert.match(preview.plan.planDigest, /^[0-9a-f]{64}$/);
  // Read-only: the local project is untouched.
  assert.equal(await fs.readFile(path.join(sourceRoot, "src/a.txt"), "utf8"), "alpha");
  await assert.rejects(() => fs.lstat(path.join(sourceRoot, "gen/new.txt")), /ENOENT/);

  const outcome = await applyReturn(harness.transport, config.gateway, {
    ...previewInput(sourceRoot, remotePath),
    planDigest: preview.plan.planDigest,
    progress: undefined,
  });
  assert.equal(outcome.applied.filter((entry) => entry.kind === "add").length, 1);
  assert.equal(outcome.applied.filter((entry) => entry.kind === "modify").length, 1);
  assert.equal(outcome.applied.filter((entry) => entry.kind === "chmod").length, 1);
  assert.equal(await fs.readFile(path.join(sourceRoot, "src/a.txt"), "utf8"), "alpha generated");
  assert.equal(await fs.readFile(path.join(sourceRoot, "gen/new.txt"), "utf8"), "new");
  assert.equal((await fs.stat(path.join(sourceRoot, "gen/new.txt"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(sourceRoot, "src/b.txt"))).mode & 0o777, 0o700);
  assert.equal(await fs.readFile(path.join(sourceRoot, "old.txt"), "utf8"), "old");
  assert.deepEqual(outcome.removedOnNode, ["old.txt"]);
  const leftovers = (await fs.readdir(sourceRoot)).filter(
    (name) => name.startsWith(".nodews-return-") && name !== ".nodews-return-state.json",
  );
  assert.deepEqual(leftovers, []);
});

test("a locally modified file is a conflict and is never overwritten", async () => {
  const { sourceRoot, remotePath, config, harness } = await published({ "a.txt": "alpha" });
  await fs.writeFile(path.join(remotePath, "a.txt"), "node version");
  await fs.writeFile(path.join(sourceRoot, "a.txt"), "local version");

  const preview = await previewReturn(harness.transport, config.gateway, previewInput(sourceRoot, remotePath));
  assert.equal(preview.plan.counts.conflicts, 1);
  assert.equal(preview.plan.conflicts[0]?.reason, "local-modified");
  await assert.rejects(
    () =>
      applyReturn(harness.transport, config.gateway, {
        ...previewInput(sourceRoot, remotePath),
        planDigest: preview.plan.planDigest,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "local-conflict",
  );
  assert.equal(await fs.readFile(path.join(sourceRoot, "a.txt"), "utf8"), "local version");
});

test("a file changed on the node after the preview makes the plan stale", async () => {
  const { sourceRoot, remotePath, config, harness } = await published({ "a.txt": "alpha" });
  await fs.writeFile(path.join(remotePath, "a.txt"), "v1");
  const preview = await previewReturn(harness.transport, config.gateway, previewInput(sourceRoot, remotePath));
  await fs.writeFile(path.join(remotePath, "a.txt"), "v2");
  await assert.rejects(
    () =>
      applyReturn(harness.transport, config.gateway, {
        ...previewInput(sourceRoot, remotePath),
        planDigest: preview.plan.planDigest,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "plan-stale",
  );
  assert.equal(await fs.readFile(path.join(sourceRoot, "a.txt"), "utf8"), "alpha");
});

test("a mode-only change is applied without transferring bytes", async () => {
  const { sourceRoot, remotePath, config, harness } = await published({ "run.sh": "#!/bin/sh\n" });
  await fs.chmod(path.join(remotePath, "run.sh"), 0o755);
  const preview = await previewReturn(harness.transport, config.gateway, previewInput(sourceRoot, remotePath));
  assert.equal(preview.plan.counts.modeChanges, 1);
  assert.equal(preview.plan.counts.modifications, 0);
  const outcome = await applyReturn(harness.transport, config.gateway, {
    ...previewInput(sourceRoot, remotePath),
    planDigest: preview.plan.planDigest,
    progress: undefined,
  });
  assert.equal(outcome.bytesTransferred, 0);
  assert.equal((await fs.stat(path.join(sourceRoot, "run.sh"))).mode & 0o777, 0o700);
});

test("a local file changed after the preview makes the plan stale", async () => {
  const { sourceRoot, remotePath, config, harness } = await published({ "a.txt": "alpha" });
  await fs.writeFile(path.join(remotePath, "a.txt"), "node version");
  const preview = await previewReturn(harness.transport, config.gateway, previewInput(sourceRoot, remotePath));
  await fs.writeFile(path.join(sourceRoot, "a.txt"), "local edit after preview");
  await assert.rejects(
    () =>
      applyReturn(harness.transport, config.gateway, {
        ...previewInput(sourceRoot, remotePath),
        planDigest: preview.plan.planDigest,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "plan-stale",
  );
  assert.equal(await fs.readFile(path.join(sourceRoot, "a.txt"), "utf8"), "local edit after preview");
});

test("a generated file never overwrites an unrelated local file without a base", async () => {
  const { sourceRoot, destinationRoot, config, harness } = await setup({ "x.txt": "local" });
  const remote = path.join(destinationRoot, "foreign");
  await fs.mkdir(remote);
  await fs.writeFile(path.join(remote, "x.txt"), "node");
  const preview = await previewReturn(harness.transport, config.gateway, previewInput(sourceRoot, remote));
  assert.equal(preview.plan.counts.conflicts, 1);
  assert.equal(preview.plan.conflicts[0]?.reason, "no-base");
});

test("the node rejects a symlink inside a returned tree", async () => {
  const { sourceRoot, destinationRoot, config, harness } = await setup({ "a.txt": "alpha" });
  const remote = path.join(destinationRoot, "linked");
  await fs.mkdir(remote);
  await fs.symlink("/etc/passwd", path.join(remote, "leak"));
  await assert.rejects(
    () => previewReturn(harness.transport, config.gateway, previewInput(sourceRoot, remote)),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "symlink-rejected",
  );
});

test("a disconnect while receiving leaves no local change and no staging directory", async () => {
  const big = "x".repeat(200 * 1024);
  const { sourceRoot, remotePath, config, raw } = await published({ "big.bin": "seed" });
  await fs.writeFile(path.join(remotePath, "big.bin"), big);
  const healthy = createHarness(createNodeCommands(raw).commands);
  const preview = await previewReturn(healthy.transport, config.gateway, previewInput(sourceRoot, remotePath));
  assert.equal(preview.plan.counts.modifications, 1);
  const faulty = createHarness(createNodeCommands(raw).commands, { closeAfterNodeFrames: 3 });
  await assert.rejects(() =>
    applyReturn(faulty.transport, config.gateway, {
      ...previewInput(sourceRoot, remotePath),
      planDigest: preview.plan.planDigest,
      progress: undefined,
    }),
  );
  assert.equal(await fs.readFile(path.join(sourceRoot, "big.bin"), "utf8"), "seed");
  const leftovers = (await fs.readdir(sourceRoot)).filter(
    (name) => name.startsWith(".nodews-return-") && name !== ".nodews-return-state.json",
  );
  assert.deepEqual(leftovers, []);
});

test("local and node paths are constrained by their configured roots", async () => {
  const { destinationRoot, config, harness } = await setup({ "a.txt": "alpha" });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-ret-out-"));
  await assert.rejects(
    () => previewReturn(harness.transport, config.gateway, previewInput(outside, destinationRoot)),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "path-outside-root",
  );
});

test("a second return of the same generated path remains applicable", async () => {
  const { sourceRoot, remotePath, config, harness } = await published({ "gen.txt": "v0" });
  await fs.writeFile(path.join(remotePath, "gen.txt"), "v1");
  const first = await previewReturn(harness.transport, config.gateway, previewInput(sourceRoot, remotePath));
  await applyReturn(harness.transport, config.gateway, {
    ...previewInput(sourceRoot, remotePath),
    planDigest: first.plan.planDigest,
    progress: undefined,
  });
  assert.equal(await fs.readFile(path.join(sourceRoot, "gen.txt"), "utf8"), "v1");

  await fs.writeFile(path.join(remotePath, "gen.txt"), "v2");
  const second = await previewReturn(harness.transport, config.gateway, previewInput(sourceRoot, remotePath));
  assert.equal(second.plan.counts.conflicts, 0);
  assert.equal(second.plan.counts.modifications, 1);
  await applyReturn(harness.transport, config.gateway, {
    ...previewInput(sourceRoot, remotePath),
    planDigest: second.plan.planDigest,
    progress: undefined,
  });
  assert.equal(await fs.readFile(path.join(sourceRoot, "gen.txt"), "utf8"), "v2");

  const settled = await previewReturn(harness.transport, config.gateway, previewInput(sourceRoot, remotePath));
  assert.equal(settled.plan.operations.length, 0);
  assert.equal(settled.plan.counts.nodeRemoved, 0);
});

test("a local directory at an added path is a conflict, not a late overwrite", async () => {
  const { sourceRoot, remotePath, config, harness } = await published({ "a.txt": "alpha" });
  await fs.writeFile(path.join(remotePath, "tree"), "node file");
  await fs.mkdir(path.join(sourceRoot, "tree"));
  const preview = await previewReturn(harness.transport, config.gateway, previewInput(sourceRoot, remotePath));
  assert.equal(preview.plan.counts.conflicts, 1);
  assert.equal(preview.plan.conflicts[0]?.reason, "target-is-directory");
});

test("an empty node directory is created on return", async () => {
  const { sourceRoot, remotePath, config, harness } = await published({ "a.txt": "alpha" });
  await fs.mkdir(path.join(remotePath, "empty"));
  const preview = await previewReturn(harness.transport, config.gateway, previewInput(sourceRoot, remotePath));
  assert.deepEqual(preview.plan.directories, ["empty"]);
  await applyReturn(harness.transport, config.gateway, {
    ...previewInput(sourceRoot, remotePath),
    planDigest: preview.plan.planDigest,
    progress: undefined,
  });
  assert.equal((await fs.stat(path.join(sourceRoot, "empty"))).isDirectory(), true);
});

test("exclude patterns rescue a node scan before its limits apply", async () => {
  const { sourceRoot, destinationRoot, artifactRoot } = await setup({ "keep.txt": "keep" });
  const remote = path.join(destinationRoot, "bulk");
  await fs.mkdir(path.join(remote, "bulk"), { recursive: true });
  for (let index = 0; index < 120; index += 1) {
    await fs.writeFile(path.join(remote, "bulk", `f${index}.txt`), "x");
  }
  const raw = {
    gateway: {
      localRoots: [sourceRoot],
      artifactRoots: [artifactRoot],
      returnRoots: [sourceRoot],
      exclude: ["bulk"],
      timeoutMs: 20_000,
      maxFiles: 50,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    },
    node: {
      pushRoots: [destinationRoot],
      artifactRoots: [artifactRoot],
      returnRoots: [destinationRoot],
      maxFiles: 50,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    },
  };
  // Reuse the harness's commands are bound to the previous config; build a new
  // pair for this isolated limit case.
  const { createNodeCommands: makeCommands } = await import("../src/node/commands.js");
  const commands = makeCommands(raw);
  const limited = createHarness(commands.commands);
  const config = resolvePluginConfig(raw);
  const preview = await previewReturn(limited.transport, config.gateway, previewInput(sourceRoot, remote));
  assert.equal(preview.plan.counts.additions, 0);
  assert.equal(preview.plan.operations.length, 0);
});

test("a local mode change is a conflict instead of being silently undone", async () => {
  const { sourceRoot, remotePath, config, harness } = await published({ "run.sh": "#!/bin/sh\n" });
  await fs.chmod(path.join(sourceRoot, "run.sh"), 0o755);
  await fs.chmod(path.join(remotePath, "run.sh"), 0o600);
  const preview = await previewReturn(harness.transport, config.gateway, previewInput(sourceRoot, remotePath));
  assert.equal(preview.plan.counts.conflicts, 1);
  assert.equal(preview.plan.conflicts[0]?.reason, "local-modified");
  assert.equal((await fs.stat(path.join(sourceRoot, "run.sh"))).mode & 0o777, 0o755);
});

test("a mode-only change preserves group and other bits", async () => {
  const { sourceRoot, remotePath, config, harness } = await published({ "run.sh": "#!/bin/sh\n" });
  await fs.chmod(path.join(sourceRoot, "run.sh"), 0o644);
  await fs.chmod(path.join(remotePath, "run.sh"), 0o755);
  const preview = await previewReturn(harness.transport, config.gateway, previewInput(sourceRoot, remotePath));
  assert.equal(preview.plan.counts.modeChanges, 1);
  await applyReturn(harness.transport, config.gateway, {
    ...previewInput(sourceRoot, remotePath),
    planDigest: preview.plan.planDigest,
    progress: undefined,
  });
  assert.equal((await fs.stat(path.join(sourceRoot, "run.sh"))).mode & 0o777, 0o744);
});

test("an unverified marker is not used as a conflict base", async () => {
  const { sourceRoot, remotePath, config, harness } = await published({ "a.txt": "alpha" });
  await fs.rm(path.join(sourceRoot, ".nodews-return-state.json"));
  await fs.writeFile(path.join(remotePath, "a.txt"), "node changed");
  const preview = await previewReturn(harness.transport, config.gateway, previewInput(sourceRoot, remotePath));
  assert.equal(preview.plan.counts.conflicts, 1);
  assert.equal(preview.plan.conflicts[0]?.reason, "no-base");
  assert.equal(await fs.readFile(path.join(sourceRoot, "a.txt"), "utf8"), "alpha");
});

test("a plan above the report cap is refused before any write", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-ret-cap-src-"));
  const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-ret-cap-dst-"));
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-ret-cap-art-"));
  const remote = path.join(destinationRoot, "app");
  await fs.mkdir(remote);
  for (let index = 0; index < 201; index += 1) {
    await fs.writeFile(path.join(remote, `f${String(index).padStart(3, "0")}.txt`), "x");
  }
  const raw = {
    gateway: {
      localRoots: [sourceRoot],
      artifactRoots: [artifactRoot],
      returnRoots: [sourceRoot],
      timeoutMs: 20_000,
      maxFiles: 300,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    },
    node: {
      pushRoots: [destinationRoot],
      artifactRoots: [artifactRoot],
      returnRoots: [destinationRoot],
      maxFiles: 300,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    },
  };
  const { createNodeCommands: makeCommands } = await import("../src/node/commands.js");
  const commands = makeCommands(raw);
  const limited = createHarness(commands.commands);
  const config = resolvePluginConfig(raw);
  const preview = await previewReturn(limited.transport, config.gateway, previewInput(sourceRoot, remote));
  assert.equal(preview.plan.operations.length, 201);
  await assert.rejects(
    () =>
      applyReturn(limited.transport, config.gateway, {
        ...previewInput(sourceRoot, remote),
        planDigest: preview.plan.planDigest,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "limit-exceeded",
  );
  assert.deepEqual(await fs.readdir(sourceRoot), []);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePluginConfig } from "../src/config.js";
import { NodeWorkspaceError } from "../src/errors.js";
import { managedStatus } from "../src/gateway/managed-status.js";
import { syncManaged, type SyncInput } from "../src/gateway/sync.js";
import { COMMAND_SYNC, PROTOCOL_VERSION } from "../src/protocol.js";
import { createNodeCommands } from "../src/node/commands.js";
import { createHarness, type Faults } from "./helpers/sim.js";

let counter = 0;
function op(): string {
  counter += 1;
  return counter.toString(16).padStart(32, "0");
}

async function makeSource(files: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-src-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

interface Fixture {
  readonly source: string;
  readonly nodeRoot: string;
  readonly remotePath: string;
  readonly config: ReturnType<typeof resolvePluginConfig>;
  readonly harness: ReturnType<typeof createHarness>;
  readonly makeHarness: (faults: Faults) => ReturnType<typeof createHarness>;
  sync: (overrides: Partial<SyncInput> & { ownerAgent?: string }) => Promise<Awaited<ReturnType<typeof syncManaged>>>;
  syncOn: (
    harness: ReturnType<typeof createHarness>,
    overrides?: Partial<SyncInput> & { ownerAgent?: string },
  ) => Promise<Awaited<ReturnType<typeof syncManaged>>>;
}

async function fixture(files: Record<string, string | Buffer>, faults: Faults = {}): Promise<Fixture> {
  const source = await makeSource(files);
  const nodeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-node-root-"));
  const raw = {
    gateway: {
      localRoots: [source],
      artifactRoots: [source],
      chunkBytes: 1024,
      timeoutMs: 30_000,
      maxFiles: 200,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
    },
    node: {
      pushRoots: [nodeRoot],
      artifactRoots: [nodeRoot],
      maxFiles: 200,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
    },
  };
  const config = resolvePluginConfig(raw);
  const makeHarness = (faults: Faults) => createHarness(createNodeCommands(raw).commands, faults);
  const harness = makeHarness(faults);
  const remotePath = path.join(nodeRoot, "app");
  const syncOn: Fixture["syncOn"] = (active, overrides = {}) => {
    const { ownerAgent, ...rest } = overrides;
    return syncManaged(active.transport, config.gateway, {
      node: "node-1",
      localPath: source,
      remotePath,
      workspaceRoot: source,
      operationId: op(),
      mode: "apply",
      create: true,
      adopt: false,
      adoptPaths: [],
      restore: [],
      rebind: false,
      expectedRevision: undefined,
      planDigest: undefined,
      policy: {},
      owner: { agentId: ownerAgent ?? "main", sessionKey: "agent:main:test" },
      signal: undefined,
      progress: undefined,
      ...rest,
    });
  };
  const sync: Fixture["sync"] = (overrides) => syncOn(harness, overrides);
  return { source, nodeRoot, remotePath, config, harness, makeHarness, sync, syncOn };
}

function isCode(code: string) {
  return (error: unknown): boolean => error instanceof NodeWorkspaceError && error.code === code;
}

async function preview(f: Fixture, overrides: Partial<SyncInput> = {}): Promise<Awaited<ReturnType<typeof syncManaged>>> {
  return await f.sync({ mode: "preview", create: true, ...overrides });
}

test("create previews first, then applies into a stable path while preserving caches and secrets", async () => {
  const f = await fixture({
    "a.txt": "alpha",
    "src/b.ts": "export const b = 1;\n",
    "target/release/app": "cached-binary",
    "node_modules/pkg/index.js": "dependency",
    ".env": "SECRET=1\n",
  });
  const planned = await preview(f);
  assert.equal(planned.status, "planned");
  assert.equal(planned.plan?.createRequired, true);
  assert.equal(planned.plan?.counts.add, 2);
  assert.equal(planned.counts.conflicts, 0);

  await assert.rejects(() => f.sync({}), isCode("preview-required"));
  assert.equal(await fs.lstat(f.remotePath).then(() => true, () => false), false);

  const applied = await f.sync({ planDigest: planned.planDigest });
  assert.equal(applied.status, "applied");
  assert.equal(applied.revision, 1);
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "alpha");
  assert.equal(await fs.readFile(path.join(f.remotePath, "src/b.ts"), "utf8"), "export const b = 1;\n");
  // Cache directories are never created or read; caches that exist are preserved.
  await assert.rejects(() => fs.lstat(path.join(f.remotePath, "target")), /ENOENT/);
  await assert.rejects(() => fs.lstat(path.join(f.remotePath, ".env")), /ENOENT/);

  const before = await fs.lstat(path.join(f.remotePath, "a.txt"));
  const noop = await f.sync({ mode: "apply" });
  assert.equal(noop.status, "noop");
  assert.equal(noop.revision, 1);
  const after = await fs.lstat(path.join(f.remotePath, "a.txt"));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);

  const status = await managedStatus(f.harness.transport, f.config.gateway, {
    node: "node-1",
    remotePath: f.remotePath,
    verify: true,
  });
  assert.equal(status.value.owned, true);
  assert.equal(status.value.readiness, "ready");
  assert.equal(status.value.verification, "full");
  assert.deepEqual(status.value.dirty, { nodeChanged: 0, nodeMissing: 0, untracked: 0, protectedCount: 0, excluded: 0 });
});

test("an existing node cache is never read, rewritten or removed", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const planned = await preview(f);
  await f.sync({ planDigest: planned.planDigest });
  const cache = path.join(f.remotePath, "node_modules", "pkg", "index.js");
  await fs.mkdir(path.dirname(cache), { recursive: true });
  await fs.writeFile(cache, "installed-dependency");
  const cacheStat = await fs.lstat(cache);

  await fs.writeFile(path.join(f.source, "a.txt"), "beta");
  const next = await preview(f);
  assert.equal(next.plan?.counts.change, 1);
  assert.equal(next.plan?.counts.untracked, 0, "the cache is excluded, not untracked");
  const applied = await f.sync({ planDigest: next.planDigest });
  assert.equal(applied.status, "applied");
  const after = await fs.lstat(cache);
  assert.equal(await fs.readFile(cache, "utf8"), "installed-dependency");
  assert.equal(after.ino, cacheStat.ino);
  assert.equal(after.mtimeMs, cacheStat.mtimeMs);
});

test("add, change, exact delete and mode change apply as one planned revision", async () => {
  const f = await fixture({ "a.txt": "alpha", "c.txt": "remove-me", "d.sh": "#!/bin/sh\n" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest });

  await fs.writeFile(path.join(f.source, "a.txt"), "changed");
  await fs.rm(path.join(f.source, "c.txt"));
  await fs.writeFile(path.join(f.source, "b.txt"), "added");
  await fs.chmod(path.join(f.source, "d.sh"), 0o755);
  const planned = await preview(f);
  assert.deepEqual(planned.plan?.counts, {
    add: 1,
    change: 1,
    delete: 1,
    mode: 1,
    restore: 0,
    adopt: 0,
    conflicts: 0,
    unchanged: 0,
    untracked: 0,
    released: 0,
  });
  assert.equal(planned.plan?.safeForRoutine, false);
  await assert.rejects(() => f.sync({}), isCode("preview-required"));

  const applied = await f.sync({ planDigest: planned.planDigest });
  assert.equal(applied.revision, 2);
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "changed");
  assert.equal(await fs.readFile(path.join(f.remotePath, "b.txt"), "utf8"), "added");
  await assert.rejects(() => fs.lstat(path.join(f.remotePath, "c.txt")), /ENOENT/);
  assert.equal((await fs.stat(path.join(f.remotePath, "d.sh"))).mode & 0o777, 0o700);
});

test("a node edit blocks every write until it is reconciled", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest });
  await fs.writeFile(path.join(f.remotePath, "a.txt"), "node edit");
  await fs.writeFile(path.join(f.source, "a.txt"), "local edit");

  const planned = await preview(f);
  assert.deepEqual(planned.plan?.conflicts, [{ path: "a.txt", reason: "node-modified" }]);
  await assert.rejects(() => f.sync({ planDigest: planned.planDigest }), isCode("conflict"));
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "node edit");

  const status = await managedStatus(f.harness.transport, f.config.gateway, {
    node: "node-1",
    remotePath: f.remotePath,
  });
  assert.equal((status.value.dirty as { nodeChanged: number }).nodeChanged, 1);
  assert.equal(status.value.revision, 1);
});

test("an untracked node file cannot be overwritten by a local addition", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest });
  await fs.writeFile(path.join(f.remotePath, "extra.txt"), "node-only");
  await fs.writeFile(path.join(f.source, "extra.txt"), "node-only");

  const planned = await preview(f);
  assert.ok(planned.plan?.conflicts.some((entry) => entry.path === "extra.txt" && entry.reason === "untracked"));
  await assert.rejects(() => f.sync({ planDigest: planned.planDigest }), isCode("conflict"));
  assert.equal(await fs.readFile(path.join(f.remotePath, "extra.txt"), "utf8"), "node-only");
});

test("type collisions are refused instead of removing unmanaged descendants", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest });
  await fs.mkdir(path.join(f.remotePath, "thing"));
  await fs.writeFile(path.join(f.remotePath, "thing/child.txt"), "child");
  await fs.writeFile(path.join(f.source, "thing"), "now a file");

  const planned = await preview(f);
  assert.ok(planned.plan?.conflicts.some((entry) => entry.path === "thing" && entry.reason === "type-collision"));
  await assert.rejects(() => f.sync({ planDigest: planned.planDigest }), isCode("conflict"));
  assert.equal(await fs.readFile(path.join(f.remotePath, "thing/child.txt"), "utf8"), "child");
});

test("a node-absent base file needs explicit restore authorization", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest });
  await fs.rm(path.join(f.remotePath, "a.txt"));

  const planned = await preview(f);
  assert.deepEqual(planned.plan?.restorable, ["a.txt"]);
  assert.ok(planned.plan?.conflicts.some((entry) => entry.reason === "node-missing"));
  await assert.rejects(() => f.sync({ planDigest: planned.planDigest }), isCode("conflict"));
  await assert.rejects(() => fs.lstat(path.join(f.remotePath, "a.txt")), /ENOENT/);

  const authorized = await preview(f, { restore: ["a.txt"] });
  assert.equal(authorized.counts.conflicts, 0);
  const restored = await f.sync({ planDigest: authorized.planDigest, restore: ["a.txt"] });
  assert.equal(restored.status, "applied");
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "alpha");
});

test("selection narrowing releases management instead of deleting node content", async () => {
  const f = await fixture({ "keep/a.txt": "a", "drop/b.txt": "b" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest });
  const narrowed = await preview(f, { policy: { include: ["keep/**"] } });
  assert.equal(narrowed.plan?.policyChanged, true);
  const applied = await f.sync({ planDigest: narrowed.planDigest, policy: { include: ["keep/**"] } });
  assert.equal(applied.status, "applied");
  assert.equal(await fs.readFile(path.join(f.remotePath, "drop/b.txt"), "utf8"), "b");
});

test("expectedRevision is a CAS check, and a stale planDigest changes nothing", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest, expectedRevision: 0 });
  await assert.rejects(() => f.sync({ expectedRevision: 0 }), isCode("revision-mismatch"));

  await fs.writeFile(path.join(f.source, "a.txt"), "beta");
  const stalePlan = await preview(f);
  await fs.writeFile(path.join(f.source, "a.txt"), "gamma");
  await assert.rejects(() => f.sync({ planDigest: stalePlan.planDigest }), isCode("plan-stale"));
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "alpha");
});

test("a committed operationId replays its receipt after the revision advanced", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  const id = op();
  const first = await f.sync({ planDigest: created.planDigest, operationId: id });
  assert.equal(first.status, "applied");
  assert.equal(first.revision, 1);

  await fs.writeFile(path.join(f.source, "a.txt"), "beta");
  const next = await preview(f);
  const second = await f.sync({ planDigest: next.planDigest });
  assert.equal(second.revision, 2);

  const replay = await f.sync({ planDigest: created.planDigest, operationId: id });
  assert.equal(replay.status, "replayed");
  assert.equal(replay.revision, 1);
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "beta");
});

test("a different intent with the same operationId is an operation mismatch", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  const id = op();
  await f.sync({ planDigest: created.planDigest, operationId: id });
  await fs.writeFile(path.join(f.source, "b.txt"), "new");
  const next = await preview(f);
  await assert.rejects(() => f.sync({ planDigest: next.planDigest, operationId: id }), isCode("operation-mismatch"));
});

test("ownership binds to the authenticated agent and a forged in-tree marker grants nothing", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest, ownerAgent: "main" });

  const foreignHarness = createHarness(
    createNodeCommands({
      gateway: { localRoots: [f.source] },
      node: { pushRoots: [f.nodeRoot] },
    }).commands,
    {},
    { agentId: "other" },
  );
  await assert.rejects(
    () =>
      syncManaged(foreignHarness.transport, f.config.gateway, {
        node: "node-1",
        localPath: f.source,
        remotePath: f.remotePath,
        workspaceRoot: f.source,
        operationId: op(),
        mode: "preview",
        create: false,
        adopt: false,
        adoptPaths: [],
        restore: [],
        rebind: false,
        expectedRevision: undefined,
        planDigest: undefined,
        policy: {},
        owner: { agentId: "other", sessionKey: "agent:other:test" },
        signal: undefined,
        progress: undefined,
      }),
    isCode("workspace-forbidden"),
  );

  const foreign = path.join(f.nodeRoot, "foreign");
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, ".openclaw-node-workspace.json"), '{"plugin":"node-workspace"}');
  await fs.writeFile(path.join(foreign, "x.txt"), "x");
  const status = await managedStatus(f.harness.transport, f.config.gateway, {
    node: "node-1",
    remotePath: foreign,
  });
  assert.equal(status.value.owned, false);
  assert.equal(status.value.adoptionRequired, true);
});

test("path traversal in a hello manifest is rejected by the node before any write", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const channel = await f.harness.transport.openDuplex({ nodeId: "node-1", command: COMMAND_SYNC, timeoutMs: 5_000 });
  const { FrameSession } = await import("../src/transport.js");
  const session = FrameSession.openSync(channel);
  await session.sendControl({
    t: "hello",
    protocol: PROTOCOL_VERSION,
    mode: "apply",
    operationId: op(),
    nodeId: "node-1",
    owner: { agentId: "main", sessionKey: "agent:main:test" },
    localProject: f.source,
    remotePath: f.remotePath,
    policy: { preset: "none", include: [], exclude: [], protect: [] },
    create: true,
    adopt: false,
    adoptPaths: [],
    restore: [],
    rebind: false,
    timeoutMs: 5_000,
    manifest: [{ path: "../escape.txt", size: 1, sha256: "a".repeat(64), executable: false }],
    directories: [],
  });
  const frame = await session.next(5_000);
  assert.equal(frame.kind, "control");
  if (frame.kind === "control") {
    const value = frame.value as Record<string, unknown>;
    assert.equal(value.ok, false);
    assert.equal(value.code, "path-invalid");
  }
  assert.equal(await fs.lstat(path.join(f.nodeRoot, "escape.txt")).then(() => true, () => false), false);
  session.close();
});

test("a live lock blocks and a provably dead lock is reclaimed", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest });
  const stateDir = path.join(f.nodeRoot, ".nodews-state");
  const key = (await import("../src/node/managed-store.js")).workspaceKey(f.remotePath);
  const lockFile = path.join(stateDir, "locks", `${key}.lock`);
  const body = { version: 1, pid: process.pid, processStart: null, host: "node", token: "live", operationId: op(), acquiredAt: Date.now() };
  await fs.writeFile(lockFile, JSON.stringify(body));
  await assert.rejects(() => f.sync({}), isCode("workspace-locked"));
  await fs.writeFile(lockFile, JSON.stringify({ ...body, pid: 999_999 }));
  const applied = await f.sync({});
  assert.equal(applied.status, "noop");
});

test("a mid-apply ENOSPC rolls back every touched file and reports no effect", async () => {
  const f = await fixture({ "a.txt": "alpha", "b.txt": "beta" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest });
  await fs.writeFile(path.join(f.source, "a.txt"), "changed-a");
  await fs.writeFile(path.join(f.source, "b.txt"), "changed-b");
  const planned = await preview(f);
  const previous = (await managedStatus(f.harness.transport, f.config.gateway, {
    node: "node-1",
    remotePath: f.remotePath,
  })).value.revision;
  process.env.NODE_WORKSPACE_TEST_FAIL = "apply";
  try {
    await assert.rejects(() => f.sync({ planDigest: planned.planDigest }), isCode("io"));
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_FAIL;
  }
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "alpha");
  assert.equal(await fs.readFile(path.join(f.remotePath, "b.txt"), "utf8"), "beta");
  const status = await managedStatus(f.harness.transport, f.config.gateway, {
    node: "node-1",
    remotePath: f.remotePath,
  });
  assert.equal(status.value.revision, previous);
  assert.equal(status.value.readiness, "ready");
  const retried = await f.sync({ planDigest: planned.planDigest });
  assert.equal(retried.status, "applied");
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "changed-a");
});

test("a replaced lock fences a running handler before any mutation", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  process.env.NODE_WORKSPACE_TEST_FENCE = "after-journal";
  try {
    await assert.rejects(() => f.sync({ planDigest: created.planDigest }), isCode("workspace-locked"));
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_FENCE;
  }
  assert.equal(await fs.lstat(f.remotePath).then(() => true, () => false), false);
  const key = (await import("../src/node/managed-store.js")).workspaceKey(f.remotePath);
  await fs.rm(path.join(f.nodeRoot, ".nodews-state", "locks", `${key}.lock`), { force: true });
  const resumed = await f.sync({ planDigest: created.planDigest });
  assert.equal(resumed.status, "applied");
});

test("a rebind needs an explicit pinned apply and changes the bound project", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest, operationId: "1".repeat(32) });
  const other = path.join(f.source, "other-project");
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(other, "a.txt"), "alpha");

  await assert.rejects(
    () =>
      f.sync({
        localPath: other,
        mode: "preview",
        create: false,
        policy: {},
        ownerAgent: "main",
      }),
    isCode("workspace-forbidden"),
  );

  const planned = await f.sync({
    localPath: other,
    mode: "preview",
    create: false,
    rebind: true,
    policy: {},
    ownerAgent: "main",
  });
  assert.equal(planned.status, "planned");
  const applied = await f.sync({
    localPath: other,
    mode: "apply",
    create: false,
    rebind: true,
    planDigest: planned.planDigest,
    policy: {},
    ownerAgent: "main",
  });
  assert.equal(applied.status, "applied");
  assert.ok(applied.revision > created.revision);

  const status = await managedStatus(f.harness.transport, f.config.gateway, {
    node: "node-1",
    remotePath: f.remotePath,
  });
  assert.equal(status.value.localProject, other);
  const receipt = await managedStatus(f.harness.transport, f.config.gateway, {
    node: "node-1",
    remotePath: f.remotePath,
    operationId: "1".repeat(32),
  });
  assert.equal(receipt.value.operation, null, "the pre-rebind receipt is invalidated");
});

test("an injected crash before apply leaves no source mutation and resumes under the same intent", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  process.env.NODE_WORKSPACE_TEST_CRASH = "after-journal";
  try {
    await assert.rejects(() => f.sync({ planDigest: created.planDigest }), isCode("unknown-outcome"));
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_CRASH;
  }
  assert.equal(await fs.lstat(path.join(f.remotePath, "a.txt")).then(() => true, () => false), false);
  const resumed = await f.sync({ planDigest: created.planDigest });
  assert.equal(resumed.status, "applied");
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "alpha");
});

test("a crash during apply is rolled back on the next operation", async () => {
  const f = await fixture({ "a.txt": "alpha", "b.txt": "beta" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest });

  await fs.writeFile(path.join(f.source, "a.txt"), "changed");
  await fs.writeFile(path.join(f.source, "b.txt"), "changed-too");
  const planned = await preview(f);
  process.env.NODE_WORKSPACE_TEST_CRASH = "after-apply";
  try {
    await assert.rejects(() => f.sync({ planDigest: planned.planDigest }), isCode("unknown-outcome"));
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_CRASH;
  }
  // The journal is present, so the base bytes are restored before the next plan.
  const resumed = await f.sync({});
  assert.equal(resumed.status, "applied");
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "changed");
  assert.equal(await fs.readFile(path.join(f.remotePath, "b.txt"), "utf8"), "changed-too");
});

test("a crash after the commit record is rolled forward without a second apply", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  process.env.NODE_WORKSPACE_TEST_CRASH = "after-commit";
  try {
    await assert.rejects(() => f.sync({ planDigest: created.planDigest }), isCode("unknown-outcome"));
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_CRASH;
  }
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "alpha");
  const status = await managedStatus(f.harness.transport, f.config.gateway, {
    node: "node-1",
    remotePath: f.remotePath,
  });
  assert.equal(status.value.readiness, "committed");
  const resumed = await f.sync({});
  assert.equal(resumed.status, "noop");
  assert.equal(resumed.revision, 1);
});

test("external drift during recovery blocks and preserves the mixed bytes", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest });
  await fs.writeFile(path.join(f.source, "a.txt"), "target");
  const planned = await preview(f);
  process.env.NODE_WORKSPACE_TEST_CRASH = "after-apply";
  try {
    await assert.rejects(() => f.sync({ planDigest: planned.planDigest }), isCode("unknown-outcome"));
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_CRASH;
  }
  await fs.writeFile(path.join(f.remotePath, "a.txt"), "unknown third state");
  await assert.rejects(() => f.sync({}), isCode("recovery-blocked"));
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "unknown third state");
  const status = await managedStatus(f.harness.transport, f.config.gateway, {
    node: "node-1",
    remotePath: f.remotePath,
  });
  assert.equal(status.value.readiness, "recovery-blocked");
});

test("a staging failure reports no effect and writes nothing", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  process.env.NODE_WORKSPACE_TEST_FAIL = "stage";
  try {
    await assert.rejects(() => f.sync({ planDigest: created.planDigest }), isCode("io"));
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_FAIL;
  }
  assert.equal(await fs.lstat(f.remotePath).then(() => true, () => false), false);
});

test("transport loss before end is not an unknown outcome; loss after the commit is", async () => {
  const before = await fixture({ "a.txt": "alpha" });
  const createdBefore = await preview(before);
  const lossy = before.makeHarness({ closeAfterGatewayFrames: 2 });
  await assert.rejects(() => before.syncOn(lossy, { planDigest: createdBefore.planDigest }), (error: unknown) => {
    assert.ok(error instanceof NodeWorkspaceError);
    assert.notEqual(error.code, "unknown-outcome");
    return true;
  });
  assert.equal(await fs.lstat(path.join(before.remotePath, "a.txt")).then(() => true, () => false), false);

  const after = await fixture({ "a.txt": "alpha" });
  const createdAfter = await preview(after);
  const afterLoss = after.makeHarness({ closeAfterNodeFrames: 3 });
  await assert.rejects(
    () => after.syncOn(afterLoss, { planDigest: createdAfter.planDigest }),
    isCode("unknown-outcome"),
  );
  assert.equal(await fs.readFile(path.join(after.remotePath, "a.txt"), "utf8"), "alpha");
  const status = await managedStatus(after.harness.transport, after.config.gateway, {
    node: "node-1",
    remotePath: after.remotePath,
    operationId: createdAfter.operationId,
  });
  assert.equal(status.value.owned, true);
});

test("adopting an existing unmanaged directory needs a pinned preview and records the base", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  await fs.mkdir(f.remotePath, { recursive: true });
  await fs.writeFile(path.join(f.remotePath, "a.txt"), "alpha");
  await fs.writeFile(path.join(f.remotePath, "foreign.txt"), "node-only");

  const plain = await preview(f, { adopt: false });
  assert.ok(plain.plan?.conflicts.some((entry) => entry.reason === "adoption-required"));
  await assert.rejects(() => f.sync({ planDigest: plain.planDigest, adopt: false }), isCode("conflict"));

  const planned = await preview(f, { adopt: true });
  assert.equal(planned.plan?.adoptRequired, false);
  assert.deepEqual(planned.plan?.entries.map((entry) => [entry.kind, entry.path]), [["adopt", "a.txt"]]);
  await assert.rejects(() => f.sync({ adopt: true }), isCode("preview-required"));
  const applied = await f.sync({ adopt: true, planDigest: planned.planDigest });
  assert.equal(applied.status, "applied");
  assert.equal(applied.revision, 1);
  assert.equal(await fs.readFile(path.join(f.remotePath, "foreign.txt"), "utf8"), "node-only");
  const status = await managedStatus(f.harness.transport, f.config.gateway, {
    node: "node-1",
    remotePath: f.remotePath,
  });
  assert.equal(status.value.owned, true);
  assert.equal(status.value.revision, 1);
});

test("receipts are live before the seven-day boundary and refused at it", async () => {
  const base = 1_800_000_000_000;
  process.env.NODE_WORKSPACE_TEST_NOW = String(base);
  try {
    const f = await fixture({ "a.txt": "alpha" });
    const created = await preview(f);
    const id = "9".repeat(32);
    await f.sync({ planDigest: created.planDigest, operationId: id });

    const active = await managedStatus(f.harness.transport, f.config.gateway, {
      node: "node-1",
      remotePath: f.remotePath,
      operationId: id,
    });
    assert.equal((active.value.operation as { state: string }).state, "active");

    process.env.NODE_WORKSPACE_TEST_NOW = String(base + 7 * 24 * 60 * 60 * 1000 - 1);
    const replay = await f.sync({ planDigest: created.planDigest, operationId: id });
    assert.equal(replay.status, "replayed");

    process.env.NODE_WORKSPACE_TEST_NOW = String(base + 7 * 24 * 60 * 60 * 1000);
    await assert.rejects(() => f.sync({ planDigest: created.planDigest, operationId: id }), isCode("receipt-expired"));
    const expired = await managedStatus(f.harness.transport, f.config.gateway, {
      node: "node-1",
      remotePath: f.remotePath,
      operationId: id,
    });
    assert.equal((expired.value.operation as { expired: boolean }).expired, true);
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_NOW;
  }
});

test("status inventory is bounded and metadata-only", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest });
  const inventory = await managedStatus(f.harness.transport, f.config.gateway, { node: "node-1", limit: 10 });
  assert.equal(Array.isArray(inventory.value.workspaces), true);
  const entries = inventory.value.workspaces as Record<string, unknown>[];
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.remotePath, f.remotePath);
  assert.equal(entries[0]?.verification, "metadata-only");
});

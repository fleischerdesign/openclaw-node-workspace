import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePluginConfig } from "../src/config.js";
import { NodeWorkspaceError } from "../src/errors.js";
import { managedStatus as managedStatusRaw } from "../src/gateway/managed-status.js";
import { syncManaged, type SyncInput } from "../src/gateway/sync.js";
import { COMMAND_SYNC, PROTOCOL_VERSION } from "../src/protocol.js";
import { createNodeCommands } from "../src/node/commands.js";
import { createHarness, type Faults } from "./helpers/sim.js";

const STATUS_OWNER = { agentId: "main", sessionKey: "agent:main:test" } as const;

function managedStatus(
  transport: Parameters<typeof managedStatusRaw>[0],
  config: Parameters<typeof managedStatusRaw>[1],
  input: Omit<Parameters<typeof managedStatusRaw>[2], "owner">,
) {
  return managedStatusRaw(transport, config, { ...input, owner: STATUS_OWNER });
}

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

test("a dead lock blocks until explicit maintenance, and never removes a live replacement", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest });
  const stateDir = path.join(f.nodeRoot, ".nodews-state");
  const store = await import("../src/node/managed-store.js");
  const key = store.workspaceKey(f.remotePath);
  const lockFile = path.join(stateDir, "locks", `${key}.lock`);
  const dead = { version: 1, pid: 999_999, processStart: null, host: "node", token: "dead-token", operationId: op(), acquiredAt: Date.now() };
  await fs.writeFile(lockFile, JSON.stringify(dead));
  await assert.rejects(() => f.sync({}), isCode("workspace-locked"));
  assert.equal(JSON.parse(await fs.readFile(lockFile, "utf8")).token, "dead-token");

  // A replacement with another live owner must survive a stale-token request.
  const live = { ...dead, pid: process.pid, token: "live-token" };
  await fs.writeFile(lockFile, JSON.stringify(live));
  await assert.rejects(
    () => store.releaseStaleLockForMaintenance(stateDir, key, { token: "dead-token", pid: 999_999 }),
    isCode("workspace-locked"),
  );
  assert.equal(JSON.parse(await fs.readFile(lockFile, "utf8")).token, "live-token");

  // Explicit maintenance only removes the exact dead lock it inspected.
  await fs.writeFile(lockFile, JSON.stringify(dead));
  await store.releaseStaleLockForMaintenance(stateDir, key, { token: "dead-token", pid: 999_999 });
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

test("staged payloads sync bytes before closing the handle", async () => {
  const { closeStagedPayload } = await import("../src/node/managed.js");
  const order: string[] = [];
  await closeStagedPayload({
    async sync() {
      order.push("sync");
    },
    async close() {
      order.push("close");
    },
  });
  assert.deepEqual(order, ["sync", "close"]);

  const failed: string[] = [];
  await assert.rejects(
    () =>
      closeStagedPayload({
        async sync() {
          failed.push("sync");
          throw new Error("sync failed");
        },
        async close() {
          failed.push("close");
        },
      }),
    /sync failed/,
  );
  assert.deepEqual(failed, ["sync", "close"]);
});

test("converged node bytes become the base, then edits and deletion work", async () => {
  const f = await fixture({ "a.txt": "alpha", "stale/x.txt": "x" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest });

  await fs.writeFile(path.join(f.source, "a.txt"), "beta");
  await fs.writeFile(path.join(f.remotePath, "a.txt"), "beta");
  const converged = await preview(f);
  assert.deepEqual(converged.plan?.entries.map((entry) => [entry.kind, entry.path]), [["adopt", "a.txt"]]);
  await f.sync({ planDigest: converged.planDigest });

  await fs.writeFile(path.join(f.source, "a.txt"), "gamma");
  const changed = await f.sync({});
  assert.equal(changed.status, "applied");
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "gamma");

  await fs.rm(path.join(f.source, "a.txt"));
  const deleted = await preview(f);
  assert.deepEqual(deleted.plan?.entries.map((entry) => [entry.kind, entry.path]), [["delete", "a.txt"]]);
  await f.sync({ planDigest: deleted.planDigest });
  await assert.rejects(() => fs.lstat(path.join(f.remotePath, "a.txt")), /ENOENT/);
});

test("the committed directory manifest drops a directory whose last file was deleted", async () => {
  const f = await fixture({ "keep/a.txt": "a", "stale/x.txt": "x" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest });
  await fs.rm(path.join(f.source, "stale"), { recursive: true });
  const planned = await preview(f);
  assert.ok(planned.plan?.entries.some((entry) => entry.kind === "delete" && entry.path === "stale/x.txt"));
  await f.sync({ planDigest: planned.planDigest });

  const store = await import("../src/node/managed-store.js");
  const key = store.workspaceKey(f.remotePath);
  const record = JSON.parse(
    await fs.readFile(path.join(f.nodeRoot, ".nodews-state", "workspaces", `${key}.json`), "utf8"),
  ) as { directories: string[] };
  assert.ok(record.directories.includes("keep"));
  assert.ok(!record.directories.includes("stale"));
});

test("an end frame delivered before a send error is still an unknown outcome", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  const { decodeFrame } = await import("../src/frames.js");
  const wrapped = {
    ...f.harness.transport,
    async openDuplex(request: Parameters<typeof f.harness.transport.openDuplex>[0]) {
      const channel = await f.harness.transport.openDuplex(request);
      const send = channel.send.bind(channel);
      channel.send = async (message: Uint8Array) => {
        const frame = decodeFrame(message);
        await send(message);
        if (frame.kind === "control" && (frame.value as { t?: string }).t === "end") {
          throw new Error("delivered then failed");
        }
      };
      return channel;
    },
  };
  await assert.rejects(
    () =>
      syncManaged(wrapped, f.config.gateway, {
        node: "node-1",
        localPath: f.source,
        remotePath: f.remotePath,
        workspaceRoot: f.source,
        operationId: op(),
        mode: "apply",
        create: true,
        adopt: false,
        adoptPaths: [],
        restore: [],
        rebind: false,
        expectedRevision: undefined,
        planDigest: created.planDigest,
        policy: {},
        owner: { agentId: "main", sessionKey: "agent:main:test" },
        signal: undefined,
        progress: undefined,
      }),
    isCode("unknown-outcome"),
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await fs.lstat(path.join(f.remotePath, "a.txt")).then(() => true, () => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "alpha");
  let status = await managedStatus(f.harness.transport, f.config.gateway, {
    node: "node-1",
    remotePath: f.remotePath,
  });
  for (let attempt = 0; attempt < 200 && status.value.revision !== 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = await managedStatus(f.harness.transport, f.config.gateway, {
      node: "node-1",
      remotePath: f.remotePath,
    });
  }
  assert.equal(status.value.revision, 1);
  assert.equal(status.value.readiness, "ready");
});

test("a missing asserted owner or a foreign owner is refused on sync and status", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest, ownerAgent: "main" });

  await assert.rejects(
    () =>
      syncManaged(f.harness.transport, f.config.gateway, {
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
        owner: { agentId: null, sessionKey: "agent:main:test" },
        signal: undefined,
        progress: undefined,
      }),
    isCode("identity-unresolved"),
  );

  await assert.rejects(
    () =>
      syncManaged(f.harness.transport, f.config.gateway, {
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

  await assert.rejects(
    () =>
      managedStatusRaw(f.harness.transport, f.config.gateway, {
        node: "node-1",
        remotePath: f.remotePath,
        owner: { agentId: null, sessionKey: null },
      } as never),
    isCode("identity-unresolved"),
  );
  await assert.rejects(
    () =>
      managedStatusRaw(f.harness.transport, f.config.gateway, {
        node: "node-1",
        remotePath: f.remotePath,
        owner: { agentId: "other", sessionKey: "agent:other:test" },
      }),
    isCode("workspace-forbidden"),
  );
  const inventory = await managedStatusRaw(f.harness.transport, f.config.gateway, {
    node: "node-1",
    owner: { agentId: "other", sessionKey: "agent:other:test" },
  });
  assert.deepEqual(inventory.value.workspaces, []);
});

test("a node invocation session that disagrees with the asserted session is refused", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  const mismatched = createHarness(
    createNodeCommands({
      gateway: { localRoots: [f.source] },
      node: { pushRoots: [f.nodeRoot] },
    }).commands,
    {},
    { sessionKey: "agent:other:session" },
  );
  await assert.rejects(() => f.syncOn(mismatched, { planDigest: created.planDigest }), isCode("workspace-forbidden"));
});

test("reserved state-directory names are refused anywhere in the destination ancestry", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  await fs.mkdir(path.join(f.nodeRoot, "sub", ".nodews-state"), { recursive: true });
  await fs.mkdir(path.join(f.nodeRoot, ".nodews-state"), { recursive: true });
  for (const remotePath of [
    path.join(f.nodeRoot, ".nodews-state", "app"),
    path.join(f.nodeRoot, "sub", ".nodews-state", "app"),
  ]) {
    await assert.rejects(
      () => f.sync({ remotePath, mode: "preview" }),
      isCode("path-outside-root"),
    );
  }
});

test("create=false does not create a new managed workspace", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  await assert.rejects(
    () => f.sync({ planDigest: created.planDigest, create: false }),
    isCode("create-not-authorized"),
  );
  assert.equal(await fs.lstat(f.remotePath).then(() => true, () => false), false);
  const applied = await f.sync({ planDigest: created.planDigest, create: true });
  assert.equal(applied.status, "applied");
});

test("the node rejects forged cache and protected paths independently", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const { FrameSession } = await import("../src/transport.js");
  const { encodeControl } = await import("../src/frames.js");
  const send = async (manifest: unknown[], directories: string[]): Promise<Record<string, unknown>> => {
    const channel = await f.harness.transport.openDuplex({ nodeId: "node-1", command: COMMAND_SYNC, timeoutMs: 5_000 });
    const session = FrameSession.openSync(channel);
    await session.sendControl({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      mode: "preview",
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
      manifest,
      directories,
    });
    const frame = await session.next(5_000);
    session.close();
    if (frame.kind !== "control") throw new Error("expected a control frame");
    return frame.value as Record<string, unknown>;
  };
  const sha = "a".repeat(64);
  const secret = await send([{ path: ".env", size: 1, sha256: sha, executable: false }], []);
  assert.equal(secret.code, "policy-violation");
  const cache = await send(
    [{ path: "node_modules/pkg/index.js", size: 1, sha256: sha, executable: false }],
    ["node_modules", "node_modules/pkg"],
  );
  assert.equal(cache.code, "policy-violation");
  void encodeControl;
});

test("a rebind crash after the commit journal restores the new binding without a registry", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest, operationId: "1".repeat(32) });
  const other = path.join(f.source, "rebound-project");
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(other, "a.txt"), "alpha");

  const planned = await f.sync({
    localPath: other,
    mode: "preview",
    create: false,
    rebind: true,
    policy: {},
    ownerAgent: "main",
  });
  process.env.NODE_WORKSPACE_TEST_CRASH = "after-commit";
  try {
    await assert.rejects(
      () =>
        f.sync({
          localPath: other,
          mode: "apply",
          create: false,
          rebind: true,
          planDigest: planned.planDigest,
          policy: {},
          ownerAgent: "main",
          operationId: "2".repeat(32),
        }),
      isCode("unknown-outcome"),
    );
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_CRASH;
  }

  const store = await import("../src/node/managed-store.js");
  const key = store.workspaceKey(f.remotePath);
  const recordFile = path.join(f.nodeRoot, ".nodews-state", "workspaces", `${key}.json`);
  await fs.rm(recordFile, { force: true });

  // The old binding is no longer authorized after the committed rebind, but the
  // same owner may recover the committed state and then rebind explicitly.
  await assert.rejects(
    () => f.sync({ mode: "preview", create: false, policy: {}, ownerAgent: "main" }),
    isCode("workspace-forbidden"),
  );
  const recovered = await f.sync({
    localPath: other,
    mode: "preview",
    create: false,
    rebind: true,
    policy: {},
    ownerAgent: "main",
  });
  assert.equal(recovered.status, "planned");
  const status = await managedStatus(f.harness.transport, f.config.gateway, {
    node: "node-1",
    remotePath: f.remotePath,
  });
  assert.equal(status.value.localProject, other);
  assert.equal(status.value.epoch, 2);
  const old = await managedStatusRaw(f.harness.transport, f.config.gateway, {
    node: "node-1",
    remotePath: f.remotePath,
    operationId: "1".repeat(32),
    owner: STATUS_OWNER,
  });
  assert.equal(old.value.operation, null);
});

test("quota blocks a mutation but never a preview or a no-op", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  process.env.NODE_WORKSPACE_TEST_RECEIPT_QUOTA = "2";
  try {
    const created = await preview(f);
    await f.sync({ planDigest: created.planDigest });
    await fs.writeFile(path.join(f.source, "a.txt"), "beta");
    await f.sync({});
    const atQuota = await preview(f);
    assert.equal(atQuota.status, "planned");
    const noop = await f.sync({});
    assert.equal(noop.status, "noop");
    await fs.writeFile(path.join(f.source, "a.txt"), "gamma");
    await assert.rejects(() => f.sync({}), isCode("receipt-quota-exceeded"));
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_RECEIPT_QUOTA;
  }
});

test("replay returns the original planDigest and counts", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  const id = "7".repeat(32);
  const first = await f.sync({ planDigest: created.planDigest, operationId: id });
  const replay = await f.sync({ planDigest: created.planDigest, operationId: id });
  assert.equal(replay.status, "replayed");
  assert.equal(replay.planDigest, first.planDigest);
  assert.deepEqual(replay.counts, first.counts);
});

test("a crash after the applying journal and before mutation leaves the base untouched", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  process.env.NODE_WORKSPACE_TEST_CRASH = "after-applying-journal";
  try {
    await assert.rejects(() => f.sync({ planDigest: created.planDigest }), isCode("unknown-outcome"));
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_CRASH;
  }
  assert.equal(await fs.lstat(f.remotePath).then(() => true, () => false), false);
  const resumed = await f.sync({ planDigest: created.planDigest });
  assert.equal(resumed.status, "applied");
});

test("a crash after the registry record is cleaned and replayed without a second apply", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  const id = op();
  process.env.NODE_WORKSPACE_TEST_CRASH = "after-record";
  try {
    await assert.rejects(
      () => f.sync({ planDigest: created.planDigest, operationId: id }),
      isCode("unknown-outcome"),
    );
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_CRASH;
  }
  const inventory = await managedStatus(f.harness.transport, f.config.gateway, { node: "node-1" });
  const rows = inventory.value.workspaces as { readiness?: string }[];
  assert.equal(rows[0]?.readiness, "committed", "inventory and detail disagree on a committed journal");
  const detail = await managedStatus(f.harness.transport, f.config.gateway, {
    node: "node-1",
    remotePath: f.remotePath,
  });
  assert.equal(detail.value.readiness, "committed");
  const replay = await f.sync({ planDigest: created.planDigest, operationId: id });
  assert.equal(replay.status, "replayed");
  assert.equal(replay.revision, 1);
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "alpha");
});

test("a crash after cleanup leaves a clean committed workspace", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  const id = op();
  process.env.NODE_WORKSPACE_TEST_CRASH = "after-cleanup";
  try {
    await assert.rejects(
      () => f.sync({ planDigest: created.planDigest, operationId: id }),
      isCode("unknown-outcome"),
    );
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_CRASH;
  }
  const inventory = await managedStatus(f.harness.transport, f.config.gateway, { node: "node-1" });
  const rows = inventory.value.workspaces as { readiness?: string }[];
  assert.equal(rows[0]?.readiness, "ready", "a cleaned journal must not be reported as committed");
  const detail = await managedStatus(f.harness.transport, f.config.gateway, {
    node: "node-1",
    remotePath: f.remotePath,
  });
  assert.equal(detail.value.readiness, "ready");
  const replay = await f.sync({ planDigest: created.planDigest, operationId: id });
  assert.equal(replay.status, "replayed");
  assert.equal(replay.revision, 1);
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "alpha");
});

test("progress bytesTotal counts only payload bytes", async () => {
  const f = await fixture({ "small.txt": "a", "large.txt": "x".repeat(120_000) });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest });
  await fs.writeFile(path.join(f.source, "small.txt"), "bb");
  const progress: SyncProgress[] = [];
  await syncManaged(f.harness.transport, f.config.gateway, {
    node: "node-1",
    localPath: f.source,
    remotePath: f.remotePath,
    workspaceRoot: f.source,
    operationId: op(),
    mode: "apply",
    create: false,
    adopt: false,
    adoptPaths: [],
    restore: [],
    rebind: false,
    expectedRevision: undefined,
    planDigest: undefined,
    policy: {},
    owner: { agentId: "main", sessionKey: "agent:main:test" },
    signal: undefined,
    progress: (entry) => progress.push(entry),
  });
  const sending = progress.filter((entry) => entry.phase === "sending");
  assert.ok(sending.length > 0);
  assert.ok(sending.every((entry) => entry.bytesTotal === 2));
});

test("lock publication failure leaves no partial lock and a retry succeeds", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  const stateDir = path.join(f.nodeRoot, ".nodews-state");
  const store = await import("../src/node/managed-store.js");
  const lockFile = path.join(stateDir, "locks", `${store.workspaceKey(f.remotePath)}.lock`);
  process.env.NODE_WORKSPACE_TEST_FAIL_LOCK = "before-link";
  try {
    await assert.rejects(() => f.sync({ planDigest: created.planDigest }), isCode("io"));
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_FAIL_LOCK;
  }
  await assert.rejects(() => fs.lstat(lockFile), /ENOENT/);
  assert.equal(await fs.lstat(f.remotePath).then(() => true, () => false), false);
  const applied = await f.sync({ planDigest: created.planDigest });
  assert.equal(applied.status, "applied");
});

test("an unreadable lock blocks automatic work without deleting it", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  await f.sync({ planDigest: created.planDigest });
  const store = await import("../src/node/managed-store.js");
  const lockFile = path.join(f.nodeRoot, ".nodews-state", "locks", `${store.workspaceKey(f.remotePath)}.lock`);
  await fs.writeFile(lockFile, "not-json");
  await assert.rejects(() => f.sync({}), isCode("workspace-locked"));
  assert.equal(await fs.readFile(lockFile, "utf8"), "not-json");
  await fs.rm(lockFile);
});

test("a foreign agent cannot trigger recovery of another owner's committed journal", async () => {
  const f = await fixture({ "a.txt": "alpha" });
  const created = await preview(f);
  process.env.NODE_WORKSPACE_TEST_CRASH = "after-commit";
  try {
    await assert.rejects(
      () => f.sync({ planDigest: created.planDigest, ownerAgent: "alice" }),
      isCode("unknown-outcome"),
    );
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_CRASH;
  }
  const store = await import("../src/node/managed-store.js");
  const key = store.workspaceKey(f.remotePath);
  const recordFile = path.join(f.nodeRoot, ".nodews-state", "workspaces", `${key}.json`);
  await fs.rm(recordFile, { force: true });
  const bob = path.join(f.source, "bob-project");
  await fs.mkdir(bob, { recursive: true });
  await fs.writeFile(path.join(bob, "a.txt"), "bob");
  await assert.rejects(
    () =>
      syncManaged(f.harness.transport, f.config.gateway, {
        node: "node-1",
        localPath: bob,
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
        owner: { agentId: "bob", sessionKey: "agent:bob:test" },
        signal: undefined,
        progress: undefined,
      }),
    isCode("workspace-forbidden"),
  );
  assert.equal(await fs.lstat(recordFile).then(() => true, () => false), false, "foreign recovery wrote a record");
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "alpha");

  const recovered = await f.sync({ mode: "preview", create: false, ownerAgent: "alice" });
  assert.equal(recovered.status, "planned");
  const status = await managedStatusRaw(f.harness.transport, f.config.gateway, {
    node: "node-1",
    remotePath: f.remotePath,
    owner: { agentId: "alice", sessionKey: null },
  });
  assert.equal(status.value.localProject, await fs.realpath(f.source));
  assert.equal(status.value.revision, 1);

  await assert.rejects(
    () =>
      syncManaged(f.harness.transport, f.config.gateway, {
        node: "node-1",
        localPath: bob,
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
        owner: { agentId: "alice", sessionKey: "agent:alice:test" },
        signal: undefined,
        progress: undefined,
      }),
    isCode("workspace-forbidden"),
  );
  assert.equal(await fs.readFile(path.join(f.remotePath, "a.txt"), "utf8"), "alpha");
});

test("a first-create failure after directory creation removes only the new empty directories", async () => {
  const f = await fixture({ "nested/a.txt": "alpha" });
  const created = await preview(f);
  process.env.NODE_WORKSPACE_TEST_FAIL = "after-dirs";
  try {
    await assert.rejects(() => f.sync({ planDigest: created.planDigest }), isCode("io"));
  } finally {
    delete process.env.NODE_WORKSPACE_TEST_FAIL;
  }
  assert.equal(await fs.lstat(f.remotePath).then(() => true, () => false), false);
  const applied = await f.sync({ planDigest: created.planDigest });
  assert.equal(applied.status, "applied");
});

test("short writes are completed by the durable write helper", async () => {
  const { writeAllBytes } = await import("../src/fs-durable.js");
  const target = new Uint8Array(10).fill(7);
  const written: number[] = [];
  let offset = 0;
  await writeAllBytes(
    {
      async write(buffer: Uint8Array) {
        const chunk = Math.min(3, buffer.byteLength);
        written.push(chunk);
        for (let index = 0; index < chunk; index += 1) {
          // The fake never mutates the source; it just reports a short write.
        }
        offset += chunk;
        return { bytesWritten: chunk };
      },
    },
    target,
  );
  assert.equal(offset, 10);
  assert.ok(written.every((value) => value > 0));
});

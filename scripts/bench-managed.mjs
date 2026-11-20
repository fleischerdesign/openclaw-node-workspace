#!/usr/bin/env node
// Reproducible managed-sync benchmark.
//
// The Gateway tool logic, node command handlers, framed transport and real
// filesystem are exercised in one process; only the network hop is in-process.
// The fixture is a source tree plus a large excluded dependency cache and a
// protected secret. Scenarios: cold create, no-op, one-file update, exact
// deletion. A small TypeScript project then proves that a real incremental
// build keeps its cache across syncs.
//
// Set BENCH_OUT to write the JSON report. Set BENCH_KEEP=1 to keep the tree.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { resolvePluginConfig } from "../src/config.ts";
import { managedStatus } from "../src/gateway/managed-status.ts";
import { syncManaged } from "../src/gateway/sync.ts";
import { createNodeCommands } from "../src/node/commands.ts";
import { createHarness } from "../test/helpers/sim.ts";

const SOURCE_FILES = Number(process.env.BENCH_SOURCE_FILES ?? 160);
const SOURCE_BYTES = Number(process.env.BENCH_SOURCE_BYTES ?? 4096);
const CACHE_FILES = Number(process.env.BENCH_CACHE_FILES ?? 2048);
const CACHE_BYTES = Number(process.env.BENCH_CACHE_BYTES ?? 16384);
const OUT = process.env.BENCH_OUT;
const KEEP = process.env.BENCH_KEEP === "1";
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 5);

let counter = 0;
const nextOp = () => (counter += 1).toString(16).padStart(32, "0");

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-bench-"));
const results = {
  generatedAt: new Date().toISOString(),
  environment: {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpus: os.cpus().length,
    node: process.version,
    sourceFiles: SOURCE_FILES,
    sourceBytes: SOURCE_BYTES,
    cacheFiles: CACHE_FILES,
    cacheBytes: CACHE_BYTES,
    peakRssKb: process.resourceUsage().maxRSS,
  },
  modes: {},
  build: {},
};

function payload(index, size) {
  const seed = `file-${index}\n`;
  const repeats = Math.max(1, Math.ceil((size - seed.length) / seed.length));
  return (seed.repeat(repeats)).slice(0, size);
}

async function writeFiles(root, entries) {
  for (const [relative, content] of entries) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

async function makeSource({ cache }) {
  const root = await fs.mkdtemp(path.join(ROOT, "src-"));
  const files = [];
  for (let index = 0; index < SOURCE_FILES; index += 1) {
    files.push([`src/f${String(index).padStart(3, "0")}.ts`, payload(index, SOURCE_BYTES)]);
  }
  files.push([".env", "BENCH_SECRET=must-not-transfer\n"]);
  await writeFiles(root, files);
  if (cache) {
    const cacheEntries = [];
    for (let index = 0; index < CACHE_FILES; index += 1) {
      cacheEntries.push([`node_modules/pkg${String(index).padStart(4, "0")}/index.js`, payload(index, CACHE_BYTES)]);
    }
    await writeFiles(root, cacheEntries);
  }
  return root;
}

async function walk(root, base = root, out = []) {
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const absolute = path.join(base, entry.name);
    const relative = path.relative(root, absolute);
    if (entry.isSymbolicLink()) {
      out.push({ relative, symlink: true });
      continue;
    }
    if (entry.isDirectory()) {
      out.push({ relative: `${relative}/`, directory: true });
      await walk(root, absolute, out);
      continue;
    }
    const stat = await fs.lstat(absolute);
    out.push({ relative, size: stat.size, ino: stat.ino, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 });
  }
  return out;
}

async function snapshot(root, predicate = () => true) {
  const map = new Map();
  for (const entry of await walk(root)) {
    if (!predicate(entry.relative)) continue;
    map.set(entry.relative, entry);
  }
  return map;
}

function preservation(before, after, ignore = new Set()) {
  let checked = 0;
  let changed = 0;
  const changedPaths = [];
  for (const [relative, entry] of before) {
    if (ignore.has(relative) || entry.directory || entry.symlink) continue;
    checked += 1;
    const current = after.get(relative);
    if (
      current === undefined ||
      current.ino !== entry.ino ||
      current.mtimeMs !== entry.mtimeMs ||
      current.size !== entry.size
    ) {
      changed += 1;
      changedPaths.push(relative);
    }
  }
  return { checked, changed, changedPaths: changedPaths.slice(0, 10) };
}

async function directoryBytes(root) {
  let bytes = 0;
  let files = 0;
  for (const entry of await walk(root)) {
    if (entry.directory || entry.symlink) continue;
    bytes += entry.size ?? 0;
    files += 1;
  }
  return { bytes, files };
}

async function freeBytes(target) {
  try {
    const stat = await fs.statfs(target);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

function ms(started) {
  return Math.round((performance.now() - started) * 100) / 100;
}

function configFor(sourceRoot, nodeRoot) {
  return resolvePluginConfig({
    gateway: {
      localRoots: [sourceRoot],
      artifactRoots: [sourceRoot],
      chunkBytes: 64 * 1024,
      timeoutMs: 300_000,
      maxFiles: 10_000,
      maxFileBytes: 16 * 1024 * 1024,
      maxTotalBytes: 512 * 1024 * 1024,
    },
    node: {
      pushRoots: [nodeRoot],
      maxFiles: 10_000,
      maxFileBytes: 16 * 1024 * 1024,
      maxTotalBytes: 512 * 1024 * 1024,
    },
  });
}

async function runMode(mode, { cache }) {
  const sourceRoot = await makeSource({ cache });
  const nodeRoot = await fs.mkdtemp(path.join(ROOT, `node-${mode}-`));
  const remotePath = path.join(nodeRoot, "app");
  const config = configFor(sourceRoot, nodeRoot);
  const harness = createHarness(createNodeCommands({
    gateway: { localRoots: [sourceRoot], timeoutMs: 300_000 },
    node: { pushRoots: [nodeRoot] },
  }).commands);
  const stateDir = path.join(nodeRoot, ".nodews-state");
  const sync = (overrides = {}) =>
    syncManaged(harness.transport, config.gateway, {
      node: "node-1",
      localPath: sourceRoot,
      remotePath,
      workspaceRoot: sourceRoot,
      operationId: nextOp(),
      mode: "apply",
      create: true,
      adopt: false,
      adoptPaths: [],
      restore: [],
      rebind: false,
      expectedRevision: undefined,
      planDigest: undefined,
      policy: { preset: "node" },
      owner: { agentId: "bench", sessionKey: "agent:bench" },
      signal: undefined,
      progress: undefined,
      ...overrides,
    });

  const diskBefore = await freeBytes(nodeRoot);

  const previewStart = performance.now();
  const planned = await sync({ mode: "preview" });
  const previewMs = ms(previewStart);
  const coldStart = performance.now();
  const cold = await sync({ planDigest: planned.planDigest });
  const coldMs = ms(coldStart);
  if (cold.revision !== 1) throw new Error(`cold revision ${cold.revision}`);
  const diskAfterCold = await freeBytes(nodeRoot);
  const stateAfterCold = await directoryBytes(stateDir);
  const localSourceBefore = await snapshot(sourceRoot, (relative) => relative.startsWith("src/"));
  const localCacheBefore = cache
    ? await snapshot(sourceRoot, (relative) => relative.startsWith("node_modules/"))
    : new Map();
  // A real build installs its dependency cache on the node. The sync must never
  // touch it afterwards, and the local cache must never leave the Gateway.
  if (cache) {
    const installed = [];
    for (let index = 0; index < CACHE_FILES; index += 1) {
      installed.push([`node_modules/pkg${String(index).padStart(4, "0")}/index.js`, payload(index, CACHE_BYTES)]);
    }
    await writeFiles(remotePath, installed);
  }
  const nodeCacheBefore = cache
    ? await snapshot(remotePath, (relative) => relative.startsWith("node_modules/"))
    : new Map();
  const sourceSnapshotBefore = await snapshot(remotePath, (relative) => relative.startsWith("src/"));

  const noopStart = performance.now();
  const noop = await sync();
  const noopMs = ms(noopStart);
  if (noop.status !== "noop" || noop.revision !== 1) throw new Error(`unexpected no-op ${JSON.stringify(noop)}`);

  const target = "src/f000.ts";
  const other = "src/f001.ts";
  await fs.writeFile(path.join(sourceRoot, target), payload(9999, SOURCE_BYTES));
  const beforeUpdate = await snapshot(remotePath, (relative) => relative.startsWith("src/"));
  const updateStart = performance.now();
  const update = await sync();
  const updateMs = ms(updateStart);
  if (update.revision !== 2) throw new Error(`update revision ${update.revision}`);
  const afterUpdate = await snapshot(remotePath, (relative) => relative.startsWith("src/"));
  const updatePreservation = preservation(beforeUpdate, afterUpdate, new Set([target]));

  const deleted = other;
  await fs.rm(path.join(sourceRoot, deleted));
  const deletePreviewStart = performance.now();
  const deletePlan = await sync({ mode: "preview" });
  const deletePreviewMs = ms(deletePreviewStart);
  const beforeDelete = await snapshot(remotePath, (relative) => relative.startsWith("src/"));
  const deleteStart = performance.now();
  const deletion = await sync({ planDigest: deletePlan.planDigest });
  const deleteMs = ms(deleteStart);
  if (deletion.revision !== 3) throw new Error(`delete revision ${deletion.revision}`);
  const afterDelete = await snapshot(remotePath, (relative) => relative.startsWith("src/"));
  if (afterDelete.has(deleted)) throw new Error("exact deletion left the file");
  const deletePreservation = preservation(beforeDelete, afterDelete, new Set([deleted]));
  let cachePreservationResult;
  if (cache) {
    const cacheSnapshotAfter = await snapshot(remotePath, (relative) => relative.startsWith("node_modules/"));
    const cachePreservation = preservation(nodeCacheBefore, cacheSnapshotAfter);
    if (cachePreservation.changed !== 0) throw new Error(`node cache changed: ${cachePreservation.changedPaths.join(", ")}`);
    const localCacheAfter = await snapshot(sourceRoot, (relative) => relative.startsWith("node_modules/"));
    const localCachePreservation = preservation(localCacheBefore, localCacheAfter);
    if (localCachePreservation.changed !== 0) throw new Error("local cache changed during sync");
    cachePreservationResult = { node: cachePreservation, local: localCachePreservation };
  }
  const sourcePreservation = preservation(
    sourceSnapshotBefore,
    await snapshot(remotePath, (relative) => relative.startsWith("src/")),
    new Set([target, deleted]),
  );
  const localSourcePreservation = preservation(
    localSourceBefore,
    await snapshot(sourceRoot, (relative) => relative.startsWith("src/")),
    new Set([target, deleted]),
  );
  const stateBytes = await directoryBytes(stateDir);
  const workspaceBytes = await directoryBytes(remotePath);
  const diskAfter = await freeBytes(nodeRoot);
  const status = await managedStatus(harness.transport, config.gateway, {
    node: "node-1",
    remotePath,
    verify: true,
    owner: { agentId: "bench", sessionKey: "agent:bench" },
  });

  // Repeat the no-op to report a small distribution without claiming a target.
  const noopSamples = [noopMs];
  for (let index = 1; index < ITERATIONS; index += 1) {
    const started = performance.now();
    const sample = await sync();
    if (sample.status !== "noop") throw new Error("repeat no-op was not a no-op");
    noopSamples.push(ms(started));
  }
  noopSamples.sort((left, right) => left - right);

  results.modes[mode] = {
    cache,
    cachePreservation: cachePreservationResult ?? null,
    fixture: {
      sourceFiles: SOURCE_FILES,
      sourceBytes: SOURCE_FILES * SOURCE_BYTES,
      cacheFiles: cache ? CACHE_FILES : 0,
      cacheBytes: cache ? CACHE_FILES * CACHE_BYTES : 0,
    },
    cold: { previewMs, applyMs: coldMs, transferredBytes: cold.transferredBytes, revision: cold.revision },
    noop: {
      ms: noopMs,
      p50Ms: noopSamples[Math.floor(noopSamples.length / 2)],
      minMs: noopSamples[0],
      maxMs: noopSamples[noopSamples.length - 1],
      transferredBytes: noop.transferredBytes,
      revision: noop.revision,
    },
    oneFileUpdate: {
      ms: updateMs,
      transferredBytes: update.transferredBytes,
      counts: update.counts,
      preservation: updatePreservation,
    },
    delete: {
      previewMs: deletePreviewMs,
      applyMs: deleteMs,
      transferredBytes: deletion.transferredBytes,
      counts: deletion.counts,
      preservation: deletePreservation,
    },
    sourcePreservation,
    localSourcePreservation,
    disk: {
      freeBeforeBytes: diskBefore,
      freeAfterColdBytes: diskAfterCold,
      freeAfterBytes: diskAfter,
      workspaceBytes: workspaceBytes.bytes,
      workspaceFiles: workspaceFiles(workspaceBytes, stateAfterCold, stateBytes),
      stateAfterColdBytes: stateAfterCold.bytes,
      stateBytes: stateBytes.bytes,
      writeUpperBoundBytes:
        cold.transferredBytes +
        update.transferredBytes +
        deletion.transferredBytes +
        sumBefore(deletion.plan?.entries ?? [], ["delete"]),
    },
    status: {
      owned: status.value.owned,
      revision: status.value.revision,
      readiness: status.value.readiness,
      verification: status.value.verification,
      dirty: status.value.dirty,
    },
    protectedCount: cold.protectedCount,
  };
}

function workspaceFiles(workspaceBytes, _stateAfterCold, _stateBytes) {
  return workspaceBytes.files;
}

function sumBefore(entries, kinds) {
  return entries.filter((entry) => kinds.includes(entry.kind)).reduce((total, entry) => total + (entry.before?.size ?? 0), 0);
}

function commandVersion(command) {
  try {
    return execFileSync(command, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

async function runRustSmoke() {
  const compiler = commandVersion("rustc");
  if (compiler === null) {
    results.rust = { available: false };
    return;
  }
  const sourceRoot = await fs.mkdtemp(path.join(ROOT, "rust-src-"));
  await fs.mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "src", "main.rs"), 'fn main() { println!("one"); }\n');
  const nodeRoot = await fs.mkdtemp(path.join(ROOT, "rust-node-"));
  const remotePath = path.join(nodeRoot, "app");
  const config = configFor(sourceRoot, nodeRoot);
  const harness = createHarness(createNodeCommands({
    gateway: { localRoots: [sourceRoot], timeoutMs: 120_000 },
    node: { pushRoots: [nodeRoot] },
  }).commands);
  const sync = (overrides = {}) =>
    syncManaged(harness.transport, config.gateway, {
      node: "node-1",
      localPath: sourceRoot,
      remotePath,
      workspaceRoot: sourceRoot,
      operationId: nextOp(),
      mode: "apply",
      create: true,
      adopt: false,
      adoptPaths: [],
      restore: [],
      rebind: false,
      expectedRevision: undefined,
      planDigest: undefined,
      policy: { preset: "rust" },
      owner: { agentId: "bench", sessionKey: "agent:bench" },
      signal: undefined,
      progress: undefined,
      ...overrides,
    });
  const planned = await sync({ mode: "preview" });
  await sync({ planDigest: planned.planDigest });
  const build = () => {
    const started = performance.now();
    execFileSync(
      "rustc",
      ["--edition", "2021", "-C", "incremental=target/incremental", "-o", "target/app", "src/main.rs"],
      { cwd: remotePath, stdio: "pipe", timeout: 120_000 },
    );
    return ms(started);
  };
  const coldBuildMs = build();
  const targetBefore = await snapshot(remotePath, (relative) => relative.startsWith("target/"));
  const noop = await sync();
  const targetAfterSync = await snapshot(remotePath, (relative) => relative.startsWith("target/"));
  const untouched = preservation(targetBefore, targetAfterSync);
  await fs.writeFile(path.join(sourceRoot, "src", "main.rs"), 'fn main() { println!("two"); }\n');
  const update = await sync();
  const editedBuildMs = build();
  const binary = await fs.readFile(path.join(remotePath, "target", "app"), "utf8").catch(() => null);
  results.rust = {
    available: true,
    compiler,
    coldBuildMs,
    editedBuildMs,
    noopStatus: noop.status,
    updateRevision: update.revision,
    targetUntouchedByNoopSync: untouched,
    binaryContainsEditedText: binary !== null && binary.includes("two"),
    passed: noop.status === "noop" && untouched.changed === 0 && update.revision === 2,
  };
  if (!results.rust.passed) throw new Error(`rust smoke failed: ${JSON.stringify(results.rust)}`);
}

async function runBuildSmoke() {
  const sourceRoot = await fs.mkdtemp(path.join(ROOT, "build-src-"));
  await writeFiles(sourceRoot, [
    ["package.json", JSON.stringify({ name: "bench-mini", private: true, type: "module" }, null, 2)],
    [
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: false,
            outDir: "dist",
            incremental: true,
            tsBuildInfoFile: "dist/.tsbuildinfo",
            rootDir: "src",
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      ),
    ],
    ["src/a.ts", "export const a: number = 1;\n"],
    ["src/b.ts", "export const b: string = 'b';\n"],
  ]);
  const nodeRoot = await fs.mkdtemp(path.join(ROOT, "build-node-"));
  const remotePath = path.join(nodeRoot, "app");
  const config = configFor(sourceRoot, nodeRoot);
  const harness = createHarness(createNodeCommands({
    gateway: { localRoots: [sourceRoot], timeoutMs: 120_000 },
    node: { pushRoots: [nodeRoot] },
  }).commands);
  const sync = (overrides = {}) =>
    syncManaged(harness.transport, config.gateway, {
      node: "node-1",
      localPath: sourceRoot,
      remotePath,
      workspaceRoot: sourceRoot,
      operationId: nextOp(),
      mode: "apply",
      create: true,
      adopt: false,
      adoptPaths: [],
      restore: [],
      rebind: false,
      expectedRevision: undefined,
      planDigest: undefined,
      policy: { preset: "node" },
      owner: { agentId: "bench", sessionKey: "agent:bench" },
      signal: undefined,
      progress: undefined,
      ...overrides,
    });

  const planned = await sync({ mode: "preview" });
  await sync({ planDigest: planned.planDigest });
  const tsc = path.resolve(process.cwd(), "node_modules", ".bin", "tsc");
  await fs.access(tsc);
  const runTsc = () => {
    const started = performance.now();
    execFileSync(tsc, ["-p", "."], { cwd: remotePath, stdio: "pipe", timeout: 120_000 });
    return ms(started);
  };

  const coldBuildMs = runTsc();
  const distBefore = await snapshot(remotePath, (relative) => relative.startsWith("dist/"));
  const noop = await sync();
  if (noop.status !== "noop") throw new Error(`build no-op status ${noop.status}`);
  const distAfterNoopSync = await snapshot(remotePath, (relative) => relative.startsWith("dist/"));
  const syncPreservationNoop = preservation(distBefore, distAfterNoopSync);
  const incrementalBuildMs = runTsc();

  const aPath = "src/a.ts";
  await fs.writeFile(path.join(sourceRoot, aPath), "export const a: number = 2;\n");
  const distBeforeEdit = await snapshot(remotePath, (relative) => relative.startsWith("dist/"));
  const update = await sync();
  const distAfterSync = await snapshot(remotePath, (relative) => relative.startsWith("dist/"));
  const syncPreservationEdit = preservation(distBeforeEdit, distAfterSync);
  const bBefore = distBeforeEdit.get("dist/b.js");
  const editedBuildMs = runTsc();
  const distAfterBuild = await snapshot(remotePath, (relative) => relative.startsWith("dist/"));
  const aChanged = distAfterBuild.get("dist/a.js")?.mtimeMs !== distBeforeEdit.get("dist/a.js")?.mtimeMs;
  const bPreserved = distAfterBuild.get("dist/b.js")?.ino === bBefore?.ino &&
    distAfterBuild.get("dist/b.js")?.mtimeMs === bBefore?.mtimeMs;
  const status = await managedStatus(harness.transport, config.gateway, {
    node: "node-1",
    remotePath,
    verify: true,
    owner: { agentId: "bench", sessionKey: "agent:bench" },
  });

  results.build = {
    compiler: tsc,
    coldBuildMs,
    incrementalBuildMs,
    editedBuildMs,
    sync: { noopStatus: noop.status, updateRevision: update.revision, updateCounts: update.counts },
    distUntouchedByNoopSync: syncPreservationNoop,
    distUntouchedByEditSync: syncPreservationEdit,
    aOutputChangedAfterRebuild: aChanged,
    bOutputPreservedAfterRebuild: bPreserved,
    untracked: status.value.dirty,
    passed:
      syncPreservationNoop.changed === 0 &&
      syncPreservationEdit.changed === 0 &&
      aChanged &&
      bPreserved,
  };
  if (!results.build.passed) throw new Error(`build smoke failed: ${JSON.stringify(results.build)}`);
}

try {
  results.modes.absent = {};
  results.modes.present = {};
  await runMode("absent", { cache: false });
  await runMode("present", { cache: true });
  await runBuildSmoke();
  await runRustSmoke();
  const body = `${JSON.stringify(results, null, 2)}\n`;
  if (OUT) await fs.writeFile(OUT, body);
  process.stdout.write(body);
  console.error(`\nbenchmark workspace: ${ROOT}${KEEP ? " (kept)" : ""}`);
} finally {
  if (!KEEP) await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
}

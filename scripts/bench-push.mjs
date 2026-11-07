#!/usr/bin/env node
// Reproducible in-process publish benchmark.
//
// The Gateway tools, node command handlers, framed transport and real
// filesystem are exercised. Only the network hop is in-process. Each iteration
// publishes into a fresh destination so idempotency is not measured.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { resolvePluginConfig } from "../src/config.ts";
import { pushWorkspace } from "../src/gateway/push.ts";
import { createNodeCommands } from "../src/node/commands.ts";
import { createHarness } from "../test/helpers/sim.ts";

const ITERATIONS = Number(process.env.NODEWS_BENCH_ITERATIONS ?? 5);

async function makeFixture(name, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `nodews-bench-${name}-`));
  for (const { path: relative, size } of files) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.alloc(size, 0x61));
  }
  return root;
}

function fixtureSpecs() {
  return [
    {
      name: "small-1850",
      files: Array.from({ length: 1850 }, (_, index) => ({
        path: `d${String(index % 37).padStart(2, "0")}/f${String(index).padStart(4, "0")}.txt`,
        size: 4096,
      })),
    },
    {
      name: "mixed-300",
      files: Array.from({ length: 300 }, (_, index) => ({
        path: `src/m${String(index).padStart(3, "0")}.bin`,
        size: index % 10 === 0 ? 256 * 1024 : index % 3 === 0 ? 16 * 1024 : 1024,
      })),
    },
    {
      name: "large-8x8MiB",
      files: Array.from({ length: 8 }, (_, index) => ({
        path: `large/b${index}.bin`,
        size: 8 * 1024 * 1024,
      })),
    },
  ];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

for (const spec of fixtureSpecs()) {
  const sourceRoot = await makeFixture(spec.name, spec.files);
  const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), `nodews-bench-dst-${spec.name}-`));
  const raw = {
    gateway: {
      localRoots: [sourceRoot],
      artifactRoots: [sourceRoot],
      returnRoots: [],
      chunkBytes: 64 * 1024,
      timeoutMs: 300_000,
      maxFiles: 5000,
      maxFileBytes: 32 * 1024 * 1024,
      maxTotalBytes: 256 * 1024 * 1024,
    },
    node: {
      pushRoots: [destinationRoot],
      artifactRoots: [destinationRoot],
      returnRoots: [destinationRoot],
      maxFiles: 5000,
      maxFileBytes: 32 * 1024 * 1024,
      maxTotalBytes: 256 * 1024 * 1024,
    },
  };
  const config = resolvePluginConfig(raw);
  const harness = createHarness(createNodeCommands(raw).commands);
  const bytes = spec.files.reduce((total, entry) => total + entry.size, 0);

  // Warm the process and filesystem caches; excluded from the result.
  await pushWorkspace(harness.transport, config.gateway, {
    node: "node-1",
    localPath: sourceRoot,
    remotePath: path.join(destinationRoot, "warmup"),
    incrementalFrom: undefined,
    exclude: undefined,
    signal: undefined,
    progress: undefined,
  });

  const samples = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const startedAt = performance.now();
    const outcome = await pushWorkspace(harness.transport, config.gateway, {
      node: "node-1",
      localPath: sourceRoot,
      remotePath: path.join(destinationRoot, `run-${index}`),
      incrementalFrom: undefined,
      exclude: undefined,
      signal: undefined,
      progress: undefined,
    });
    samples.push(performance.now() - startedAt);
    if (outcome.files !== spec.files.length || outcome.bytes !== bytes) {
      throw new Error(`unexpected outcome for ${spec.name}: ${outcome.files} files, ${outcome.bytes} bytes`);
    }
  }
  const middle = median(samples);
  const result = {
    fixture: spec.name,
    files: spec.files.length,
    bytes,
    iterations: samples.length,
    medianMs: Math.round(middle),
    minMs: Math.round(Math.min(...samples)),
    maxMs: Math.round(Math.max(...samples)),
    filesPerSecond: Math.round((spec.files.length / middle) * 1000),
    mibPerSecond: Number(((bytes / (1024 * 1024)) / (middle / 1000)).toFixed(2)),
    samplesMs: samples.map((value) => Math.round(value)),
  };
  console.log(JSON.stringify(result));
  await fs.rm(sourceRoot, { recursive: true, force: true });
  await fs.rm(destinationRoot, { recursive: true, force: true });
}

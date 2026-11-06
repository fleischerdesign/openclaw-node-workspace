import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePluginConfig } from "../src/config.js";
import { NodeWorkspaceError } from "../src/errors.js";
import { fetchArtifact } from "../src/gateway/artifact.js";
import { workspaceStatus } from "../src/gateway/status.js";
import { createNodeCommands } from "../src/node/commands.js";
import { pushWorkspace } from "../src/gateway/push.js";
import { createHarness, type Faults } from "./helpers/sim.js";

async function setup(options: { nodeBytes?: number; fault?: Faults } = {}) {
  const nodeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-node-"));
  const gatewayRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-gw-"));
  const raw = {
    gateway: {
      localRoots: [gatewayRoot],
      artifactRoots: [gatewayRoot],
      maxArtifactBytes: options.nodeBytes ?? 1024 * 1024,
      chunkBytes: 1024,
      timeoutMs: 20_000,
    },
    node: {
      pushRoots: [nodeRoot],
      artifactRoots: [nodeRoot],
      maxArtifactBytes: options.nodeBytes ?? 1024 * 1024,
    },
  };
  return {
    nodeRoot,
    gatewayRoot,
    config: resolvePluginConfig(raw),
    harness: createHarness(createNodeCommands(raw).commands, options.fault),
  };
}

test("artifact fetch writes verified bytes and never overwrites", async () => {
  const { nodeRoot, gatewayRoot, config, harness } = await setup();
  await fs.writeFile(path.join(nodeRoot, "result.json"), '{"ok":true}\n');
  const localPath = path.join(gatewayRoot, "result.json");

  const outcome = await fetchArtifact(harness.transport, config.gateway, {
    node: "node-1",
    remotePath: path.join(nodeRoot, "result.json"),
    localPath,
    signal: undefined,
    progress: undefined,
  });
  assert.equal(await fs.readFile(localPath, "utf8"), '{"ok":true}\n');
  assert.equal(outcome.bytes, 12);
  assert.equal(outcome.sha256, createHash("sha256").update('{"ok":true}\n').digest("hex"));

  await assert.rejects(
    () =>
      fetchArtifact(harness.transport, config.gateway, {
        node: "node-1",
        remotePath: path.join(nodeRoot, "result.json"),
        localPath,
        signal: undefined,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "destination-exists",
  );
});

test("artifact destination must be inside gateway.artifactRoots", async () => {
  const { nodeRoot, config, harness } = await setup();
  await fs.writeFile(path.join(nodeRoot, "a.txt"), "a");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-out-"));
  await assert.rejects(
    () =>
      fetchArtifact(harness.transport, config.gateway, {
        node: "node-1",
        remotePath: path.join(nodeRoot, "a.txt"),
        localPath: path.join(outside, "a.txt"),
        signal: undefined,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "path-outside-root",
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test("artifact source outside the node roots and symlinked artifacts are rejected", async () => {
  const { nodeRoot, gatewayRoot, config, harness } = await setup();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-secret-"));
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
  await assert.rejects(
    () =>
      fetchArtifact(harness.transport, config.gateway, {
        node: "node-1",
        remotePath: path.join(outside, "secret.txt"),
        localPath: path.join(gatewayRoot, "secret.txt"),
        signal: undefined,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "path-outside-root",
  );

  await fs.symlink(path.join(outside, "secret.txt"), path.join(nodeRoot, "link.txt"));
  await assert.rejects(
    () =>
      fetchArtifact(harness.transport, config.gateway, {
        node: "node-1",
        remotePath: path.join(nodeRoot, "link.txt"),
        localPath: path.join(gatewayRoot, "link.txt"),
        signal: undefined,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "symlink-rejected",
  );
});

test("artifact bytes are rejected when the node's completion digest disagrees", async () => {
  const { nodeRoot, gatewayRoot, config, harness } = await setup({
    fault: {
      nodeFrame: (frame) => {
        if (frame[0] !== 2) return undefined;
        const value = JSON.parse(Buffer.from(frame.subarray(1)).toString("utf8")) as Record<string, unknown>;
        if (value.t !== "done") return undefined;
        value.sha256 = "0".repeat(64);
        const body = Buffer.from(JSON.stringify(value), "utf8");
        const next = new Uint8Array(body.byteLength + 1);
        next[0] = 2;
        next.set(body, 1);
        return next;
      },
    },
  });
  await fs.writeFile(path.join(nodeRoot, "a.txt"), "alpha");
  await assert.rejects(
    () =>
      fetchArtifact(harness.transport, config.gateway, {
        node: "node-1",
        remotePath: path.join(nodeRoot, "a.txt"),
        localPath: path.join(gatewayRoot, "a.txt"),
        signal: undefined,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "integrity",
  );
  assert.deepEqual(await fs.readdir(gatewayRoot), []);
});

test("artifact size limit is enforced on both sides", async () => {
  const { nodeRoot, gatewayRoot, config, harness } = await setup({ nodeBytes: 4 });
  await fs.writeFile(path.join(nodeRoot, "big.txt"), "12345");
  await assert.rejects(
    () =>
      fetchArtifact(harness.transport, config.gateway, {
        node: "node-1",
        remotePath: path.join(nodeRoot, "big.txt"),
        localPath: path.join(gatewayRoot, "big.txt"),
        signal: undefined,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "limit-exceeded",
  );
  assert.deepEqual(await fs.readdir(gatewayRoot), []);
});

test("status distinguishes absent, foreign and plugin-owned destinations", async () => {
  const { nodeRoot, gatewayRoot, config, harness } = await setup();
  await fs.writeFile(path.join(gatewayRoot, "a.txt"), "alpha");

  const absent = await workspaceStatus(harness.transport, config.gateway, {
    node: "node-1",
    remotePath: path.join(nodeRoot, "absent"),
  });
  assert.equal(absent.exists, false);
  assert.equal(absent.parentExists, true);

  await fs.mkdir(path.join(nodeRoot, "foreign"));
  const foreign = await workspaceStatus(harness.transport, config.gateway, {
    node: "node-1",
    remotePath: path.join(nodeRoot, "foreign"),
  });
  assert.equal(foreign.exists, true);
  assert.equal(foreign.owned, false);

  const pushed = await pushWorkspace(harness.transport, config.gateway, {
    node: "node-1",
    localPath: gatewayRoot,
    remotePath: path.join(nodeRoot, "owned"),
    replace: false,
    exclude: undefined,
    signal: undefined,
    progress: undefined,
  });
  const owned = await workspaceStatus(harness.transport, config.gateway, {
    node: "node-1",
    remotePath: path.join(nodeRoot, "owned"),
  });
  assert.equal(owned.owned, true);
  assert.equal(owned.marker?.pushId, pushed.pushId);
});

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

test("a remote 0777 artifact becomes owner-only on the Gateway", async () => {
  const { nodeRoot, gatewayRoot, config, harness } = await setup();
  const source = path.join(nodeRoot, "tool.sh");
  await fs.writeFile(source, "#!/bin/sh\n");
  await fs.chmod(source, 0o777);
  const target = path.join(gatewayRoot, "tool.sh");
  const outcome = await fetchArtifact(harness.transport, config.gateway, {
    node: "node-1",
    remotePath: source,
    localPath: target,
    signal: undefined,
    progress: undefined,
  });
  const stat = await fs.stat(target);
  assert.equal(stat.mode & 0o777, 0o700);
  assert.equal(outcome.mode, 0o700);
});

test("a malicious remote mode of 0777 is still reduced to 0700", async () => {
  const { nodeRoot, gatewayRoot, config } = await setup();
  await fs.writeFile(path.join(nodeRoot, "tool.sh"), "#!/bin/sh\n");
  const raw = {
    gateway: { artifactRoots: [gatewayRoot], timeoutMs: 20_000, maxArtifactBytes: 1024 * 1024 },
    node: { artifactRoots: [nodeRoot], maxArtifactBytes: 1024 * 1024 },
  };
  const { createHarness } = await import("./helpers/sim.js");
  const harness = createHarness((await import("../src/node/commands.js")).createNodeCommands(raw).commands, {
    nodeFrame: (frame) => {
      if (frame[0] !== 2) return undefined;
      const value = JSON.parse(Buffer.from(frame.subarray(1)).toString("utf8")) as Record<string, unknown>;
      if (value.t !== "meta") return undefined;
      value.mode = 0o777;
      const body = Buffer.from(JSON.stringify(value), "utf8");
      const next = new Uint8Array(body.byteLength + 1);
      next[0] = 2;
      next.set(body, 1);
      return next;
    },
  });
  const target = path.join(gatewayRoot, "tool.sh");
  const outcome = await fetchArtifact(harness.transport, config.gateway, {
    node: "node-1",
    remotePath: path.join(nodeRoot, "tool.sh"),
    localPath: target,
    signal: undefined,
    progress: undefined,
  });
  assert.equal((await fs.stat(target)).mode & 0o777, 0o700);
  assert.equal(outcome.mode, 0o700);
});

test("a non-executable remote artifact stays 0600", async () => {
  const { nodeRoot, gatewayRoot, config, harness } = await setup();
  const source = path.join(nodeRoot, "notes.txt");
  await fs.writeFile(source, "notes");
  await fs.chmod(source, 0o666);
  const target = path.join(gatewayRoot, "notes.txt");
  const outcome = await fetchArtifact(harness.transport, config.gateway, {
    node: "node-1",
    remotePath: source,
    localPath: target,
    signal: undefined,
    progress: undefined,
  });
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  assert.equal(outcome.mode, 0o600);
});

test("status reports verified content and drift after modification", async () => {
  const { nodeRoot, gatewayRoot, config, harness } = await setup();
  await fs.writeFile(path.join(gatewayRoot, "a.txt"), "alpha");
  const remotePath = path.join(nodeRoot, "app");
  await pushWorkspace(harness.transport, config.gateway, {
    node: "node-1",
    localPath: gatewayRoot,
    remotePath,
    exclude: undefined,
    signal: undefined,
    progress: undefined,
  });
  const clean = await workspaceStatus(harness.transport, config.gateway, { node: "node-1", remotePath });
  assert.equal(clean.owned, true);
  assert.equal(clean.verified, true);
  assert.equal(clean.drift, null);

  await fs.writeFile(path.join(remotePath, "a.txt"), "changed on node");
  const drifted = await workspaceStatus(harness.transport, config.gateway, { node: "node-1", remotePath });
  assert.equal(drifted.owned, true);
  assert.equal(drifted.verified, false);
  assert.match(drifted.drift ?? "", /differs/);
});

test("status reports parentExists only for allowed paths", async () => {
  const { nodeRoot, config, harness } = await setup();
  const missing = await workspaceStatus(harness.transport, config.gateway, {
    node: "node-1",
    remotePath: path.join(nodeRoot, "missing", "child"),
  });
  assert.equal(missing.exists, false);
  assert.equal(missing.parentExists, false);

  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-status-out-"));
  await assert.rejects(
    () =>
      workspaceStatus(harness.transport, config.gateway, {
        node: "node-1",
        remotePath: path.join(outside, "x"),
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "path-outside-root",
  );
});

test("a stalled artifact transfer stops at the absolute deadline", async () => {
  const gatewayRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-deadline-"));
  const config = resolvePluginConfig({
    gateway: { artifactRoots: [gatewayRoot], timeoutMs: 1000, maxArtifactBytes: 1024 },
    node: {},
  });
  const { encodeControl } = await import("../src/frames.js");
  const transport = {
    async openDuplex() {
      let listener: ((message: Uint8Array) => void) | undefined;
      return {
        async send() {},
        onMessage(next: (message: Uint8Array) => void) {
          listener = next;
          queueMicrotask(() => listener?.(encodeControl({ t: "meta", size: 10, sha256: null, mode: 0o600 })));
          return () => {
            listener = undefined;
          };
        },
        closed: new Promise<never>(() => {}),
        close() {},
      };
    },
    async invoke() {
      throw new Error("unused");
    },
    async listNodes() {
      return [{ nodeId: "node-1", displayName: "Node One" }];
    },
  };
  const started = Date.now();
  await assert.rejects(
    () =>
      fetchArtifact(transport, config.gateway, {
        node: "node-1",
        remotePath: "/srv/x",
        localPath: path.join(gatewayRoot, "x"),
        signal: undefined,
        progress: undefined,
      }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "timeout",
  );
  assert.ok(Date.now() - started < 4000);
});

test("status unwraps the node-invoke envelope", async () => {
  const gatewayRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-envelope-"));
  const config = resolvePluginConfig({ gateway: { artifactRoots: [gatewayRoot] }, node: {} });
  const transport = {
    async openDuplex() {
      throw new Error("unused");
    },
    async invoke() {
      return {
        ok: true,
        payloadJSON: JSON.stringify({ exists: true, parentExists: true, owned: false, verified: false }),
      };
    },
    async listNodes() {
      return [{ nodeId: "node-1", displayName: "Node One" }];
    },
  };
  const status = await workspaceStatus(transport, config.gateway, { node: "node-1", remotePath: "/srv/app" });
  assert.equal(status.exists, true);
  assert.equal(status.parentExists, true);
  assert.equal(status.owned, false);
  assert.equal(status.verified, false);
});

import assert from "node:assert/strict";
import test from "node:test";

import { resolvePluginConfig } from "../src/config.js";
import { NodeWorkspaceError } from "../src/errors.js";
import { decodeFrame, encodeControl, encodeData } from "../src/frames.js";

test("plugin config applies safe defaults and rejects relative roots", () => {
  const config = resolvePluginConfig({ gateway: { localRoots: ["/srv/src"] }, node: { pushRoots: ["/srv/dst"] } });
  assert.deepEqual(config.gateway.localRoots, ["/srv/src"]);
  assert.deepEqual(config.gateway.artifactRoots, []);
  assert.equal(config.gateway.symlinks, "reject");
  assert.equal(config.gateway.maxFiles, 2000);
  assert.equal(config.node.maxArtifactBytes, 32 * 1024 * 1024);

  assert.throws(
    () => resolvePluginConfig({ gateway: { localRoots: ["relative/path"] } }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "config-invalid",
  );
});

test("plugin config rejects contradictory limits and an unknown symlink policy", () => {
  assert.throws(() => resolvePluginConfig({ gateway: { maxFileBytes: 10, maxTotalBytes: 5 } }));
  assert.throws(() => resolvePluginConfig({ gateway: { symlinks: "follow" } }));
  assert.throws(() => resolvePluginConfig({ gateway: { chunkBytes: 2 * 1024 * 1024 } }));
});

test("frame codec round-trips control and data frames", () => {
  const control = decodeFrame(encodeControl({ t: "hello", n: 1 }));
  assert.equal(control.kind, "control");
  assert.deepEqual(control.kind === "control" ? control.value : undefined, { t: "hello", n: 1 });

  const data = decodeFrame(encodeData(new Uint8Array([1, 2, 3])));
  assert.equal(data.kind, "data");
  assert.deepEqual([...(data.kind === "data" ? data.data : [])], [1, 2, 3]);
});

test("frame codec rejects empty data and unknown frame types", () => {
  assert.throws(() => encodeData(new Uint8Array()), NodeWorkspaceError);
  assert.throws(() => decodeFrame(new Uint8Array([9, 1])), NodeWorkspaceError);
  assert.throws(() => decodeFrame(new Uint8Array([2])), NodeWorkspaceError);
});

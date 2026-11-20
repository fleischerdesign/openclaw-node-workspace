import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { treeDigest } from "../src/digest.js";
import { NodeWorkspaceError } from "../src/errors.js";
import { scanSource } from "../src/manifest.js";
import { resolvePolicy } from "../src/policy.js";

const LIMITS = { maxFiles: 100, maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 };

async function tree(files: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-scan-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

test("scan records files, directories, sizes, executable bits and a stable digest", async () => {
  const root = await tree({
    "a.txt": "alpha",
    "sub/b.txt": "beta",
    "sub/deep/c.sh": "#!/bin/sh\n",
    "empty/.keep": "",
  });
  await fs.chmod(path.join(root, "sub/deep/c.sh"), 0o755);
  const request = { root, policy: resolvePolicy(undefined), limits: LIMITS };
  const first = await scanSource(request);
  const second = await scanSource(request);

  assert.deepEqual(first.files.map((entry) => entry.path), ["a.txt", "empty/.keep", "sub/b.txt", "sub/deep/c.sh"]);
  assert.deepEqual(first.directories, ["empty", "sub", "sub/deep"]);
  assert.equal(first.totalBytes, 5 + 4 + 10);
  assert.equal(first.treeDigest, second.treeDigest);
  assert.equal(first.treeDigest, treeDigest({ version: 1, files: first.files, directories: first.directories }));
  assert.equal(first.files.find((entry) => entry.path === "sub/deep/c.sh")?.executable, true);
  assert.equal(first.files.find((entry) => entry.path === "a.txt")?.executable, false);
});

test("scan rejects a symlink instead of following it", async () => {
  const root = await tree({ "target.txt": "x" });
  await fs.symlink("target.txt", path.join(root, "link.txt"), "file");
  await assert.rejects(
    () => scanSource({ root, policy: resolvePolicy(undefined), limits: LIMITS }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "symlink-rejected",
  );
});

test("scan rejects a FIFO instead of publishing it", async (t) => {
  const root = await tree({ "ok.txt": "x" });
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [path.join(root, "pipe")]);
  } catch {
    t.skip("mkfifo is unavailable");
    return;
  }
  await assert.rejects(
    () => scanSource({ root, policy: resolvePolicy(undefined), limits: LIMITS }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "special-file-rejected",
  );
});

test("scan enforces file count, per-file and total limits", async () => {
  const root = await tree({ "a.txt": "12345", "b.txt": "12345" });
  const policy = resolvePolicy(undefined);
  await assert.rejects(
    () => scanSource({ root, policy, limits: { ...LIMITS, maxFiles: 1 } }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "limit-exceeded",
  );
  await assert.rejects(
    () => scanSource({ root, policy, limits: { ...LIMITS, maxFileBytes: 3 } }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "limit-exceeded",
  );
  await assert.rejects(
    () => scanSource({ root, policy, limits: { ...LIMITS, maxTotalBytes: 8 } }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "limit-exceeded",
  );
});

test("cache subtrees are skipped before traversal and protected paths are counted, not hashed", async () => {
  const root = await tree({
    "keep.txt": "x",
    "node_modules/pkg/index.js": "x".repeat(1000),
    "target/debug/app": "binary",
    ".env": "SECRET",
    "certs/server.pem": "private",
    "docs/skip.md": "x",
  });
  const policy = resolvePolicy({ exclude: ["docs/**"] });
  const result = await scanSource({ root, policy, limits: LIMITS });
  assert.deepEqual(result.files.map((entry) => entry.path), ["keep.txt"]);
  assert.equal(result.excluded, 3);
  assert.equal(result.protectedCount, 2);
  assert.ok(result.skipped.some((entry) => entry.path === "node_modules" && entry.reason === "cache"));
  assert.ok(result.skipped.some((entry) => entry.path === ".env" && entry.reason === "protected"));
});

test("selection narrowing omits unselected files from the manifest", async () => {
  const root = await tree({ "src/a.ts": "a", "docs/b.md": "b" });
  const result = await scanSource({ root, policy: resolvePolicy({ include: ["src/**"] }), limits: LIMITS });
  assert.deepEqual(result.files.map((entry) => entry.path), ["src/a.ts"]);
  assert.deepEqual(result.directories, ["src"]);
});

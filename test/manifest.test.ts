import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NodeWorkspaceError } from "../src/errors.js";
import { scanWorkspace, validateManifestShape } from "../src/manifest.js";
import { treeDigest } from "../src/digest.js";

const LIMITS = { maxFiles: 100, maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 };
const BASE = { exclude: [], symlinks: "reject" as const, ...LIMITS };

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
  const first = await scanWorkspace({ root, ...BASE });
  const second = await scanWorkspace({ root, ...BASE });

  assert.deepEqual(first.files.map((entry) => entry.path), ["a.txt", "empty/.keep", "sub/b.txt", "sub/deep/c.sh"]);
  assert.deepEqual(first.directories, ["empty", "sub", "sub/deep"]);
  assert.equal(first.totalBytes, 5 + 4 + 10);
  assert.equal(first.treeDigest, second.treeDigest);
  assert.equal(first.treeDigest, treeDigest({ version: 1, files: first.files, directories: first.directories }));
  assert.equal(first.files.find((entry) => entry.path === "sub/deep/c.sh")?.executable, true);
  assert.equal(first.files.find((entry) => entry.path === "a.txt")?.executable, false);
});

test("scan rejects a symlink by default and can skip it", async () => {
  const root = await tree({ "target.txt": "x" });
  await fs.symlink("target.txt", path.join(root, "link.txt"), "file");
  await assert.rejects(() => scanWorkspace({ root, ...BASE }), (error: unknown) => {
    assert.ok(error instanceof NodeWorkspaceError);
    assert.equal(error.code, "symlink-rejected");
    return true;
  });
  const skipped = await scanWorkspace({ root, ...BASE, symlinks: "skip" });
  assert.deepEqual(skipped.files.map((entry) => entry.path), ["target.txt"]);
  assert.deepEqual(skipped.skipped, [{ path: "link.txt", reason: "symlink" }]);
});

test("scan rejects a FIFO instead of publishing it", async (t) => {
  const root = await tree({ "ok.txt": "x" });
  const fifo = path.join(root, "pipe");
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [fifo]);
  } catch {
    t.skip("mkfifo is unavailable");
    return;
  }
  await assert.rejects(() => scanWorkspace({ root, ...BASE }), (error: unknown) => {
    assert.ok(error instanceof NodeWorkspaceError);
    assert.equal(error.code, "special-file-rejected");
    return true;
  });
});

test("scan enforces file count, per-file and total limits", async () => {
  const root = await tree({ "a.txt": "12345", "b.txt": "12345" });
  await assert.rejects(
    () => scanWorkspace({ root, ...BASE, maxFiles: 1 }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "limit-exceeded",
  );
  await assert.rejects(
    () => scanWorkspace({ root, ...BASE, maxFileBytes: 3 }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "limit-exceeded",
  );
  await assert.rejects(
    () => scanWorkspace({ root, ...BASE, maxTotalBytes: 8 }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "limit-exceeded",
  );
});

test("scan applies exclude patterns to entries and subtrees", async () => {
  const root = await tree({ "keep.txt": "x", "node_modules/pkg/index.js": "x", "docs/skip.md": "x" });
  const result = await scanWorkspace({ root, ...BASE, exclude: ["node_modules", "docs/**"] });
  assert.deepEqual(result.files.map((entry) => entry.path), ["keep.txt"]);
});

test("validateManifestShape rejects traversal, duplicates, missing parents and byte mismatches", async () => {
  const hello = {
    t: "hello" as const,
    protocol: 3 as const,
    pushId: "a".repeat(32),
    remotePath: "/srv/work/app",
    totalBytes: 1,
    treeDigest: "b".repeat(64),
    manifest: [{ path: "a.txt", size: 1, sha256: "c".repeat(64), executable: false }],
    directories: [] as string[],
  };
  validateManifestShape(hello, LIMITS);
  assert.throws(() => validateManifestShape({ ...hello, manifest: [{ ...hello.manifest[0]!, path: "../a" }] }, LIMITS));
  assert.throws(() =>
    validateManifestShape(
      { ...hello, directories: ["a"], manifest: [{ ...hello.manifest[0]!, path: "a/x" }, { ...hello.manifest[0]!, path: "a/x" }] },
      LIMITS,
    ),
  );
  assert.throws(() => validateManifestShape({ ...hello, manifest: [{ ...hello.manifest[0]!, path: "a/x" }] }, LIMITS));
  assert.throws(() => validateManifestShape({ ...hello, totalBytes: 2 }, LIMITS));
  assert.throws(() => validateManifestShape({ ...hello, remotePath: "/srv/../etc" }, LIMITS));
  assert.throws(() =>
    validateManifestShape({ ...hello, manifest: [], totalBytes: 0, directories: ["a/b"] }, LIMITS),
  );
});

test("an oversized marker manifest is rejected before publication", () => {
  const files = Array.from({ length: 1100 }, (_, index) => ({
    path: `${Array.from({ length: 16 }, () => "a".repeat(250)).join("/")}/${index}`,
    size: 0,
    sha256: "0".repeat(64),
    executable: false,
  }));
  const hello = {
    t: "hello" as const,
    protocol: 3 as const,
    pushId: "a".repeat(32),
    remotePath: "/srv/work/app",
    totalBytes: 0,
    treeDigest: "b".repeat(64),
    manifest: files,
    directories: [] as string[],
  };
  assert.throws(
    () => validateManifestShape(hello, { maxFiles: 5000, maxFileBytes: 1024, maxTotalBytes: 1024 }),
    (error: unknown) => error instanceof NodeWorkspaceError && error.code === "limit-exceeded",
  );
});

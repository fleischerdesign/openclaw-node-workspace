import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ManifestEntry } from "../src/digest.js";
import { readReturnState, writeReturnState } from "../src/gateway/return-state.js";

function entry(pathName: string, content: string): ManifestEntry {
  return { path: pathName, size: content.length, sha256: "a".repeat(64), executable: false };
}

test("two nodes with the same remotePath keep separate return baselines", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-state-"));
  const remotePath = "/srv/work/app";
  const filesA = [entry("a.txt", "node a")];
  const filesB = [entry("a.txt", "node b")];
  assert.equal(
    await writeReturnState(root, "node-a", remotePath, "1".repeat(64), filesA, new Set(["a.txt"])),
    true,
  );
  assert.equal(
    await writeReturnState(root, "node-b", remotePath, "2".repeat(64), filesB, new Set(["a.txt"])),
    true,
  );
  assert.equal((await readReturnState(root, "node-a", remotePath))?.[0]?.sha256, filesA[0]?.sha256);
  assert.equal((await readReturnState(root, "node-b", remotePath))?.[0]?.sha256, filesB[0]?.sha256);
  const body = JSON.parse(await fs.readFile(path.join(root, ".nodews-return-state.json"), "utf8")) as {
    bases: Record<string, { nodeId: string; remotePath: string }>;
  };
  const values = Object.values(body.bases);
  assert.equal(values.length, 2);
  assert.deepEqual(values.map((entry) => entry.nodeId).sort(), ["node-a", "node-b"]);
  assert.equal(values.every((entry) => entry.remotePath === remotePath), true);
});

test("a foreign file named like the state file is left untouched", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-state-"));
  const target = path.join(root, ".nodews-return-state.json");
  await fs.writeFile(target, "user-owned content\n");
  assert.equal(
    await writeReturnState(root, "node-a", "/srv/work/app", "1".repeat(64), [entry("a.txt", "a")], new Set(["a.txt"])),
    false,
  );
  assert.equal(await fs.readFile(target, "utf8"), "user-owned content\n");
});

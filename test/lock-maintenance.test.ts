import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "lock-maintenance.mjs");
const KEY = "a".repeat(32);

async function setup(content: string): Promise<{ stateDir: string; file: string }> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-lock-maint-"));
  await fs.mkdir(path.join(stateDir, "locks"), { recursive: true });
  const file = path.join(stateDir, "locks", `${KEY}.lock`);
  await fs.writeFile(file, content);
  return { stateDir, file };
}

async function maintenance(stateDir: string, args: string[]): Promise<{ code: number; stderr: string }> {
  try {
    await run(process.execPath, [SCRIPT, "--state-dir", stateDir, "--key", KEY, ...args]);
    return { code: 0, stderr: "" };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : 1, stderr: failure.stderr ?? "" };
  }
}

test("the operator script refuses a live lock even with the right token", async () => {
  const body = JSON.stringify({
    version: 1,
    pid: process.pid,
    processStart: null,
    host: "node",
    token: "live-token",
    operationId: "op",
    acquiredAt: Date.now(),
  });
  const { stateDir } = await setup(body);
  const result = await maintenance(stateDir, ["--token", "live-token", "--pid", String(process.pid), "--quiescent", "--yes"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /still alive/);
});

test("the operator script refuses a replaced dead lock and removes the exact inspected one", async () => {
  const dead = JSON.stringify({
    version: 1,
    pid: 999_999,
    processStart: null,
    host: "node",
    token: "dead-token",
    operationId: "op",
    acquiredAt: Date.now(),
  });
  const { stateDir, file } = await setup(dead);
  const wrong = await maintenance(stateDir, ["--token", "other-token", "--pid", "999999", "--quiescent", "--yes"]);
  assert.notEqual(wrong.code, 0);
  assert.equal(await fs.readFile(file, "utf8"), dead);

  const removed = await maintenance(stateDir, ["--token", "dead-token", "--pid", "999999", "--quiescent", "--yes"]);
  assert.equal(removed.code, 0);
  await assert.rejects(() => fs.lstat(file), /ENOENT/);
});

test("an unreadable lock needs its exact inspected sha256", async () => {
  const { stateDir, file } = await setup("not-json");
  const wrong = await maintenance(stateDir, ["--sha256", "0".repeat(64), "--quiescent", "--yes"]);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.stderr, /does not match/);
  assert.equal(await fs.readFile(file, "utf8"), "not-json");

  const digest = createHash("sha256").update("not-json").digest("hex");
  const removed = await maintenance(stateDir, ["--sha256", digest, "--quiescent", "--yes"]);
  assert.equal(removed.code, 0);
  await assert.rejects(() => fs.lstat(file), /ENOENT/);
});

test("the operator script requires the quiescence and confirmation flags", async () => {
  const { stateDir } = await setup("{}");
  const missing = await maintenance(stateDir, ["--sha256", createHash("sha256").update("{}").digest("hex")]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /quiescent/);
});

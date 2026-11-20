#!/usr/bin/env node
// Operator-only stale workspace-lock maintenance.
//
// This is intentionally NOT a Gateway plugin tool and NOT a node command. Run it
// locally on a node whose OpenClaw node host is stopped (quiescent). It removes
// one inspected lock only when the current bytes still match the exact identity
// the operator names: either token+pid of a provably dead process, or the
// sha256 of an unreadable lock. Automatic reclamation stays disabled because
// POSIX has no compare-and-delete primitive.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function usage(message) {
  console.error(
    `${message}\n` +
      "usage: node scripts/lock-maintenance.mjs --state-dir <dir> --key <key> --quiescent --yes\n" +
      "         (--token <token> --pid <pid> | --sha256 <hex>)",
  );
  process.exit(2);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "usage: node scripts/lock-maintenance.mjs --state-dir <dir> --key <key> --quiescent --yes\n" +
      "         (--token <token> --pid <pid> | --sha256 <hex>)",
  );
  process.exit(0);
}

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith("--")) usage(`unexpected argument ${token}`);
  const name = token.slice(2);
  if (name === "quiescent" || name === "yes") {
    args.set(name, true);
    continue;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) usage(`missing value for --${name}`);
  args.set(name, value);
  index += 1;
}

const stateDir = args.get("state-dir");
const key = args.get("key");
if (typeof stateDir !== "string" || !path.isAbsolute(stateDir)) usage("--state-dir must be absolute");
if (typeof key !== "string" || !/^[0-9a-f]{16,64}$/u.test(key)) usage("--key must be lowercase hex");
if (!args.get("quiescent")) usage("--quiescent is required; stop the node host first");
if (!args.get("yes")) usage("--yes is required for the destructive removal");

const token = args.get("token");
const pidRaw = args.get("pid");
const sha256 = args.get("sha256");
const haveToken = typeof token === "string" || typeof pidRaw === "string";
const haveSha = typeof sha256 === "string";
if (haveToken === haveSha) usage("name exactly one identity: --token/--pid or --sha256");
if (haveToken && (typeof token !== "string" || typeof pidRaw !== "string")) usage("--token and --pid belong together");
if (haveSha && !/^[0-9a-f]{64}$/u.test(sha256)) usage("--sha256 must be 64 lowercase hex characters");

const lockFile = path.join(stateDir, "locks", `${key}.lock`);

async function processStart(pid) {
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return null;
    return raw.slice(close + 2).trim().split(/\s+/u)[19] ?? null;
  } catch {
    return null;
  }
}

async function alive(pid, start) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code !== "EPERM") return false;
  }
  if (start === null) return true;
  return (await processStart(pid)) === start;
}

let raw;
try {
  raw = await fs.readFile(lockFile);
} catch (error) {
  console.error(`refusing: cannot read ${lockFile}: ${error?.message ?? String(error)}`);
  process.exit(1);
}
const digest = createHash("sha256").update(raw).digest("hex");

if (haveToken) {
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    console.error("refusing: lock is unreadable; use --sha256 after inspecting the exact bytes");
    process.exit(1);
  }
  const pid = Number(pidRaw);
  if (body?.version !== 1 || body?.token !== token || body?.pid !== pid) {
    console.error("refusing: the lock no longer matches the inspected token/pid");
    process.exit(1);
  }
  if (await alive(pid, typeof body.processStart === "string" ? body.processStart : null)) {
    console.error(`refusing: pid ${pid} is still alive`);
    process.exit(1);
  }
} else if (digest !== sha256) {
  console.error(`refusing: current sha256 ${digest} does not match ${sha256}`);
  process.exit(1);
}

// Re-read and re-hash immediately before the removal. The operator has declared
// quiescence; a changed byte still aborts instead of deleting a replacement.
const beforeRemove = await fs.readFile(lockFile);
if (createHash("sha256").update(beforeRemove).digest("hex") !== digest) {
  console.error("refusing: the lock changed while maintenance was running");
  process.exit(1);
}
await fs.unlink(lockFile);
const directory = path.dirname(lockFile);
try {
  const handle = await fs.open(directory, "r");
  await handle.sync();
  await handle.close();
} catch {
  // Directory fsync is best effort for this operator action.
}
console.log(JSON.stringify({ removed: lockFile, sha256: digest, token: token ?? null, pid: pidRaw ?? null }));

#!/usr/bin/env node
// Asserts the live end-to-end run in scripts/model-live-e2e.sh.
//
// The failure this catches: a genuine model (not the scripted double) fails to
// drive the promised sequence — it does not choose node_workspace_push, does not
// run exec on the node, does not use the pushed cwd, or does not fetch the
// artifact — while every process still exits zero. It also catches the subtler
// failure of a model that claims success after a different tool produced (or
// failed to produce) the file.
//
// Evidence sources:
//   - agent.json            the Gateway's own tool summary and final text;
//   - the filesystem        the published tree, the node-produced file, and the
//                           fetched artifact bytes with their SHA-256;
//   - the trajectory export the model-facing tool calls and their arguments,
//                           recorded by the Gateway, not by the plugin. Paths in
//                           that export are redacted to $WORKSPACE_DIR.
//
// Usage: model-live-assert.mjs <work> <remoteDir> <artifactLocal> <modelRef>

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [work, remoteDir, artifactLocal, modelRef] = process.argv.slice(2);
if (!work || !remoteDir || !artifactLocal || !modelRef) {
  console.error("usage: model-live-assert.mjs <work> <remoteDir> <artifactLocal> <modelRef>");
  process.exit(2);
}

function fail(message) {
  console.error(`ASSERT FAILED: ${message}`);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
}

// The trajectory redacts the Gateway workspace prefix; do the same to the
// paths we compare against.
const redacted = (value) => (typeof value === "string" ? value.split(work).join("$WORKSPACE_DIR") : value);
const REDIRECTED_REMOTE = redacted(remoteDir);
const REDIRECTED_ARTIFACT = redacted(artifactLocal);

// 1. The agent's own report.
const agent = readJson(path.join(work, "agent.json"));
if (agent.error) fail(`the agent turn reported an error: ${JSON.stringify(agent.error).slice(0, 300)}`);
if (agent.status && agent.status !== "ok" && agent.status !== "completed") {
  fail(`the agent turn ended with status ${JSON.stringify(agent.status)}`);
}
const meta = agent.result?.meta ?? {};
const summary = meta.toolSummary ?? {};
if (!(summary.calls >= 3)) fail(`the agent reported ${summary.calls ?? 0} tool calls, expected at least 3`);
if (summary.failures !== 0) fail(`the agent reported ${summary.failures} tool failures`);
const finalText = meta.finalAssistantMessageRawText ?? "";
if (!finalText.includes("LIVE-E2E-COMPLETE")) {
  fail(`the final assistant text lacks the completion marker: ${JSON.stringify(finalText.slice(0, 300))}`);
}

// 2. The filesystem effect: published tree, node-produced file, fetched artifact.
const hello = path.join(remoteDir, "hello.txt");
if (!fs.existsSync(hello)) fail(`the push did not publish ${hello}`);
if (fs.readFileSync(hello, "utf8") !== "hello from the gateway workspace\n") {
  fail("published hello.txt bytes differ from the source");
}
if (!fs.existsSync(path.join(remoteDir, "nested", "notes.md"))) fail("the nested file did not reach the node");
if (!fs.existsSync(artifactLocal)) fail(`the artifact was not fetched to ${artifactLocal}`);

const fetched = fs.readFileSync(artifactLocal, "utf8");
if (fetched !== "from node exec\n") fail(`fetched artifact bytes differ: ${JSON.stringify(fetched)}`);
const nodeCopyPath = path.join(remoteDir, "exec-result.txt");
if (!fs.existsSync(nodeCopyPath)) fail("the node copy of the produced artifact is missing");
if (fs.readFileSync(nodeCopyPath, "utf8") !== fetched) fail("the fetched artifact differs from the node copy");
const digest = crypto.createHash("sha256").update(fetched).digest("hex");

// 3. The model's choices, from the Gateway's trajectory export.
const trajectoryFile = path.join(work, "trajectory.json");
if (!fs.existsSync(trajectoryFile)) fail("the trajectory export is missing; the model's tool choices are unproven");
const report = readJson(trajectoryFile);
if (!report.outputDir) fail("the trajectory export names no output directory");
const eventsPath = path.join(report.outputDir, "events.jsonl");
if (!fs.existsSync(eventsPath)) fail(`the trajectory events file is missing: ${eventsPath}`);

const calls = new Map();
for (const line of fs.readFileSync(eventsPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.type !== "tool.call") continue;
  const data = event.data ?? {};
  // The export records each call twice (arguments and args); key by call id.
  if (!data.toolCallId || typeof data.name !== "string") continue;
  if (calls.has(data.toolCallId)) continue;
  calls.set(data.toolCallId, { name: data.name, args: data.arguments ?? data.args ?? null });
}
const ordered = [...calls.values()];
if (ordered.length === 0) fail("the trajectory export contains no tool calls; the model's choices are unproven");

const indexOfCall = (predicate) => ordered.findIndex(predicate);
const pushIndex = indexOfCall((call) => call.name === "node_workspace_push" && redacted(call.args?.remotePath) === REDIRECTED_REMOTE);
const execIndex = indexOfCall(
  (call) => call.name === "exec" && call.args?.host === "node" && redacted(call.args?.workdir) === REDIRECTED_REMOTE,
);
const artifactIndex = indexOfCall(
  (call) =>
    call.name === "node_workspace_artifact" &&
    redacted(call.args?.remotePath) === `${REDIRECTED_REMOTE}/exec-result.txt` &&
    redacted(call.args?.localPath) === REDIRECTED_ARTIFACT,
);

const names = ordered.map((call) => call.name);
if (pushIndex < 0) fail(`no node_workspace_push targeted ${remoteDir}; calls: ${names.join(", ")}`);
if (execIndex < 0) {
  fail(`no exec ran on the node with workdir equal to the pushed cwd; calls: ${names.join(", ")}`);
}
if (artifactIndex < 0) {
  fail(`no node_workspace_artifact fetched the produced file to the artifact root; calls: ${names.join(", ")}`);
}
if (!(pushIndex < execIndex && execIndex < artifactIndex)) {
  fail(`the required calls are not in push -> node exec -> artifact order: ${names.join(", ")}`);
}

console.log(
  JSON.stringify(
    {
      model: modelRef,
      toolOrder: [ordered[pushIndex].name, ordered[execIndex].name, ordered[artifactIndex].name],
      execHost: ordered[execIndex].args.host,
      execWorkdir: redacted(ordered[execIndex].args.workdir),
      artifactDigest: digest,
      agentCalls: summary.calls,
      agentFailures: summary.failures,
      allCalls: names,
    },
    null,
    2,
  ),
);

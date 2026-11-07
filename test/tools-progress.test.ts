import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePluginConfig } from "../src/config.js";
import { TransferProgressStore } from "../src/gateway/progress-store.js";
import { createTools, type AgentUpdate } from "../src/gateway/tools.js";
import { createNodeCommands } from "../src/node/commands.js";
import { createHarness } from "./helpers/sim.js";

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-progress-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

test("push onUpdate carries channel-visible progress with rising counters", async () => {
  const sourceRoot = await workspace({
    "a.bin": "a".repeat(40_000),
    "b.bin": "b".repeat(40_000),
  });
  const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nodews-progress-dest-"));
  const raw = {
    gateway: {
      localRoots: [sourceRoot],
      artifactRoots: [destinationRoot],
      chunkBytes: 1024,
      timeoutMs: 20_000,
      maxFiles: 100,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    },
    node: {
      pushRoots: [destinationRoot],
      artifactRoots: [destinationRoot],
      maxFiles: 100,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    },
  };
  const config = resolvePluginConfig(raw);
  const node = createNodeCommands(raw);
  assert.equal(node.configError, undefined);
  const harness = createHarness(node.commands);

  const progress = new TransferProgressStore();
  const scope = { sessionKey: "agent:main:progress", agentId: "main" };
  let notifications = 0;
  const pushTool = createTools({
    transport: harness.transport,
    config: config.gateway,
    configError: undefined,
    scope,
    progress,
    onProgressChange: () => (notifications += 1),
  }).find(
    (tool) => tool.name === "node_workspace_push",
  );
  assert.ok(pushTool);

  const updates: AgentUpdate[] = [];
  const result = await pushTool.execute(
    "call-progress",
    {
      node: "Node One",
      localPath: sourceRoot,
      remotePath: path.join(destinationRoot, "target"),
    },
    undefined,
    (update) => updates.push(update),
  );

  assert.equal(result.details.ok, true);
  assert.ok(updates.length >= 2, `expected progress updates, saw ${updates.length}`);

  const sends = [];
  for (const update of updates) {
    assert.equal(update.progress?.visibility, "channel");
    assert.equal(update.progress?.privacy, "public");
    assert.equal(update.progress?.id, "node-workspace-push");
    assert.equal(update.content[0]?.type, "text");
    assert.equal(update.content[0]?.text, update.progress?.text);
    assert.match(update.progress?.text ?? "", /^Node workspace (scanning|sending|publishing): /u);
    if (update.progress?.text.includes("sending: ")) sends.push(update.progress.text);
  }

  assert.ok(
    updates.some((update) => update.progress?.text.includes("scanning")),
    "no scanning update",
  );
  assert.ok(sends.length > 0, "no sending update");
  assert.ok(
    updates.some((update) => update.progress?.text.includes("publishing")),
    "no publishing update",
  );

  const parsed = sends.map((text) => {
    const match = /sending: (\d+)\/(\d+) files, ([\d.]+) MiB/u.exec(text);
    assert.ok(match, `unparseable progress text: ${text}`);
    return { files: Number(match[1]), total: Number(match[2]), mib: Number(match[3]) };
  });
  assert.ok(notifications > 0, "no progress notification was emitted");
  const snapshot = progress.snapshot(scope);
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0]?.state, "completed");
  assert.equal(snapshot[0]?.filesTotal, 2);
  assert.equal(snapshot[0]?.filesDone, 2);
  assert.equal(snapshot[0]?.bytesTotal, 80_000);

  assert.ok(parsed.every((entry) => entry.total === 2), "file total changed during the push");

  // A rejected second publish is a measured failure, not a fake completion.
  await fs.appendFile(path.join(sourceRoot, "a.bin"), "changed");
  const conflict = await pushTool.execute("call-conflict", {
    node: "Node One",
    localPath: sourceRoot,
    remotePath: path.join(destinationRoot, "target"),
  });
  assert.equal(conflict.details.ok, false);
  const afterConflict = progress.snapshot(scope);
  assert.equal(afterConflict.length, 2);
  assert.equal(afterConflict[1]?.state, "failed");
  assert.ok(!("localPath" in afterConflict[1]!));
  assert.ok(!("remotePath" in afterConflict[1]!));
  for (let index = 1; index < parsed.length; index += 1) {
    assert.ok(parsed[index].files >= parsed[index - 1].files, "file counter went backwards");
    assert.ok(parsed[index].mib >= parsed[index - 1].mib, "byte counter went backwards");
  }
});

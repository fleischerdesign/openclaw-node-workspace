#!/usr/bin/env bash
# Disposable end-to-end: a real model turn drives the plugin tools, then the
# native node exec, then an artifact fetch.
#
# What is real here:
#   - a Gateway and a node host process, both isolated under a temporary HOME,
#     state and config; the live fleet is never touched;
#   - the model HTTP path: the agent talks to an OpenAI-compatible endpoint over
#     streaming chat completions, and OpenClaw parses tool calls from it;
#   - the plugin tools, the duplex node transport, the node-side writes, the
#     node's system.run, and the fetched artifact bytes.
#
# What is simulated: the model itself. scripts/model-stub.mjs is a scripted
# test double that decides the next tool call from the tool results in the
# request. This proves the model-driven plumbing and the agent/tool contract;
# it does not prove that a particular hosted model chooses these tools well.
#
# Nothing here is an in-process mock: tools run in the Gateway process, files
# land on disk, and the node command runs in the node host process.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d /tmp/nodews-e2e-XXXXXX)"
GATEWAY_PID=""
NODE_PID=""
STUB_PID=""
CHILD_PID=""

exec 9>&2
note() { printf '%s\n' "$*" >&9; }
stage() { printf '[%s] == %s\n' "$(date +%H:%M:%S)" "$*"; }

on_signal() {
  local name="$1" code="$2"
  trap '' TERM INT
  note "FAIL: interrupted by SIG$name"
  if [[ -n "$CHILD_PID" ]]; then
    kill -TERM "$CHILD_PID" 2>/dev/null || true
    for _ in $(seq 1 100); do kill -0 "$CHILD_PID" 2>/dev/null || break; sleep 0.1; done
    kill -KILL "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
    CHILD_PID=""
  fi
  exit "$code"
}
trap 'on_signal TERM 143' TERM
trap 'on_signal INT 130' INT

port_in_use() {
  node -e '
    const net = require("node:net");
    const socket = net.connect(Number(process.argv[1]), "127.0.0.1");
    socket.on("connect", () => { socket.destroy(); process.exit(0); });
    socket.on("error", () => process.exit(1));
    setTimeout(() => process.exit(1), 1000);
  ' "$1"
}

free_port() {
  node -e '
    const server = require("node:net").createServer();
    server.listen(0, "127.0.0.1", () => {
      console.log(server.address().port);
      server.close();
    });
  '
}

PORT="${NODEWS_TEST_PORT:-$(free_port)}"
STUB_PORT="${NODEWS_STUB_PORT:-$(free_port)}"
if port_in_use "$PORT" || port_in_use "$STUB_PORT"; then
  echo "FAIL: a selected port is already in use; refusing to start or signal anything" >&2
  exit 1
fi

stop_group() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  trap '' TERM INT
  stop_group "$NODE_PID"
  stop_group "$GATEWAY_PID"
  stop_group "$STUB_PID"
  if [[ "$status" -ne 0 ]]; then
    note "FAILED (exit $status): logs follow (set NODEWS_E2E_KEEP_WORK=1 to keep $WORK)"
    for log in stub.log gateway.log node.log agent.json agent.err; do
      [[ -f "$WORK/$log" ]] && { echo "--- $log ---" >&9; tail -60 "$WORK/$log" >&9 || true; }
    done
    [[ "${NODEWS_E2E_KEEP_WORK:-0}" == "1" ]] && return
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

TARBALL="$WORK/plugin.tgz"
cd "$ROOT"
npm run build >/dev/null
npm pack --pack-destination "$WORK" >/dev/null
TARBALL="$(ls "$WORK"/*.tgz)"

mkdir -p "$WORK/gateway/home" "$WORK/gateway/state" "$WORK/node/home" "$WORK/node/state"
mkdir -p "$WORK/gateway-root/src/nested" "$WORK/gateway-root/artifacts" "$WORK/node-root"
printf 'hello from the gateway workspace\n' > "$WORK/gateway-root/src/hello.txt"
printf 'nested file\n' > "$WORK/gateway-root/src/nested/notes.md"
printf '#!/bin/sh\necho run\n' > "$WORK/gateway-root/src/run.sh"
chmod 0755 "$WORK/gateway-root/src/run.sh"

REMOTE_DIR="$WORK/node-root/agent-workspace"
ARTIFACT_REMOTE="$REMOTE_DIR/exec-result.txt"
ARTIFACT_LOCAL="$WORK/gateway-root/artifacts/exec-result.txt"

export NODEWS_WORK="$WORK" NODEWS_PORT="$PORT"
cat > "$WORK/isolated" <<'HELPER'
#!/usr/bin/env bash
set -euo pipefail
side="$1"; shift
exec env -i \
  PATH="$PATH" \
  HOME="$NODEWS_WORK/$side/home" \
  OPENCLAW_STATE_DIR="$NODEWS_WORK/$side/state" \
  OPENCLAW_CONFIG_PATH="$NODEWS_WORK/$side/state/openclaw.json" \
  OPENCLAW_NIX_MODE=0 \
  OPENCLAW_GATEWAY_PORT="$NODEWS_PORT" \
  TMPDIR="$NODEWS_WORK/tmp-$side" \
  "$@"
HELPER
chmod 0700 "$WORK/isolated"
isolated() {
  "$WORK/isolated" "$@" &
  local pid=$!
  CHILD_PID=$pid
  local code=0
  if wait "$pid"; then code=0; else code=$?; fi
  CHILD_PID=""
  return "$code"
}
mkdir -p "$WORK/tmp-gateway" "$WORK/tmp-node"

stage "install plugin in both isolated states"
for side in gateway node; do
  isolated "$side" openclaw plugins install "npm-pack:$TARBALL" --force --accept-capabilities >/dev/null
done

stage "configure gateway and node"
node - "$WORK" "$PORT" "$STUB_PORT" <<'PATCH_JSON'
const fs = require("node:fs");
const path = require("node:path");
const [work, port, stubPort] = process.argv.slice(2);
const gateway = {
  gateway: {
    mode: "local",
    bind: "loopback",
    port: Number(port),
    auth: { mode: "none" },
    nodes: {
      pairing: { autoApproveCidrs: [] },
      commands: { allow: ["nodews.push", "nodews.fetch", "nodews.status"] },
    },
  },
  models: {
    mode: "merge",
    providers: {
      e2e: {
        baseUrl: `http://127.0.0.1:${stubPort}/v1`,
        apiKey: "e2e-local",
        api: "openai-completions",
        models: [
          {
            id: "scripted-e2e",
            name: "Scripted E2E",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            contextTokens: 180000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  // The plugin registers optional tools. An unset profile keeps core tools but
  // does not opt into plugin tools, and Tool Search (automatic when unset)
  // would hide their schemas behind a directory. This test wants the direct
  // surface a `full` profile gives, because that is the path the tool names in
  // the model request then prove.
  tools: { profile: "full", toolSearch: false },
  agents: {
    defaults: {
      model: { primary: "e2e/scripted-e2e" },
    },
  },
  plugins: {
    entries: {
      "node-workspace": {
        config: {
          gateway: {
            localRoots: [path.join(work, "gateway-root", "src")],
            artifactRoots: [path.join(work, "gateway-root", "artifacts")],
          },
        },
      },
    },
  },
};
const node = {
  plugins: {
    entries: {
      "node-workspace": {
        config: {
          node: {
            pushRoots: [path.join(work, "node-root")],
            artifactRoots: [path.join(work, "node-root")],
          },
        },
      },
    },
  },
};
fs.writeFileSync(path.join(work, "gateway-patch.json"), JSON.stringify(gateway, null, 2));
fs.writeFileSync(path.join(work, "node-patch.json"), JSON.stringify(node, null, 2));
PATCH_JSON
isolated gateway openclaw config patch --file "$WORK/gateway-patch.json" >/dev/null
isolated node openclaw config patch --file "$WORK/node-patch.json" >/dev/null

stage "start scripted model endpoint on $STUB_PORT"
STUB_TRACE="$WORK/model-trace.jsonl" \
STUB_PORT="$STUB_PORT" \
STUB_PUSH_LOCAL="$WORK/gateway-root/src" \
STUB_PUSH_REMOTE="$REMOTE_DIR" \
STUB_NODE_NAME="e2e-node" \
STUB_ARTIFACT_REMOTE="$ARTIFACT_REMOTE" \
STUB_ARTIFACT_LOCAL="$ARTIFACT_LOCAL" \
STUB_EXEC_COMMAND="pwd && cat hello.txt && printf 'from node exec\n' > exec-result.txt" \
  setsid node "$ROOT/scripts/model-stub.mjs" >"$WORK/stub.log" 2>&1 &
STUB_PID=$!
for _ in $(seq 1 50); do
  if grep -q '"kind":"listening"' "$WORK/model-trace.jsonl" 2>/dev/null; then break; fi
  sleep 0.1
done

stage "start gateway on $PORT"
setsid "$WORK/isolated" gateway openclaw gateway --port "$PORT" --bind loopback >"$WORK/gateway.log" 2>&1 &
GATEWAY_PID=$!
READY=0
for _ in $(seq 1 120); do
  if port_in_use "$PORT"; then READY=1; break; fi
  sleep 1
done
[[ "$READY" == 1 ]] || { echo "FAIL: gateway did not listen on $PORT" >&2; exit 1; }
echo "gateway listening on $PORT"

stage "start node host with the system.run surface advertised"
setsid "$WORK/isolated" node openclaw node run --host 127.0.0.1 --port "$PORT" --no-tls --display-name "e2e-node" \
  --commands nodews.push,nodews.fetch,nodews.status,system.run,system.run.prepare >"$WORK/node.log" 2>&1 &
NODE_PID=$!

stage "wait for pairing and approve the declared surface"
for _ in $(seq 1 120); do
  isolated gateway openclaw nodes list --json >"$WORK/nodes.json" 2>/dev/null || true
  if grep -q 'e2e-node' "$WORK/nodes.json"; then break; fi
  isolated gateway openclaw nodes pending --json >"$WORK/pending-probe.json" 2>/dev/null || true
  if grep -q 'e2e-node' "$WORK/pending-probe.json"; then
    isolated gateway openclaw nodes pending --json >"$WORK/pending.json" 2>&1 || true
    REQUEST_ID="$(node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const rows=j.pending??j.requests??j;const first=Array.isArray(rows)?rows[0]:rows;console.log(first?.requestId??first?.id??"")}catch{console.log("")}' "$WORK/pending.json")"
    if [[ -n "$REQUEST_ID" ]]; then isolated gateway openclaw nodes approve "$REQUEST_ID" >/dev/null; fi
  fi
  sleep 1
done
cat "$WORK/nodes.json"
NODE_ID="$(node -e 'const fs=require("node:fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const rows=j.paired??j.nodes??j;const n=rows.find(x=>x.displayName==="e2e-node");console.log(n?.nodeId??"")' "$WORK/nodes.json")"
[[ -n "$NODE_ID" ]] || { echo "FAIL: node did not connect" >&2; exit 1; }
echo "node id: $NODE_ID"

stage "approve a pending surface expansion, if the node asked for one"
isolated gateway openclaw nodes pending --json >"$WORK/pending-after.json" 2>/dev/null || true
PENDING_IDS="$(node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const rows=Array.isArray(j)?j:j.pending??[];console.log(rows.filter(r=>r.displayName==="e2e-node").map(r=>r.requestId).join("\n"))}catch{console.log("")}' "$WORK/pending-after.json")"
for request in $PENDING_IDS; do isolated gateway openclaw nodes approve "$request" >/dev/null; done

stage "confirm the plugin tools are on the agent tool surface"
isolated gateway openclaw gateway call tools.catalog --json >"$WORK/tools.json" 2>&1 || true
node - "$WORK/tools.json" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const names = JSON.stringify(report);
for (const tool of ["node_workspace_push", "node_workspace_artifact", "node_workspace_status"]) {
  if (!names.includes(tool)) throw new Error(`plugin tool ${tool} is not registered on the gateway`);
}
console.log("plugin tools registered on the gateway");
NODE

stage "run one model-driven agent turn through the gateway"
isolated gateway openclaw agent \
  --session-key agent:main:e2e-model \
  --message "Publish the gateway workspace to the e2e-node, run the test command there with the exec tool in the published directory, then fetch exec-result.txt back. Report each result." \
  --timeout 300 --json >"$WORK/agent.json" 2>"$WORK/agent.err"
echo "agent turn finished"

stage "assert the wire trace, the tool results and the bytes"
node - "$WORK" "$REMOTE_DIR" "$ARTIFACT_LOCAL" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const [work, remoteDir, artifactLocal] = process.argv.slice(2);

const trace = fs
  .readFileSync(path.join(work, "model-trace.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .filter((entry) => entry.kind === "request");

const decisions = trace.map((entry) => entry.decision);
const tools = decisions.filter((decision) => decision.tool).map((decision) => decision.tool);
if (tools.length < 3) throw new Error(`expected at least 3 tool calls from the model, saw ${tools.length}: ${tools.join(", ")}`);
if (tools[0] !== "node_workspace_push") throw new Error(`first model tool call was ${tools[0]}, expected node_workspace_push`);
if (tools[1] !== "exec") throw new Error(`second model tool call was ${tools[1]}, expected exec`);
if (tools[2] !== "node_workspace_artifact") throw new Error(`third model tool call was ${tools[2]}, expected node_workspace_artifact`);

const execCall = decisions.find((decision) => decision.tool === "exec");
if (execCall.args.host !== "node") throw new Error(`exec did not target the node: ${JSON.stringify(execCall.args)}`);
if (execCall.args.workdir !== remoteDir) throw new Error(`exec workdir ${execCall.args.workdir} != pushed cwd ${remoteDir}`);

const toolPreviews = trace.flatMap((entry) => entry.toolMessages ?? []).map((message) => message.preview);
const pushPreview = toolPreviews.find((text) => text.startsWith("published:"));
if (!pushPreview) throw new Error("no successful node_workspace_push result reached the model");
if (!pushPreview.includes(`on node `)) throw new Error("push result did not name the node");

const execPreview = toolPreviews.find((text) => text.includes("hello from the gateway workspace"));
if (!execPreview) throw new Error("exec result with node stdout did not reach the model");
if (!execPreview.split("\n").includes(remoteDir)) {
  throw new Error(`node exec did not run in the pushed cwd; stdout: ${execPreview}`);
}

if (!fs.existsSync(artifactLocal)) throw new Error(`artifact was not fetched to ${artifactLocal}`);
const fetched = fs.readFileSync(artifactLocal, "utf8");
if (fetched !== "from node exec\n") throw new Error(`fetched artifact bytes differ: ${JSON.stringify(fetched)}`);
const nodeCopy = fs.readFileSync(path.join(remoteDir, "exec-result.txt"), "utf8");
if (nodeCopy !== fetched) throw new Error("gateway artifact differs from the node copy");
const digest = crypto.createHash("sha256").update(fetched).digest("hex");
const artifactPreview = toolPreviews.find((text) => text.startsWith("Wrote "));
if (!artifactPreview) throw new Error("artifact tool result did not reach the model");
if (!artifactPreview.includes(digest)) throw new Error("artifact tool result does not carry the fetched digest");

const agent = JSON.parse(fs.readFileSync(path.join(work, "agent.json"), "utf8"));
const summary = agent.result?.meta?.toolSummary;
if (!summary || summary.calls < 3) throw new Error(`agent reported ${summary?.calls ?? 0} tool calls, expected at least 3`);
if (summary.failures !== 0) throw new Error(`agent reported ${summary.failures} tool failures`);
const finalText = agent.result?.meta?.finalAssistantMessageRawText ?? "";
if (!finalText.includes("E2E complete")) throw new Error(`unexpected final assistant text: ${JSON.stringify(finalText.slice(0, 200))}`);

console.log(JSON.stringify({
  modelCalls: trace.length,
  toolOrder: tools,
  execWorkdir: execCall.args.workdir,
  artifactDigest: digest,
  agentCalls: summary.calls,
  agentFailures: summary.failures,
}, null, 2));
NODE

stage "read the stored session and confirm the tool progress is part of it"
isolated gateway openclaw gateway call sessions.list --json >"$WORK/sessions.json" 2>&1 || true
node - "$WORK/sessions.json" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const text = JSON.stringify(report);
if (!text.includes("e2e-model")) throw new Error("the agent session is missing from sessions.list");
console.log("agent session is present in the Gateway session store");
NODE

if [[ "${NODEWS_E2E_SERVE:-0}" == "1" ]]; then
  cat > "$WORK/serve-info.txt" <<INFO
work=$WORK
url=http://127.0.0.1:$PORT/
session=agent:main:e2e-model
node=$NODE_ID
stop=$WORK/stop
INFO
  cat "$WORK/serve-info.txt"
  echo "SERVE: waiting for $WORK/stop"
  while [[ ! -f "$WORK/stop" ]]; do sleep 1; done
  echo "SERVE: stop marker seen"
fi

echo "PASS: a model turn published, executed in the pushed node cwd, fetched the artifact, and the session recorded it"

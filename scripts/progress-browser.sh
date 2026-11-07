#!/usr/bin/env bash
# Disposable end-to-end for the Control UI's visible push progress.
#
# What is real here:
#   - a Gateway and a node host process, both isolated under a temporary HOME,
#     state and config; the live fleet is never touched;
#   - the real Control UI in headless Chromium, the real composer, the real
#     agent loop and tool dispatch, the real duplex node transport and files;
#   - the scripted OpenAI-compatible endpoint, which only decides to call
#     node_workspace_push and then answers.
#
# The fixture is large and the chunk size is small on purpose: the push runs for
# many seconds, so the driver can screenshot the Control UI while the transfer
# is genuinely in progress. Nothing in the browser is faked or replayed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d /tmp/nodews-progress-XXXXXX)"
EVIDENCE="${NODEWS_PROGRESS_OUT:-$(mktemp -d /tmp/nodews-progress-evidence-XXXXXX)}"
FIXTURE_FILES="${NODEWS_PROGRESS_FILES:-800}"
FIXTURE_BYTES="${NODEWS_PROGRESS_BYTES:-65536}"
CHUNK_BYTES="${NODEWS_PROGRESS_CHUNK:-1024}"
GATEWAY_PID=""
NODE_PID=""
STUB_PID=""
DRIVER_PID=""
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
  stop_group "$DRIVER_PID"
  stop_group "$NODE_PID"
  stop_group "$GATEWAY_PID"
  stop_group "$STUB_PID"
  if [[ "$status" -ne 0 ]]; then
    note "FAILED (exit $status): logs follow (set NODEWS_PROGRESS_KEEP_WORK=1 to keep $WORK)"
    for log in driver.log stub.log gateway.log node.log; do
      [[ -f "$WORK/$log" ]] && { echo "--- $log ---" >&9; tail -80 "$WORK/$log" >&9 || true; }
    done
    [[ -f "$EVIDENCE/report.json" ]] && { echo "--- report.json ---" >&9; cat "$EVIDENCE/report.json" >&9 || true; }
    if [[ "${NODEWS_PROGRESS_KEEP_WORK:-0}" == "1" ]]; then
      note "work=$WORK evidence=$EVIDENCE"
      return
    fi
  else
    note "evidence=$EVIDENCE"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

CHROMIUM_BIN="${PROGRESS_CHROMIUM:-}"
if [[ -z "$CHROMIUM_BIN" ]]; then
  for candidate in \
    /nix/store/cfxpl6qy25sgq5sa7shj4dbdsxwwp286-chromium-156.0.8078.73/bin/chromium \
    /nix/store/fqriy9vihl23l4md56qgiks8z0d2xdlw-chromium-156.0.8078.79/bin/chromium \
    /nix/store/r0f9i35n3r7rng8162xih4c1dag0s1vw-chromium-156.0.8078.47/bin/chromium; do
    [[ -x "$candidate" ]] && { CHROMIUM_BIN="$candidate"; break; }
  done
fi
[[ -n "$CHROMIUM_BIN" && -x "$CHROMIUM_BIN" ]] || {
  echo "FAIL: no Chromium executable; set PROGRESS_CHROMIUM" >&2
  exit 1
}

TARBALL="$WORK/plugin.tgz"
cd "$ROOT"
npm run build >/dev/null
npm pack --pack-destination "$WORK" >/dev/null
TARBALL="$(ls "$WORK"/*.tgz)"

CONTROL_UI_ENTRY="$(node -e 'const manifest=require("./openclaw.plugin.json"); const entry=manifest.controlUi?.entry; if(typeof entry!=="string"||!entry) process.exit(2); console.log(entry)')"
tar -tzf "$TARBALL" | grep -qx "package/$CONTROL_UI_ENTRY" || {
  echo "FAIL: the packed plugin does not contain controlUi.entry $CONTROL_UI_ENTRY" >&2
  exit 1
}
tar -tzf "$TARBALL" | grep -qx "package/dist/index.js" || {
  echo "FAIL: the packed plugin does not contain its runtime entry" >&2
  exit 1
}
echo "tarball carries $CONTROL_UI_ENTRY"

mkdir -p "$WORK/gateway/home" "$WORK/gateway/state" "$WORK/node/home" "$WORK/node/state"
mkdir -p "$WORK/gateway-root/src" "$WORK/gateway-root/artifacts" "$WORK/node-root"
mkdir -p "$WORK/tmp-gateway" "$WORK/tmp-node" "$EVIDENCE"

stage "create a $FIXTURE_FILES-file fixture ($FIXTURE_BYTES bytes each)"
node - "$WORK/gateway-root/src" "$FIXTURE_FILES" "$FIXTURE_BYTES" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [root, countArg, bytesArg] = process.argv.slice(2);
const count = Number(countArg);
const bytes = Number(bytesArg);
for (let index = 0; index < count; index += 1) {
  const name = `file-${String(index).padStart(5, "0")}.bin`;
  const buffer = Buffer.alloc(bytes);
  buffer.write(`file ${index}\n`);
  for (let offset = 0; offset < bytes; offset += 64) buffer.writeUInt32LE(index * 100000 + offset, offset);
  fs.writeFileSync(path.join(root, name), buffer);
}
console.log(`fixture: ${count} files, ${(count * bytes / (1024 * 1024)).toFixed(2)} MiB`);
NODE

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
export NODEWS_WORK="$WORK" NODEWS_PORT="$PORT"

stage "install plugin in both isolated states"
for side in gateway node; do
  isolated "$side" openclaw plugins install "npm-pack:$TARBALL" --force --accept-capabilities >/dev/null
done

stage "configure gateway and node"
node - "$WORK" "$PORT" "$STUB_PORT" "$CHUNK_BYTES" <<'PATCH_JSON'
const fs = require("node:fs");
const path = require("node:path");
const [work, port, stubPort, chunkBytes] = process.argv.slice(2);
const gateway = {
  gateway: {
    mode: "local",
    bind: "loopback",
    port: Number(port),
    auth: { mode: "none" },
    controlUi: {
      enabled: true,
      experimental: { customPlugins: true },
    },
    nodes: {
      pairing: { autoApproveCidrs: [] },
      commands: { allow: ["nodews.push", "nodews.fetch", "nodews.status"] },
    },
  },
  models: {
    mode: "merge",
    providers: {
      progress: {
        baseUrl: `http://127.0.0.1:${stubPort}/v1`,
        apiKey: "progress-local",
        api: "openai-completions",
        models: [
          {
            id: "progress-scripted",
            name: "Progress Scripted",
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
  tools: { profile: "full", toolSearch: false },
  agents: { defaults: { model: { primary: "progress/progress-scripted" } } },
  plugins: {
    entries: {
      "node-workspace": {
        config: {
          gateway: {
            localRoots: [path.join(work, "gateway-root", "src")],
            artifactRoots: [path.join(work, "gateway-root", "artifacts")],
            chunkBytes: Number(chunkBytes),
            maxFiles: 5000,
            maxFileBytes: 32 * 1024 * 1024,
            maxTotalBytes: 512 * 1024 * 1024,
            timeoutMs: 600000,
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
            maxFiles: 5000,
            maxTotalBytes: 512 * 1024 * 1024,
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

REMOTE_DIR="$WORK/node-root/agent-progress"

stage "start scripted model endpoint on $STUB_PORT"
STUB_TRACE="$WORK/model-trace.jsonl" \
STUB_PORT="$STUB_PORT" \
STUB_PUSH_LOCAL="$WORK/gateway-root/src" \
STUB_PUSH_REMOTE="$REMOTE_DIR" \
STUB_NODE_NAME="progress-node" \
  setsid node "$ROOT/scripts/progress-stub.mjs" >"$WORK/stub.log" 2>&1 &
STUB_PID=$!
for _ in $(seq 1 50); do
  grep -q '"kind":"listening"' "$WORK/model-trace.jsonl" 2>/dev/null && break
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

stage "start node host"
setsid "$WORK/isolated" node openclaw node run --host 127.0.0.1 --port "$PORT" --no-tls --display-name "progress-node" \
  --commands nodews.push,nodews.fetch,nodews.status,system.run,system.run.prepare >"$WORK/node.log" 2>&1 &
NODE_PID=$!

stage "wait for pairing and approve the node"
for _ in $(seq 1 120); do
  isolated gateway openclaw nodes list --json >"$WORK/nodes.json" 2>/dev/null || true
  grep -q 'progress-node' "$WORK/nodes.json" && break
  isolated gateway openclaw nodes pending --json >"$WORK/pending-probe.json" 2>/dev/null || true
  if grep -q 'progress-node' "$WORK/pending-probe.json"; then
    isolated gateway openclaw nodes pending --json >"$WORK/pending.json" 2>&1 || true
    REQUEST_ID="$(node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const rows=j.pending??j.requests??j;const first=Array.isArray(rows)?rows[0]:rows;console.log(first?.requestId??first?.id??"")}catch{console.log("")}' "$WORK/pending.json")"
    [[ -n "$REQUEST_ID" ]] && isolated gateway openclaw nodes approve "$REQUEST_ID" >/dev/null
  fi
  sleep 1
done
cat "$WORK/nodes.json"
NODE_ID="$(node -e 'const fs=require("node:fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const rows=j.paired??j.nodes??j;const n=rows.find(x=>x.displayName==="progress-node");console.log(n?.nodeId??"")' "$WORK/nodes.json")"
[[ -n "$NODE_ID" ]] || { echo "FAIL: node did not connect" >&2; exit 1; }
echo "node id: $NODE_ID"

stage "approve a pending surface expansion, if the node asked for one"
isolated gateway openclaw nodes pending --json >"$WORK/pending-after.json" 2>/dev/null || true
PENDING_IDS="$(node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const rows=Array.isArray(j)?j:j.pending??[];console.log(rows.filter(r=>r.displayName==="progress-node").map(r=>r.requestId).join("\n"))}catch{console.log("")}' "$WORK/pending-after.json")"
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

stage "open the real Control UI and start the turn from its composer"
rm -f "$WORK/ui-ready"
PROGRESS_CHROMIUM="$CHROMIUM_BIN" \
PROGRESS_TIMEOUT_MS="${NODEWS_PROGRESS_TIMEOUT_MS:-240000}" \
PROGRESS_CAPTURE_ALL=1 \
PROGRESS_CAPTURE_WS=1 \
PROGRESS_RECONNECT=1 \
PROGRESS_DONE_TOKEN="$REMOTE_DIR" \
PROGRESS_PROMPT="Publish the progress fixture directory to the progress-node with node_workspace_push. Do not do anything else." \
  node "$ROOT/scripts/progress-driver.mjs" "$PORT" "$EVIDENCE" "$WORK/ui-ready" >"$WORK/driver.log" 2>&1 &
DRIVER_PID=$!
for _ in $(seq 1 300); do
  [[ -f "$WORK/ui-ready" ]] && break
  kill -0 "$DRIVER_PID" 2>/dev/null || break
  sleep 0.2
done
[[ -f "$WORK/ui-ready" ]] || { echo "FAIL: Control UI did not become ready" >&2; exit 1; }
echo "Control UI ready; waiting for the driver"

DRIVER_STATUS=0
if wait "$DRIVER_PID"; then DRIVER_STATUS=0; else DRIVER_STATUS=$?; fi
DRIVER_PID=""
cat "$WORK/driver.log"

stage "assert the bytes on the node and the recorded progress"
node - "$WORK" "$REMOTE_DIR" "$FIXTURE_FILES" "$EVIDENCE" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [work, remoteDir, filesArg, evidence] = process.argv.slice(2);
const expected = Number(filesArg);

if (!fs.existsSync(remoteDir)) throw new Error(`the node destination was not published: ${remoteDir}`);
const markerPath = path.join(remoteDir, ".openclaw-node-workspace.json");
if (!fs.existsSync(markerPath)) throw new Error(`the node destination has no marker: ${markerPath}`);
const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
if (marker.state !== "complete") throw new Error(`marker state is ${marker.state}, expected complete`);
if (marker.files !== expected) throw new Error(`marker reports ${marker.files} files, expected ${expected}`);

const trace = fs
  .readFileSync(path.join(work, "model-trace.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .filter((entry) => entry.kind === "request");
if (!trace.some((entry) => entry.decision?.tool === "node_workspace_push")) {
  throw new Error("the scripted model never requested node_workspace_push");
}

const report = JSON.parse(fs.readFileSync(path.join(evidence, "report.json"), "utf8"));
if (!report.ok) throw new Error(`browser report is not ok: ${JSON.stringify(report.problems ?? report.failure)}`);

console.log(
  JSON.stringify(
    {
      files: marker.files,
      bytes: marker.bytes,
      distinctAccessoryCounts: report.distinctAccessoryCounts.length,
      distinctBarValues: report.distinctBarValues.length,
      reloaded: report.reloaded,
      sawReconnectCount: report.sawReconnectCount,
      screenshots: report.screenshots.length,
      report: path.join(evidence, "report.json"),
    },
    null,
    2,
  ),
);
NODE

echo "PASS: the Control UI showed live node_workspace_push progress while the transfer was running"
echo "EVIDENCE: $EVIDENCE"

#!/usr/bin/env bash
# Disposable two-process integration: isolated Gateway + isolated node host.
# Proves that the plugin loads on both sides, the node advertises its commands,
# and a real node invocation answers through the Gateway policy/allowlist.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d /tmp/nodews-int-XXXXXX)"
PORT="${NODEWS_TEST_PORT:-19789}"
GATEWAY_PID=""
NODE_PID=""

cleanup() {
  [[ -n "$NODE_PID" ]] && kill "$NODE_PID" 2>/dev/null || true
  [[ -n "$GATEWAY_PID" ]] && kill "$GATEWAY_PID" 2>/dev/null || true
  sleep 1
  [[ -n "$NODE_PID" ]] && kill -9 "$NODE_PID" 2>/dev/null || true
  [[ -n "$GATEWAY_PID" ]] && kill -9 "$GATEWAY_PID" 2>/dev/null || true
  pkill -f "gateway --port $PORT" 2>/dev/null || true
  pkill -f "node run --host 127.0.0.1 --port $PORT" 2>/dev/null || true
  sleep 1
  rm -rf "$WORK"
}
trap cleanup EXIT

TARBALL="$WORK/plugin.tgz"
cd "$ROOT"
npm pack --pack-destination "$WORK" >/dev/null
TARBALL="$(ls "$WORK"/*.tgz)"

mkdir -p "$WORK/gateway/home" "$WORK/gateway/state" "$WORK/node/home" "$WORK/node/state"
mkdir -p "$WORK/node-root/pushed" "$WORK/gateway-root/src" "$WORK/gateway-root/artifacts"
printf 'hello from the gateway workspace\n' > "$WORK/gateway-root/src/hello.txt"
printf 'artifact from the node\n' > "$WORK/node-root/pushed/result.txt"

isolated() {
  local side="$1"; shift
  env -i \
    PATH="$PATH" \
    HOME="$WORK/$side/home" \
    OPENCLAW_STATE_DIR="$WORK/$side/state" \
    OPENCLAW_CONFIG_PATH="$WORK/$side/state/openclaw.json" \
    OPENCLAW_NIX_MODE=0 \
    OPENCLAW_GATEWAY_PORT="$PORT" \
    TMPDIR="$WORK/tmp-$side" \
    "$@"
}
mkdir -p "$WORK/tmp-gateway" "$WORK/tmp-node"

echo "== install plugin in both isolated states"
for side in gateway node; do
  isolated "$side" openclaw plugins install "npm-pack:$TARBALL" --force --accept-capabilities >/dev/null
done

echo "== configure gateway"
isolated gateway openclaw config set gateway.mode local >/dev/null
isolated gateway openclaw config set gateway.bind loopback >/dev/null
isolated gateway openclaw config set gateway.port "$PORT" >/dev/null
isolated gateway openclaw config set gateway.auth.mode none >/dev/null
isolated gateway openclaw config set gateway.nodes.commands.allow \
  '["nodews.push","nodews.fetch","nodews.status"]' >/dev/null
isolated gateway openclaw config set plugins.entries.node-workspace.config.gateway.localRoots \
  "[\"$WORK/gateway-root/src\"]" >/dev/null
isolated gateway openclaw config set plugins.entries.node-workspace.config.gateway.artifactRoots \
  "[\"$WORK/gateway-root/artifacts\"]" >/dev/null

echo "== configure node"
isolated node openclaw config set plugins.entries.node-workspace.config.node.pushRoots \
  "[\"$WORK/node-root\"]" >/dev/null
isolated node openclaw config set plugins.entries.node-workspace.config.node.artifactRoots \
  "[\"$WORK/node-root\"]" >/dev/null

echo "== start gateway on $PORT"
isolated gateway openclaw gateway --port "$PORT" --bind loopback >"$WORK/gateway.log" 2>&1 &
GATEWAY_PID=$!
READY=0
for _ in $(seq 1 90); do
  if node -e 'const net=require("net");const s=net.connect(Number(process.argv[1]),"127.0.0.1");s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),1000)' "$PORT"; then
    READY=1
    break
  fi
  sleep 1
done
[[ "$READY" == 1 ]] || { echo "FAIL: gateway did not listen on $PORT" >&2; tail -40 "$WORK/gateway.log" >&2; exit 1; }
echo "gateway listening on $PORT"

echo "== start node host"
isolated node openclaw node run --host 127.0.0.1 --port "$PORT" --no-tls --display-name "integration-node" \
  --commands nodews.push,nodews.fetch,nodews.status >"$WORK/node.log" 2>&1 &
NODE_PID=$!

echo "== wait for pairing"
for _ in $(seq 1 90); do
  isolated gateway openclaw nodes list --json >"$WORK/nodes.json" 2>/dev/null || true
  if grep -q 'integration-node' "$WORK/nodes.json"; then break; fi
  if isolated gateway openclaw nodes pending --json 2>/dev/null | grep -q 'integration-node'; then
    isolated gateway openclaw nodes pending --json >"$WORK/pending.json" 2>&1 || true
    REQUEST_ID="$(node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const rows=j.pending??j.requests??j;const first=Array.isArray(rows)?rows[0]:rows;console.log(first?.requestId??first?.id??"")}catch{console.log("")}' "$WORK/pending.json")"
    if [[ -n "$REQUEST_ID" ]]; then isolated gateway openclaw nodes approve "$REQUEST_ID" >/dev/null; fi
  fi
  sleep 1
done
cat "$WORK/nodes.json"
NODE_ID="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const rows=j.paired??j.nodes??j;const n=rows.find(x=>x.displayName==="integration-node");console.log(n?.nodeId??"")' "$WORK/nodes.json")"
[[ -n "$NODE_ID" ]] || { echo "FAIL: node did not connect" >&2; tail -30 "$WORK/node.log" >&2; tail -30 "$WORK/gateway.log" >&2; exit 1; }

node - "$WORK/nodes.json" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const rows = report.paired ?? report.nodes ?? report;
const node = rows.find((entry) => entry.displayName === "integration-node");
for (const command of ["nodews.push", "nodews.fetch", "nodews.status"]) {
  if (!node.commands.includes(command)) throw new Error(`node did not advertise ${command}`);
}
console.log(`node advertised ${node.commands.join(", ")}`);
NODE

echo "== describe node"
isolated gateway openclaw nodes describe --node "$NODE_ID" 2>&1 | tee "$WORK/describe.txt" || true

echo "== invoke nodews.status through the real Gateway and node"
isolated gateway openclaw nodes invoke --node "$NODE_ID" --command nodews.status \
  --params "{\"remotePath\":\"$WORK/node-root/pushed\"}" 2>&1 | tee "$WORK/invoke.txt"

node - "$WORK/invoke.txt" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.payload?.exists !== true) throw new Error("status did not report the existing directory");
if (report.payload?.owned !== false) throw new Error("unexpected ownership on a plain directory");
console.log("status payload verified");
NODE
echo "PASS: isolated Gateway + node host answered nodews.status"

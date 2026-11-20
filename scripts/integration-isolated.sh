#!/usr/bin/env bash
# Disposable two-process integration: isolated Gateway + isolated node host.
# Proves that the plugin loads on both sides, the node advertises its managed
# commands, and the plugin tools update one durable source workspace across the
# real process boundary: tools.invoke -> gateway tool -> openDuplex frames ->
# node transaction handler -> verified filesystem state. No in-process mock and
# no live state is involved.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d /tmp/nodews-int-XXXXXX)"
GATEWAY_PID=""
NODE_PID=""
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

if [[ -n "${NODEWS_TEST_PORT:-}" ]]; then
  PORT="$NODEWS_TEST_PORT"
else
  PORT="$(node -e '
    const server = require("node:net").createServer();
    server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });
  ')"
fi
if port_in_use "$PORT"; then
  echo "FAIL: port $PORT is already in use; refusing to start or signal anything" >&2
  exit 1
fi

stop_group() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  trap '' TERM INT
  stop_group "$NODE_PID"
  stop_group "$GATEWAY_PID"
  if [[ "$status" -ne 0 ]]; then
    note "FAILED (exit $status): gateway and node logs follow (set NODEWS_KEEP_WORK=1 to keep $WORK)"
    [[ -f "$WORK/gateway.log" ]] && { tail -80 "$WORK/gateway.log" >&9 || true; }
    [[ -f "$WORK/node.log" ]] && { tail -40 "$WORK/node.log" >&9 || true; }
    [[ "${NODEWS_KEEP_WORK:-0}" == "1" ]] && return
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

cd "$ROOT"
npm run build >/dev/null
npm pack --pack-destination "$WORK" >/dev/null
TARBALL="$(ls "$WORK"/*.tgz)"

mkdir -p "$WORK/gateway/home" "$WORK/gateway/state" "$WORK/node/home" "$WORK/node/state"
GW_WORKSPACE="$WORK/gateway/state/workspace"
GW_ROOT="$GW_WORKSPACE/gateway-root"
mkdir -p "$WORK/node-root/pushed" "$GW_ROOT/src" "$GW_ROOT/artifacts"
printf 'artifact from the node\n' > "$WORK/node-root/pushed/result.txt"

# A non-trivial source tree: nested directories, an empty file, binary bytes,
# an executable bit, a protected secret, and a dependency cache that must never
# cross the channel.
mkdir -p "$GW_ROOT/src/nested/deep" "$GW_ROOT/src/node_modules/pkg" "$GW_ROOT/src/target/debug"
printf 'hello from the gateway workspace\n' > "$GW_ROOT/src/hello.txt"
printf 'nested file\n' > "$GW_ROOT/src/nested/deep/notes.md"
printf '#!/bin/sh\necho run\n' > "$GW_ROOT/src/run.sh"
chmod 0755 "$GW_ROOT/src/run.sh"
: > "$GW_ROOT/src/empty.txt"
printf 'SECRET=do-not-transfer\n' > "$GW_ROOT/src/.env"
printf 'dependency\n' > "$GW_ROOT/src/node_modules/pkg/index.js"
printf 'cache\n' > "$GW_ROOT/src/target/debug/app"
node -e 'const fs=require("node:fs");const b=Buffer.alloc(4096);for(let i=0;i<b.length;i+=1)b[i]=(i*37+11)&255;fs.writeFileSync(process.argv[1],b)' \
  "$GW_ROOT/src/blob.bin"

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
mkdir -p "$WORK/tmp-gateway" "$WORK/tmp-node"

isolated() {
  "$WORK/isolated" "$@" &
  local pid=$!
  CHILD_PID=$pid
  local code=0
  if wait "$pid"; then code=0; else code=$?; fi
  CHILD_PID=""
  return "$code"
}

tool_call() {
  local params
  params="$(node -e 'process.stdout.write(JSON.stringify({name:process.argv[1],args:JSON.parse(process.argv[2])}))' "$1" "$2")"
  isolated gateway openclaw gateway call tools.invoke --json --timeout 180000 --params "$params" >"$3"
}

stage "install plugin in both isolated states"
for side in gateway node; do
  isolated "$side" openclaw plugins install "npm-pack:$TARBALL" --force --accept-capabilities >/dev/null
done

stage "configure gateway and node with one validated patch each"
node - "$WORK" "$PORT" <<'PATCH_JSON'
const fs = require("node:fs");
const path = require("node:path");
const [work, port] = process.argv.slice(2);
const gateway = {
  gateway: {
    mode: "local",
    bind: "loopback",
    port: Number(port),
    auth: { mode: "none" },
    nodes: { commands: { allow: ["nodews.sync", "nodews.fetch", "nodews.status"] } },
  },
  plugins: {
    entries: {
      "node-workspace": {
        config: {
          gateway: {
            localRoots: [path.join(work, "gateway", "state", "workspace", "gateway-root", "src")],
            artifactRoots: [path.join(work, "gateway", "state", "workspace", "gateway-root", "artifacts")],
          },
        },
      },
    },
  },
};
const node = {
  nodeHost: { autoUpdate: { enabled: false } },
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

stage "start gateway on $PORT"
setsid "$WORK/isolated" gateway openclaw gateway --port "$PORT" --bind loopback >"$WORK/gateway.log" 2>&1 &
GATEWAY_PID=$!
READY=0
for _ in $(seq 1 90); do
  if port_in_use "$PORT"; then READY=1; break; fi
  sleep 1
done
[[ "$READY" == 1 ]] || { echo "FAIL: gateway did not listen on $PORT" >&2; tail -40 "$WORK/gateway.log" >&2; exit 1; }
echo "gateway listening on $PORT"

stage "start node host"
setsid "$WORK/isolated" node openclaw node run --host 127.0.0.1 --port "$PORT" --no-tls --display-name "integration-node" \
  --commands nodews.sync,nodews.fetch,nodews.status >"$WORK/node.log" 2>&1 &
NODE_PID=$!

stage "wait for pairing"
for _ in $(seq 1 90); do
  isolated gateway openclaw nodes list --json >"$WORK/nodes.json" 2>/dev/null || true
  if grep -q 'integration-node' "$WORK/nodes.json"; then break; fi
  isolated gateway openclaw nodes pending --json >"$WORK/pending-probe.json" 2>/dev/null || true
  if grep -q 'integration-node' "$WORK/pending-probe.json"; then
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
for (const command of ["nodews.sync", "nodews.fetch", "nodews.status"]) {
  if (!node.commands.includes(command)) throw new Error(`node did not advertise ${command}`);
}
console.log(`node advertised ${node.commands.join(", ")}`);
NODE

stage "invoke nodews.status through the real Gateway and node"
isolated gateway openclaw nodes invoke --node "$NODE_ID" --command nodews.status \
  --params "{\"remotePath\":\"$WORK/node-root/pushed\"}" >"$WORK/invoke.txt" 2>&1
cat "$WORK/invoke.txt"
node - "$WORK/invoke.txt" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const payload = report.payload ?? report;
if (payload.exists !== true) throw new Error("status did not report the existing directory");
if (payload.owned !== false) throw new Error("unexpected ownership on a plain directory");
console.log("status payload verified");
NODE

REMOTE_APP="$WORK/node-root/app"
PREVIEW_ARGS="$(node -e 'process.stdout.write(JSON.stringify({node:"integration-node",localPath:process.argv[1],remotePath:process.argv[2],mode:"preview",create:true,policy:{preset:"node"}}))' \
  "$GW_ROOT/src" "$REMOTE_APP")"

stage "preview through the plugin tool: tools.invoke -> openDuplex -> nodews.sync"
tool_call node_workspace_sync "$PREVIEW_ARGS" "$WORK/tool-preview.json"
cat "$WORK/tool-preview.json"

node - "$WORK/tool-preview.json" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.ok !== true) throw new Error(`preview failed: ${JSON.stringify(report.error ?? report)}`);
if (report.source !== "plugin") throw new Error("preview was not served by the plugin");
const details = report.output?.details;
if (details?.status !== "planned") throw new Error(`unexpected preview status: ${String(details?.status)}`);
if (details?.createRequired !== true) throw new Error("preview did not require creation");
if (typeof details?.planDigest !== "string") throw new Error("preview did not return a planDigest");
if (details?.counts?.conflicts !== 0) throw new Error("preview reported a conflict");
console.log("preview returned a pinned plan and wrote nothing");
NODE

APPLY_ARGS="$(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify({node:"integration-node",localPath:process.argv[2],remotePath:process.argv[3],mode:"apply",create:true,policy:{preset:"node"},planDigest:p.output.details.planDigest,operationId:"a".repeat(32)}))' \
  "$WORK/tool-preview.json" "$GW_ROOT/src" "$REMOTE_APP")"
tool_call node_workspace_sync "$APPLY_ARGS" "$WORK/tool-apply.json"
cat "$WORK/tool-apply.json"

node - "$WORK/tool-apply.json" "$WORK" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const work = process.argv[3];
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.ok !== true) throw new Error(`apply failed: ${JSON.stringify(report.error ?? report)}`);
const details = report.output?.details;
if (details?.status !== "applied") throw new Error(`unexpected apply status: ${String(details?.status)}`);
if (details?.revision !== 1) throw new Error(`unexpected revision: ${String(details?.revision)}`);
if (details?.cwd !== path.join(work, "node-root", "app")) throw new Error(`unexpected cwd: ${String(details?.cwd)}`);

function scan(root, base = root, entries = new Map()) {
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const absolute = path.join(base, entry.name);
    const relative = path.relative(root, absolute);
    if (entry.isSymbolicLink()) throw new Error(`managed tree contains a symlink: ${relative}`);
    if (entry.isDirectory()) { entries.set(`${relative}/`, "dir"); scan(root, absolute, entries); }
    else {
      const stat = fs.lstatSync(absolute);
      const digest = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
      entries.set(relative, `${stat.size}:${(stat.mode & 0o111) !== 0 ? "x" : "-"}:${digest}`);
    }
  }
  return entries;
}
const source = scan(path.join(work, "gateway", "state", "workspace", "gateway-root", "src"));
const destination = scan(path.join(work, "node-root", "app"));
for (const [name, value] of source) {
  if (name.startsWith("node_modules/") || name.startsWith("target/")) continue;
  if (name === ".env") continue;
  if (destination.get(name) !== value) throw new Error(`node side differs for ${name}`);
}
if (destination.has(".env")) throw new Error("the protected .env file crossed the channel");
if (destination.has("node_modules") || destination.has("target")) throw new Error("a cache directory crossed the channel");
if (!fs.existsSync(path.join(work, "node-root", ".nodews-state", "state.json"))) {
  throw new Error("the node metadata directory was not created outside the workspace");
}
console.log(`managed tree matches the source: revision ${details.revision}, digest ${String(details.digest).slice(0, 12)}…`);
NODE

stage "a routine apply with no source change is a no-op that touches nothing"
NOOP_ARGS="$(node -e 'process.stdout.write(JSON.stringify({node:"integration-node",localPath:process.argv[1],remotePath:process.argv[2],mode:"apply",policy:{preset:"node"},operationId:"b".repeat(32)}))' \
  "$GW_ROOT/src" "$REMOTE_APP")"
tool_call node_workspace_sync "$NOOP_ARGS" "$WORK/tool-noop.json"
cat "$WORK/tool-noop.json"
node - "$WORK/tool-noop.json" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const details = report.output?.details;
if (details?.status !== "noop") throw new Error(`expected a no-op, got ${String(details?.status)}`);
if (details?.revision !== 1) throw new Error("a no-op advanced the revision");
if (details?.transferredBytes !== 0) throw new Error("a no-op transferred bytes");
console.log("no-op wrote nothing and kept revision 1");
NODE

stage "routine update of one source file"
printf 'changed through the boundary\n' > "$GW_ROOT/src/hello.txt"
UPDATE_ARGS="$(node -e 'process.stdout.write(JSON.stringify({node:"integration-node",localPath:process.argv[1],remotePath:process.argv[2],mode:"apply",policy:{preset:"node"},operationId:"c".repeat(32)}))' \
  "$GW_ROOT/src" "$REMOTE_APP")"
tool_call node_workspace_sync "$UPDATE_ARGS" "$WORK/tool-update.json"
cat "$WORK/tool-update.json"
node - "$WORK/tool-update.json" "$WORK" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const details = report.output?.details;
if (details?.status !== "applied" || details?.revision !== 2) {
  throw new Error(`unexpected update result: ${JSON.stringify(details)}`);
}
const file = path.join(process.argv[3], "node-root", "app", "hello.txt");
if (fs.readFileSync(file, "utf8") !== "changed through the boundary\n") throw new Error("updated bytes differ");
console.log("routine update landed in place at revision 2");
NODE

stage "a node edit blocks the next write"
printf 'node-side edit\n' > "$REMOTE_APP/hello.txt"
BLOCK_ARGS="$(node -e 'process.stdout.write(JSON.stringify({node:"integration-node",localPath:process.argv[1],remotePath:process.argv[2],mode:"apply",policy:{preset:"node"},operationId:"d".repeat(32)}))' \
  "$GW_ROOT/src" "$REMOTE_APP")"
tool_call node_workspace_sync "$BLOCK_ARGS" "$WORK/tool-block.json"
cat "$WORK/tool-block.json"
node - "$WORK/tool-block.json" "$WORK" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const details = report.output?.details;
if (details?.ok !== false || details?.code !== "conflict") {
  throw new Error(`expected a coded conflict, got ${JSON.stringify(details)}`);
}
const file = path.join(process.argv[3], "node-root", "app", "hello.txt");
if (fs.readFileSync(file, "utf8") !== "node-side edit\n") throw new Error("a blocked sync overwrote the node edit");
console.log("node edit preserved and the update refused with a coded conflict");
NODE

stage "fetch an artifact through the plugin tool"
ARTIFACT_LOCAL="$GW_ROOT/artifacts/result.txt"
ARTIFACT_ARGS="$(node -e 'process.stdout.write(JSON.stringify({node:process.argv[1],remotePath:process.argv[2],localPath:process.argv[3]}))' \
  "$NODE_ID" "$WORK/node-root/pushed/result.txt" "$ARTIFACT_LOCAL")"
[[ ! -e "$ARTIFACT_LOCAL" ]] || { echo "FAIL: artifact destination existed before the call" >&2; exit 1; }
tool_call node_workspace_artifact "$ARTIFACT_ARGS" "$WORK/tool-artifact.json"
cat "$WORK/tool-artifact.json"
node - "$WORK/tool-artifact.json" "$WORK" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.ok !== true) throw new Error(`artifact tool failed: ${JSON.stringify(report.error ?? report)}`);
const details = report.output?.details;
const local = path.join(process.argv[3], "gateway", "state", "workspace", "gateway-root", "artifacts", "result.txt");
const bytes = fs.readFileSync(local);
const digest = crypto.createHash("sha256").update(bytes).digest("hex");
if (digest !== details.sha256 || bytes.length !== details.bytes) throw new Error("artifact bytes do not match the result");
console.log(`artifact bytes verified: ${details.bytes} bytes`);
NODE

stage "status reports the managed revision and the node drift"
STATUS_ARGS="$(node -e 'process.stdout.write(JSON.stringify({node:process.argv[1],remotePath:process.argv[2],verify:true}))' \
  "$NODE_ID" "$REMOTE_APP")"
tool_call node_workspace_status "$STATUS_ARGS" "$WORK/tool-status.json"
cat "$WORK/tool-status.json"
node - "$WORK/tool-status.json" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const details = report.output?.details;
if (details?.owned !== true) throw new Error("status does not report the managed workspace");
if (details?.readiness !== "ready") throw new Error(`unexpected readiness: ${String(details?.readiness)}`);
if (details?.revision !== 2) throw new Error(`unexpected revision: ${String(details?.revision)}`);
if (details?.verification !== "full") throw new Error("status did not perform a full source scan");
if (details?.dirty?.nodeChanged !== 1) throw new Error(`unexpected drift summary: ${JSON.stringify(details?.dirty)}`);
console.log("status reported revision 2 and exactly one drifted source file");
NODE

echo "PASS: managed sync created, no-opped, updated, refused a node edit, fetched an artifact and verified status across the real Gateway/node boundary"

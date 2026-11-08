#!/usr/bin/env bash
# Disposable two-process integration: isolated Gateway + isolated node host.
# Proves that the plugin loads on both sides, the node advertises its commands,
# a real node invocation answers through the Gateway policy/allowlist, and the
# plugin's own agent tools publish and fetch across the real process boundary:
# tools.invoke -> gateway tool -> openDuplex frames -> node command handler ->
# verified filesystem publication. No in-process mock and no live state is involved.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d /tmp/nodews-int-XXXXXX)"
GATEWAY_PID=""
NODE_PID=""
CHILD_PID=""

# Keep a diagnostic channel that command-local redirections cannot swallow.
exec 9>&2
note() { printf '%s\n' "$*" >&9; }

stage() { printf '[%s] == %s\n' "$(date +%H:%M:%S)" "$*"; }

# A termination signal must stop the in-flight CLI child before the work tree is
# deleted. Deleting a live state directory is exactly what makes OpenClaw log
# "<lock>: no longer current; lock removed/replaced" and leaves a half-cleaned
# run. The handler also ignores a second signal so cleanup cannot be interrupted.
on_signal() {
  local name="$1" code="$2"
  trap '' TERM INT
  note "FAIL: interrupted by SIG$name"
  if [[ -n "$CHILD_PID" ]]; then
    kill -TERM "$CHILD_PID" 2>/dev/null || true
    for _ in $(seq 1 100); do
      kill -0 "$CHILD_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
    CHILD_PID=""
  fi
  exit "$code"
}
trap 'on_signal TERM 143' TERM
trap 'on_signal INT 130' INT

# Never reuse a port that is already listening, and never reuse a fixed one by
# default: an unrelated Gateway on the same port must be impossible to touch.
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
    server.listen(0, "127.0.0.1", () => {
      console.log(server.address().port);
      server.close();
    });
  ')"
fi
if port_in_use "$PORT"; then
  echo "FAIL: port $PORT is already in use; refusing to start or signal anything" >&2
  exit 1
fi

# Only the process groups this script started are signalled. There is no broad
# pattern match: an unrelated `gateway --port` or `node run` must survive.
stop_group() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 100); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
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
  if [[ "$status" -ne 0 ]]; then
    note "FAILED (exit $status): gateway and node logs follow (set NODEWS_KEEP_WORK=1 to keep $WORK)"
    [[ -f "$WORK/gateway.log" ]] && { tail -80 "$WORK/gateway.log" >&9 || true; }
    [[ -f "$WORK/node.log" ]] && { tail -40 "$WORK/node.log" >&9 || true; }
    [[ "${NODEWS_KEEP_WORK:-0}" == "1" ]] && return
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
GW_WORKSPACE="$WORK/gateway/state/workspace"
GW_ROOT="$GW_WORKSPACE/gateway-root"
mkdir -p "$WORK/node-root/pushed" "$GW_ROOT/src" "$GW_ROOT/artifacts"
printf 'hello from the gateway workspace\n' > "$GW_ROOT/src/hello.txt"
printf 'artifact from the node\n' > "$WORK/node-root/pushed/result.txt"

# A small but non-trivial tree: nested directories, an empty directory, an
# empty file, binary bytes including NUL, and an executable bit. Every property
# is checked on the node side after the cross-process push.
mkdir -p "$GW_ROOT/src/nested/deep" "$GW_ROOT/src/empty-dir"
printf 'nested file\n' > "$GW_ROOT/src/nested/deep/notes.md"
printf 'a file that stays in place\n' > "$GW_ROOT/src/remove-me.txt"
printf '#!/bin/sh\necho run\n' > "$GW_ROOT/src/run.sh"
chmod 0755 "$GW_ROOT/src/run.sh"
: > "$GW_ROOT/src/empty.txt"
node -e 'const fs=require("node:fs");const b=Buffer.alloc(4096);for(let i=0;i<b.length;i+=1)b[i]=(i*37+11)&255;fs.writeFileSync(process.argv[1],b)' \
  "$GW_ROOT/src/blob.bin"

# The child environment is built by an executable helper so the daemons can be
# started with `setsid` and still be killed as one owned process group.
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
# Run every child as a tracked background job so a signal handler can stop and
# reap it before cleanup removes its state directory. Subshells (pipes) would
# hide the PID, so no caller pipes this function directly.
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

# One real Gateway RPC call into a registered plugin tool. The plugin tool is
# resolved by the Gateway's own tool policy, and its source must be "plugin".
tool_call() { # tool name, JSON args object, output file
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
    nodes: { commands: { allow: ["nodews.push", "nodews.fetch", "nodews.status", "nodews.tree", "nodews.return"] } },
  },
  plugins: {
    entries: {
      "node-workspace": {
        config: {
          gateway: {
            localRoots: [path.join(work, "gateway", "state", "workspace", "gateway-root", "src")],
            artifactRoots: [path.join(work, "gateway", "state", "workspace", "gateway-root", "artifacts")],
            returnRoots: [path.join(work, "gateway", "state", "workspace", "gateway-root", "src")],
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
            returnRoots: [path.join(work, "node-root")],
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
  if port_in_use "$PORT"; then
    READY=1
    break
  fi
  sleep 1
done
[[ "$READY" == 1 ]] || { echo "FAIL: gateway did not listen on $PORT" >&2; tail -40 "$WORK/gateway.log" >&2; exit 1; }
echo "gateway listening on $PORT"

stage "start node host"
setsid "$WORK/isolated" node openclaw node run --host 127.0.0.1 --port "$PORT" --no-tls --display-name "integration-node" \
  --commands nodews.push,nodews.fetch,nodews.status,nodews.tree,nodews.return >"$WORK/node.log" 2>&1 &
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
for (const command of ["nodews.push", "nodews.fetch", "nodews.status", "nodews.tree", "nodews.return"]) {
  if (!node.commands.includes(command)) throw new Error(`node did not advertise ${command}`);
}
console.log(`node advertised ${node.commands.join(", ")}`);
NODE

stage "describe node"
isolated gateway openclaw nodes describe --node "$NODE_ID" >"$WORK/describe.txt" 2>&1 || true
cat "$WORK/describe.txt"

stage "invoke nodews.status through the real Gateway and node"
isolated gateway openclaw nodes invoke --node "$NODE_ID" --command nodews.status \
  --params "{\"remotePath\":\"$WORK/node-root/pushed\"}" >"$WORK/invoke.txt" 2>&1
cat "$WORK/invoke.txt"

node - "$WORK/invoke.txt" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.payload?.exists !== true) throw new Error("status did not report the existing directory");
if (report.payload?.owned !== false) throw new Error("unexpected ownership on a plain directory");
console.log("status payload verified");
NODE
echo "PASS: isolated Gateway + node host answered nodews.status"

REMOTE_APP="$WORK/node-root/app"
PUSH1_ARGS="$(node -e 'process.stdout.write(JSON.stringify({node:"integration-node",localPath:process.argv[1],remotePath:process.argv[2]}))' \
  "$GW_ROOT/src" "$REMOTE_APP")"

stage "publish through the plugin tool: tools.invoke -> openDuplex -> nodews.push"
tool_call node_workspace_push "$PUSH1_ARGS" "$WORK/tool-push1.json"
cat "$WORK/tool-push1.json"

node - "$WORK/tool-push1.json" "$WORK" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const work = process.argv[3];
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.ok !== true) throw new Error(`push tool failed: ${JSON.stringify(report.error ?? report)}`);
if (report.source !== "plugin") throw new Error(`push was not served by the plugin: ${String(report.source)}`);
const details = report.output?.details;
if (details?.status !== "published") throw new Error(`unexpected push status: ${String(details?.status)}`);
if (typeof details?.nodeId !== "string" || details.nodeId.length === 0) throw new Error("push did not return a node id");
if (details?.cwd !== path.join(work, "node-root", "app")) throw new Error(`unexpected cwd: ${String(details?.cwd)}`);
if (details?.files !== 6) throw new Error(`expected 6 files, got ${String(details?.files)}`);

function scan(root, base = root, entries = new Map()) {
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const absolute = path.join(base, entry.name);
    const relative = path.relative(root, absolute);
    if (relative === ".openclaw-node-workspace.json" || relative === ".nodews-return-state.json") continue;
    if (entry.name.startsWith(".nodews-return-")) continue;
    if (entry.isSymbolicLink()) throw new Error(`published tree contains a symlink: ${relative}`);
    if (entry.isDirectory()) {
      entries.set(`${relative}/`, "dir");
      scan(root, absolute, entries);
    } else {
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
  if (destination.get(name) !== value) throw new Error(`node side differs for ${name}: ${String(destination.get(name))} != ${value}`);
}
if (destination.size !== source.size) throw new Error(`node side has ${destination.size} entries, source has ${source.size}`);

const marker = JSON.parse(fs.readFileSync(path.join(work, "node-root", "app", ".openclaw-node-workspace.json"), "utf8"));
if (marker.plugin !== "node-workspace" || marker.protocol !== 1) throw new Error("marker is not the plugin marker");
if (marker.digest !== details.digest) throw new Error("marker digest does not match the tool result");
if (marker.pushId !== details.pushId) throw new Error("marker push id does not match the tool result");
if (marker.files !== details.files || marker.bytes !== details.bytes) throw new Error("marker counts do not match the tool result");
console.log(`published tree matches the source: ${details.files} files, digest ${details.digest.slice(0, 12)}…`);
NODE

stage "refuse to mutate an existing destination through the plugin tool"
printf 'added after publication\n' > "$GW_ROOT/src/second.txt"
PUSH_AGAIN_ARGS="$(node -e 'process.stdout.write(JSON.stringify({node:"integration-node",localPath:process.argv[1],remotePath:process.argv[2]}))' \
  "$GW_ROOT/src" "$REMOTE_APP")"
tool_call node_workspace_push "$PUSH_AGAIN_ARGS" "$WORK/tool-push-again.json"
cat "$WORK/tool-push-again.json"

node - "$WORK/tool-push-again.json" "$WORK" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const work = process.argv[3];
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.ok !== true) throw new Error(`tools.invoke failed instead of returning a structured result: ${JSON.stringify(report.error ?? report)}`);
if (report.source !== "plugin") throw new Error("refused push was not served by the plugin");
const details = report.output?.details;
if (details?.ok !== false) throw new Error("a push with different content into an existing destination unexpectedly succeeded");
if (details?.code !== "destination-exists") throw new Error(`unexpected coded refusal: ${String(details?.code)}`);
if (details?.unknownOutcome !== false) throw new Error("a known refusal was reported as an unknown outcome");
const text = report.output?.content?.map((part) => part.text).join("\n") ?? "";
if (!text.includes("destination-exists")) throw new Error("the model-visible text hides the code");
const app = path.join(work, "node-root", "app");
if (fs.readFileSync(path.join(app, "hello.txt"), "utf8") !== "hello from the gateway workspace\n") {
  throw new Error("the existing published file was modified by a refused push");
}
if (fs.existsSync(path.join(app, "second.txt"))) throw new Error("a refused push published its new file");
console.log("coded refusal reached the tool result and the destination stayed untouched");
NODE

stage "fetch an artifact through the plugin tool: tools.invoke -> openDuplex -> nodews.fetch"
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
const work = process.argv[3];
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.ok !== true) throw new Error(`artifact tool failed: ${JSON.stringify(report.error ?? report)}`);
if (report.source !== "plugin") throw new Error(`artifact fetch was not served by the plugin: ${String(report.source)}`);
const details = report.output?.details;
const local = path.join(work, "gateway", "state", "workspace", "gateway-root", "artifacts", "result.txt");
const bytes = fs.readFileSync(local);
const source = fs.readFileSync(path.join(work, "node-root", "pushed", "result.txt"));
if (!bytes.equals(source)) throw new Error("fetched bytes differ from the node source");
const digest = crypto.createHash("sha256").update(bytes).digest("hex");
if (details.sha256 !== digest) throw new Error("tool sha256 does not match the fetched file");
if (details.bytes !== bytes.length) throw new Error("tool byte count does not match the fetched file");
if (details.localPath !== local) throw new Error("tool reported a different destination");
console.log(`artifact bytes verified: ${details.bytes} bytes, sha256 ${digest.slice(0, 12)}…`);
NODE

stage "refuse to overwrite an existing artifact destination (structured result, file untouched)"
tool_call node_workspace_artifact "$ARTIFACT_ARGS" "$WORK/tool-artifact-again.json"
cat "$WORK/tool-artifact-again.json"

node - "$WORK/tool-artifact-again.json" "$WORK" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.ok !== true) throw new Error(`tools.invoke failed instead of returning a structured result: ${JSON.stringify(report.error ?? report)}`);
const details = report.output?.details;
if (details?.ok !== false) throw new Error("a second fetch to the same destination unexpectedly succeeded");
if (details?.code !== "destination-exists") throw new Error(`unexpected coded refusal: ${String(details?.code)}`);
const artifactDir = path.join(process.argv[3], "gateway", "state", "workspace", "gateway-root", "artifacts");
const names = fs.readdirSync(artifactDir).sort();
if (names.join(",") !== "result.txt") throw new Error(`artifact directory contains leftovers: ${names.join(", ")}`);
if (fs.readFileSync(path.join(artifactDir, "result.txt"), "utf8") !== "artifact from the node\n") {
  throw new Error("the existing artifact was modified");
}
console.log("existing artifact refused with a coded result and left untouched");
NODE

stage "verify the published tree through the plugin status tool"
STATUS_ARGS="$(node -e 'process.stdout.write(JSON.stringify({node:process.argv[1],remotePath:process.argv[2]}))' \
  "$NODE_ID" "$REMOTE_APP")"
tool_call node_workspace_status "$STATUS_ARGS" "$WORK/tool-status.json"
cat "$WORK/tool-status.json"

node - "$WORK/tool-status.json" "$WORK/tool-push1.json" <<'NODE'
const fs = require("node:fs");
const status = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const push = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
if (status.ok !== true) throw new Error(`status tool failed: ${JSON.stringify(status.error ?? status)}`);
if (status.source !== "plugin") throw new Error(`status was not served by the plugin: ${String(status.source)}`);
const details = status.output?.details;
if (details?.exists !== true) throw new Error("status does not report the published directory");
if (details?.owned !== true) throw new Error("status does not report the plugin-owned copy");
if (details?.verified !== true) throw new Error(`status did not verify the published bytes (drift: ${String(details?.drift)})`);
if (details?.drift !== null) throw new Error(`status reports drift: ${String(details?.drift)}`);
if (details?.marker?.digest !== push.output?.details?.digest) throw new Error("status reports a different digest than the published push");
if (details?.marker?.pushId !== push.output?.details?.pushId) throw new Error("status reports a different push id than the published push");
console.log("status verifies the plugin-owned tree with the published digest");
NODE

stage "preview and return a generated project file through the plugin tools"
printf 'generated on the node\n' > "$REMOTE_APP/generated.txt"
CHANGES_ARGS="$(node -e 'process.stdout.write(JSON.stringify({node:process.argv[1],remotePath:process.argv[2],localPath:process.argv[3]}))' \
  "$NODE_ID" "$REMOTE_APP" "$GW_ROOT/src")"
tool_call node_workspace_changes "$CHANGES_ARGS" "$WORK/tool-changes.json"
cat "$WORK/tool-changes.json"

node - "$WORK/tool-changes.json" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.ok !== true) throw new Error(`changes tool failed: ${JSON.stringify(report.error ?? report)}`);
const details = report.output?.details;
if (details?.counts?.additions !== 1) throw new Error(`expected one addition, got ${String(details?.counts?.additions)}`);
if (details?.counts?.conflicts !== 0) throw new Error("preview reported a conflict");
if (typeof details?.planDigest !== "string") throw new Error("preview did not return a planDigest");
if (details?.operations?.some((entry) => entry.path === "generated.txt" && entry.kind === "add") !== true) {
  throw new Error("preview does not list generated.txt as an addition");
}
console.log("preview reports the generated addition without writing");
NODE

RETURN_ARGS="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify({node:process.argv[2],remotePath:process.argv[3],localPath:process.argv[4],planDigest:j.output.details.planDigest}))' \
  "$WORK/tool-changes.json" "$NODE_ID" "$REMOTE_APP" "$GW_ROOT/src")"
tool_call node_workspace_return "$RETURN_ARGS" "$WORK/tool-return.json"
cat "$WORK/tool-return.json"

node - "$WORK/tool-return.json" "$WORK" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.ok !== true) throw new Error(`return tool failed: ${JSON.stringify(report.error ?? report)}`);
const details = report.output?.details;
if (details?.applied?.length !== 1 || details.applied[0]?.path !== "generated.txt") {
  throw new Error(`unexpected applied set: ${JSON.stringify(details?.applied)}`);
}
const local = path.join(process.argv[3], "gateway", "state", "workspace", "gateway-root", "src", "generated.txt");
if (fs.readFileSync(local, "utf8") !== "generated on the node\n") throw new Error("returned bytes differ");
if ((fs.statSync(local).mode & 0o077) !== 0) throw new Error("returned file has group/other permissions");
console.log("generated file returned through the real Gateway/node boundary");
NODE

echo "PASS: plugin tools pushed, refused an unsafe second publish, fetched an artifact, returned a generated file and verified the tree across the real Gateway/node boundary"

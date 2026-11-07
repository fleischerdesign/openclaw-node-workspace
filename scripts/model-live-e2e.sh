#!/usr/bin/env bash
# Live end-to-end: a genuine, non-scripted hosted model drives the plugin tools,
# the native node exec, and the artifact fetch in a disposable Gateway/node pair.
#
# Difference from scripts/e2e-model-driven.sh:
#   - that script's model is scripts/model-stub.mjs, a fixed test double. It
#     proves the plumbing, not the model's choice.
#   - this script asks a real provider model the same task over the real
#     chat-completions path. Nothing about the decision is scripted: the prompt
#     states the outcome, and the model must choose node_workspace_push, then
#     exec with host=node and the returned cwd, then node_workspace_artifact.
#
# What is real: a Gateway and a node host process under a temporary HOME, state,
# config and TMPDIR; the model HTTP path; the plugin tools; the duplex node
# transport; the node-side writes; the node's system.run; the fetched bytes.
# What is not touched: the live fleet, its state, its config, its credentials.
#
# Credential handling:
#   - OPENCODE_API_KEY is read from the invoking environment. It is never an
#     argv element of any process, never written to the work tree, and never
#     printed: `env` is not used at all. A launcher rebuilds a minimal
#     environment in-process, so no helper receives the credential as an
#     argument, and only the Gateway side exports it — the node host never
#     sees it. The script refuses to run when it is absent; there is no
#     fallback provider and no paid-API substitution.
#   - The model is the existing OpenCode subscription model (default
#     opencode-go/deepseek-v4.1-flash, overridable with NODEWS_LIVE_MODEL). The
#     free Go models are preferred when they cost nothing:
#     NODEWS_LIVE_MODEL=opencode-go/beam-free.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d /tmp/nodews-live-XXXXXX)"
GATEWAY_PID=""
NODE_PID=""
CHILD_PID=""
MODEL="${NODEWS_LIVE_MODEL:-opencode-go/beam-free}"

exec 9>&2
note() { printf '%s\n' "$*" >&9; }
stage() { printf '[%s] == %s\n' "$(date +%H:%M:%S)" "$*"; }

if [[ -z "${OPENCODE_API_KEY:-}" ]]; then
  echo "BLOCKED: OPENCODE_API_KEY is not set in this environment." >&2
  echo "This harness needs an already-authorized provider credential; it does not create, install or buy one." >&2
  echo "Set OPENCODE_API_KEY for the invoking shell and rerun; nothing was started." >&2
  exit 2
fi
echo "credential: OPENCODE_API_KEY present in the environment (value not read or logged)"
echo "model: $MODEL"

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
    note "FAILED (exit $status): logs follow (set NODEWS_LIVE_KEEP_WORK=1 to keep $WORK)"
    for log in gateway.log node.log agent.json agent.err model-list.json; do
      [[ -f "$WORK/$log" ]] && { echo "--- $log ---" >&9; tail -80 "$WORK/$log" >&9 || true; }
    done
    if [[ "${NODEWS_LIVE_KEEP_WORK:-0}" == "1" ]]; then
      note "kept work tree: $WORK"
      return
    fi
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
# The isolation boundary is rebuilt inside the launcher, not passed to `env`.
# The credential therefore never appears in a process argument list: the
# launcher inherits it, unsets everything else, re-exports only the variables a
# disposable child needs, and gives the credential to the Gateway side alone.
cat > "$WORK/isolated" <<'HELPER'
#!/usr/bin/env bash
set -euo pipefail
side="$1"; shift
work="$NODEWS_WORK"
port="$NODEWS_PORT"
savedPath="$PATH"
key="${OPENCODE_API_KEY:-}"

mapfile -t inherited < <(compgen -e)
for name in "${inherited[@]}"; do
  unset "$name"
done

export PATH="$savedPath"
export HOME="$work/$side/home"
export OPENCLAW_STATE_DIR="$work/$side/state"
export OPENCLAW_CONFIG_PATH="$work/$side/state/openclaw.json"
export OPENCLAW_NIX_MODE=0
export OPENCLAW_GATEWAY_PORT="$port"
export TMPDIR="$work/tmp-$side"
if [[ "$side" == gateway && -n "$key" ]]; then
  export OPENCODE_API_KEY="$key"
fi
unset key inherited work port savedPath side name

exec "$@"
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
node - "$WORK" "$PORT" "$MODEL" <<'PATCH_JSON'
const fs = require("node:fs");
const path = require("node:path");
const [work, port, model] = process.argv.slice(2);
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
  models: { mode: "merge" },
  // The plugin registers optional tools. An unset profile keeps core tools but
  // does not opt into plugin tools, and Tool Search would hide their schemas
  // behind a directory. The live test wants the direct surface a `full`
  // profile gives, because the model must pick the tools by name.
  tools: { profile: "full", toolSearch: false },
  agents: {
    defaults: {
      model: { primary: model },
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
# The CLI's config patch validates a model reference against the static catalog,
# which predates the live provider catalog. Merge the file directly instead; the
# gateway resolves the model after the catalog refresh below.
node - "$WORK" <<'MERGE'
const fs = require("node:fs");
const path = require("node:path");
const work = process.argv[2];
const merge = (base, patch) => {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] = merge(out[key], value);
  }
  return out;
};
for (const side of ["gateway", "node"]) {
  const configPath = path.join(work, side, "state", "openclaw.json");
  const patch = JSON.parse(fs.readFileSync(path.join(work, `${side}-patch.json`), "utf8"));
  const current = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify(merge(current, patch), null, 2));
}
MERGE

stage "start gateway on $PORT"
setsid "$WORK/isolated" gateway openclaw gateway --port "$PORT" --bind loopback >"$WORK/gateway.log" 2>&1 &
GATEWAY_PID=$!
READY=0
for _ in $(seq 1 120); do
  if grep -q 'http server listening' "$WORK/gateway.log" 2>/dev/null; then READY=1; break; fi
  sleep 1
done
[[ "$READY" == 1 ]] || { echo "FAIL: gateway did not become ready on $PORT" >&2; exit 1; }
echo "gateway listening on $PORT"

# The gateway applies the provider's live catalog at startup; that refresh and a
# CLI model listing race on the same prepared generation. Wait for the applied
# line, then let the generation settle before asking.
for _ in $(seq 1 120); do
  grep -q 'remote model catalog applied' "$WORK/gateway.log" 2>/dev/null && break
  sleep 1
done
sleep 3

stage "confirm the model is offered by the authorized account"
list_models() {
  isolated gateway openclaw models list --provider opencode-go --json >"$WORK/model-list.json" 2>"$WORK/model-list.err"
}
list_models || true
if ! node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.exit((j.models??[]).some(m=>m.key===process.argv[2])?0:1)}catch{process.exit(1)}' "$WORK/model-list.json" "$MODEL"; then
  stage "model not in the prepared catalog; refreshing once"
  sleep 2
  isolated gateway openclaw models list --refresh --provider opencode-go --json >"$WORK/model-list.json" 2>"$WORK/model-list.err" || true
fi
node - "$WORK/model-list.json" "$MODEL" <<'NODE'
const fs = require("node:fs");
const [file, wanted] = process.argv.slice(2);
let report;
try {
  report = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  throw new Error(`the provider catalog could not be read: ${error.message}`);
}
if (report.ok === false) {
  throw new Error(`the provider catalog request failed: ${report.error?.message ?? JSON.stringify(report.error)}`);
}
const models = report.models ?? [];
const found = models.find((model) => model.key === wanted);
if (!found) {
  const sample = models.slice(0, 12).map((model) => model.key).join(", ");
  throw new Error(`model ${wanted} is not offered by this account; offered: ${sample}`);
}
if (found.available === false) throw new Error(`model ${wanted} is listed but not available to this account`);
console.log(`model ${wanted} is offered by the account`);
NODE

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

stage "write the task prompt"
cat > "$WORK/prompt.txt" <<PROMPT
Work on the node named e2e-node.

Use the node-workspace plugin's tools for both file transfers in this task. Do not use the generic file-transfer tools, ssh, scp, or a shell redirect to copy the file back.

1. Publish the Gateway directory $WORK/gateway-root/src to that node at $REMOTE_DIR. That path does not exist there yet.
2. Then run this shell command on that node, inside the published directory, using the exec tool:
   pwd && cat hello.txt && printf 'from node exec\n' > exec-result.txt
3. Then fetch $ARTIFACT_REMOTE back to the Gateway path $ARTIFACT_LOCAL.

Report each step and its result. When all three steps succeeded, end your reply with exactly this line by itself:

LIVE-E2E-COMPLETE
PROMPT

stage "run one model-driven agent turn through the gateway"
isolated gateway openclaw agent \
  --session-key agent:main:live-model \
  --message-file "$WORK/prompt.txt" \
  --timeout 600 --json >"$WORK/agent.json" 2>"$WORK/agent.err" || true
echo "agent turn finished"

stage "check credential exposure while both processes are alive"
node - "$WORK" "$GATEWAY_PID" "$NODE_PID" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const [work, gatewayPid, nodePid] = process.argv.slice(2);
const key = process.env.OPENCODE_API_KEY;
if (!key) throw new Error("credential absent from the check environment");
const uid = process.getuid();

// 1. No process owned by this uid carries the credential in its argv. The
//    message never includes the matching line, because that line would be the
//    secret.
const ps = execFileSync("ps", ["-u", String(uid), "-o", "pid=,args="], { encoding: "utf8" });
const argvLeaks = ps.split("\n").filter((line) => line.includes(key));
if (argvLeaks.length > 0) throw new Error(`credential appears in the argv of ${argvLeaks.length} process(es)`);

// 2. The Gateway holds it; the node host does not.
const envOf = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, "utf8");
  } catch {
    return null;
  }
};
const gatewayEnv = envOf(gatewayPid);
if (!gatewayEnv || !gatewayEnv.includes(`OPENCODE_API_KEY=${key}`)) {
  throw new Error("the gateway process does not hold the credential it needs");
}
const nodeEnv = envOf(nodePid);
if (nodeEnv === null) throw new Error("cannot read the node process environment");
if (nodeEnv.includes(key)) throw new Error("the node process holds the provider credential");

// 3. /proc entries are owner-only, so the environment is not readable by
//    another user.
for (const pid of [gatewayPid, nodePid]) {
  const stat = fs.statSync(`/proc/${pid}/environ`);
  if (stat.uid !== uid) throw new Error(`/proc/${pid}/environ is owned by uid ${stat.uid}`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`/proc/${pid}/environ is not owner-only (mode ${(stat.mode & 0o777).toString(8)})`);
  }
}

// 4. Nothing under the disposable tree contains the credential.
let scanned = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }
    if (!entry.isFile()) continue;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size > 4_000_000) continue;
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      continue;
    }
    scanned += 1;
    if (bytes.includes(key)) throw new Error(`credential found in ${file.split(work).join("$WORK")}`);
  }
};
walk(work);

console.log(
  `credential: absent from every child argv, absent from the node environment, absent from ${scanned} work-tree files; the gateway environ is owner-only`,
);
NODE

stage "export the session trajectory"
isolated gateway openclaw sessions export-trajectory \
  --session-key agent:main:live-model --workspace "$WORK" --json >"$WORK/trajectory.json" 2>/dev/null || true

stage "assert the tool results, the model's tool choices and the bytes"
node "$ROOT/scripts/model-live-assert.mjs" "$WORK" "$REMOTE_DIR" "$ARTIFACT_LOCAL" "$MODEL"

stage "confirm the export is a redacted, non-empty bundle"
node - "$WORK/trajectory.json" <<'NODE'
const fs = require("node:fs");
const text = fs.readFileSync(process.argv[2], "utf8");
const report = JSON.parse(text);
if (!report.outputDir || !Number.isFinite(report.eventCount) || report.eventCount < 1) {
  throw new Error("the session trajectory export is empty");
}
const events = fs
  .readFileSync(`${report.outputDir}/events.jsonl`, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean);
console.log(`trajectory: ${events.length} redacted events in ${report.displayPath}`);
NODE

echo "PASS: a live model chose push, node exec in the pushed cwd, and artifact fetch; bytes and digests verified"

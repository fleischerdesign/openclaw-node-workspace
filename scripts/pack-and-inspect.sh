#!/usr/bin/env bash
# Prove the packaged plugin loads in an isolated, disposable OpenClaw profile.
#
# This never touches the live Gateway state: every path is under a temporary
# directory and OPENCLAW_NIX_MODE is cleared so the disposable config is
# writable. It installs the npm-pack tarball (the shape a real user gets) and
# asks the real loader to inspect the plugin runtime.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d /tmp/nodews-loader-XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

PROFILE="$WORK/profile"
mkdir -p "$PROFILE/state" "$PROFILE/home"
TARBALL="$WORK/plugin.tgz"

cd "$ROOT"
npm pack --pack-destination "$WORK" >/dev/null
TARBALL="$(ls "$WORK"/*.tgz)"

run_isolated() {
  env \
    HOME="$PROFILE/home" \
    OPENCLAW_STATE_DIR="$PROFILE/state" \
    OPENCLAW_CONFIG_PATH="$PROFILE/state/openclaw.json" \
    OPENCLAW_NIX_MODE=0 \
    CLAWDBOT_STATE_DIR="$PROFILE/state" \
    CLAWDBOT_CONFIG_PATH="$PROFILE/state/openclaw.json" \
    OPENCLAW_GATEWAY_PORT=19789 \
    "$@"
}

echo "== install $(basename "$TARBALL")"
run_isolated openclaw plugins install "npm-pack:$TARBALL" --force --accept-capabilities 2>&1 | tee "$WORK/install.log"
grep -q "OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE" "$WORK/install.log" && {
  echo "FAIL: install was refused by Nix mode" >&2
  exit 1
}

echo "== inspect runtime"
run_isolated openclaw plugins inspect node-workspace --runtime --json > "$WORK/inspect.json" 2>"$WORK/inspect.err"
cat "$WORK/inspect.err" >&2
node - "$WORK/inspect.json" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const report = JSON.parse(fs.readFileSync(path, "utf8"));
const plugin = report.plugin;
if (!plugin) throw new Error("inspect output has no plugin record");
if (plugin.id !== "node-workspace") throw new Error(`unexpected plugin id ${plugin.id}`);
if (plugin.status !== "loaded") {
  throw new Error(`plugin status is ${plugin.status}: ${plugin.error ?? "unknown error"}`);
}
const expectedTools = ["node_workspace_push", "node_workspace_artifact", "node_workspace_status"];
for (const tool of expectedTools) {
  if (!plugin.toolNames.includes(tool)) throw new Error(`tool ${tool} is not registered`);
}
if (!Array.isArray(report.diagnostics) || report.diagnostics.length !== 0) {
  throw new Error(`inspect reported diagnostics: ${JSON.stringify(report.diagnostics)}`);
}
console.log(`loaded ${plugin.id} with tools ${plugin.toolNames.join(", ")}`);
NODE

printf '%s\n' "== list"
run_isolated openclaw plugins list --json > "$WORK/list.json" 2>/dev/null
grep -q 'node-workspace' "$WORK/list.json"

echo "PASS: plugin installed and loaded in isolated state $PROFILE"

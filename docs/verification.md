# Verification

Every claim below was produced by a command in this repository. The date is the run recorded on
2026-11-06, OpenClaw `2026.11.1`, Node `24.22.1`, Linux `6.18.57` (x86_64).

## What the layers prove

| Layer | Command | Proves |
| --- | --- | --- |
| Unit and in-process transport | `npm test` | Paths, scanning, digests, framing, config, push/artifact/status against real node handlers over a real ordered channel with real files. |
| Build | `npm run build` + `npm run typecheck` | The published `dist/` exists, typechecks strictly, and every runtime import is declared. |
| Real plugin loader | `bash scripts/pack-and-inspect.sh` | The npm-pack tarball installs into a disposable state, the real loader reports `status: "loaded"`, and the three tools are registered. |
| Two-process transport | `bash scripts/integration-isolated.sh` | A real Gateway and a real node host, with the plugin installed on both, pair; the node advertises `nodews.*`; a real node invocation answers through the Gateway allowlist and policy. |

## Results

`npm test`:

```
ℹ tests 36
ℹ pass 36
ℹ fail 0
```

`bash scripts/pack-and-inspect.sh`:

```
loaded node-workspace with tools node_workspace_push, node_workspace_artifact, node_workspace_status
PASS: plugin installed and loaded in isolated state /tmp/nodews-loader-…
```

`bash scripts/integration-isolated.sh`:

```
gateway listening on 19789
node advertised nodews.fetch, nodews.push, nodews.status
{"ok":true,"nodeId":"…","command":"nodews.status","payload":{"exists":true,"owned":false,"marker":null},…}
PASS: isolated Gateway + node host answered nodews.status
```

## What is not proven

- **A live tool call against a real paired node.** The tool path is covered in-process
  (`test/entry.test.ts` calls the registered tool and publishes through the real node handler), and
  the node command is covered against a real node host. A model-driven tool call was not run because
  it needs an agent turn and a model; the tool wiring is asserted directly instead.
- **A real duplex push through the Gateway process.** The isolated integration invokes the unary
  `nodews.status`; the framed push/fetch path is proven in-process against the same handlers, not
  through a second process. The SDK's duplex transport itself is part of OpenClaw, not this plugin.
- **Windows nodes.** Unsupported by design.
- **Filesystem failure modes** such as ENOSPC, EIO, and an interrupted rename on a real network
  filesystem. The code reports them as I/O or `unknown-outcome`; they were not injected here.
- **Long-running or very large pushes.** Tests use small trees and 1 KiB chunks; limits are unit
  tested, not load tested.

## Reproduce

```bash
npm ci
npm run typecheck
npm test
npm run build
bash scripts/pack-and-inspect.sh
bash scripts/integration-isolated.sh
```

The scripts create their own temporary state and remove it on exit. They refuse to use an inherited
live state because every OpenClaw path is set explicitly for the child process.

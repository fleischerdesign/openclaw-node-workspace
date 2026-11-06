# Verification

Every claim below was produced by a command in this repository. The date is the run recorded on
2026-11-06, OpenClaw `2026.11.1`, Node `24.22.1`, Linux `6.18.57` (x86_64).

## What the layers prove

| Layer | Command | Proves |
| --- | --- | --- |
| Unit and in-process transport | `npm test` | Paths, scanning, digests, framing, config, push/artifact/status against real node handlers over a real ordered channel with real files. |
| Build | `npm run build` + `npm run typecheck` | The published `dist/` exists, typechecks strictly, and every runtime import is declared. |
| Real plugin loader | `bash scripts/pack-and-inspect.sh` | The npm-pack tarball installs into a disposable state, the real loader reports `status: "loaded"`, and the three tools are registered. |
| Two-process tool path | `bash scripts/integration-isolated.sh` | A real Gateway and node host pair; the registered tools are invoked through `tools.invoke`, publish over duplex frames, refuse an occupied destination, fetch an artifact exclusively, and status verifies the published tree. |

## Results

`npm test`:

```
ℹ tests 51
ℹ pass 51
ℹ fail 0
```

`bash scripts/pack-and-inspect.sh`:

```
loaded node-workspace with tools node_workspace_push, node_workspace_artifact, node_workspace_status
PASS: plugin installed and loaded in isolated state /tmp/nodews-loader-…
```

`bash scripts/integration-isolated.sh` (current code, real Gateway + node host, tool path through `tools.invoke`):

```
gateway listening on …
node advertised nodews.fetch, nodews.push, nodews.status
status payload verified
created 6 files ... published tree matches the source
occupied destination left untouched
artifact bytes verified ...
status reports the plugin-owned tree with the published digest
PASS: plugin tools pushed, refused an unsafe second publish, and fetched an artifact across the real Gateway/node boundary
```

## Security-review regressions

The first review found defects that the original suite missed. Each now has a regression test:

| Finding | Test |
| --- | --- |
| Remote mode 0777 applied to the Gateway | `a remote 0777 artifact becomes owner-only on the Gateway`, `a malicious remote mode of 0777 is still reduced to 0700` |
| Marker alone reported `already-applied` after node-side drift | `an unchanged marker with modified node content is drift, not already-applied` |
| Destructive `replace` swap window | `replace` removed; `a changed workspace at an occupied destination is a conflict, never a replace`, `a destination created during transfer is never renamed or deleted` |
| Stale staging blocked a retry | `a stale staging directory never blocks a retry or a first attempt` |
| Published failure lost as a plain error | `a published-but-failed node result is an unknown outcome` |
| Slow-drip deadline | `a stalled artifact transfer stops at the absolute deadline` |
| Skipped files were silent | `skipped symlinks are returned, not silently dropped` |
| Frame listener leak / concurrent waiter | `FrameSession unsubscribes its listener on close`, `FrameSession rejects a concurrent read instead of losing a waiter` |
| Unvalidated tool parameters | tool-parameter assertions in `the registered push tool publishes through the injected runtime...` |
| Root `/` containment prefix | `a root of / matches its children instead of failing on a // prefix` |
| Status verification and `parentExists` | `status reports verified content and drift after modification`, `status reports parentExists only for allowed paths` |

## What is not proven

- **A model-driven tool call.** The registered tools are invoked through the Gateway's real
  `tools.invoke` RPC in the isolated integration, including push, artifact fetch and status. No agent
  turn was run because that needs a model; the tool boundary itself is proven.
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

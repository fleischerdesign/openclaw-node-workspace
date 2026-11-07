# Verification

Every claim below was produced by a command in this repository. The date is the run recorded on
2026-11-07, OpenClaw `2026.11.1`, Node `24.22.1`, Linux `6.18.57` (x86_64).

## What the layers prove

| Layer | Command | Proves |
| --- | --- | --- |
| Unit and in-process transport | `npm test` | Paths, scanning, digests, framing, config, incremental publish, return plan, push/artifact/status/tree/return against real node handlers over a real ordered channel with real files. |
| Build | `npm run build` + `npm run typecheck` | The published `dist/` exists, typechecks strictly, and every runtime import is declared. |
| Real plugin loader | `bash scripts/pack-and-inspect.sh` | The npm-pack tarball installs into a disposable state, the real loader reports `status: "loaded"`, and all five tools are registered. |
| Two-process tool path | `bash scripts/integration-isolated.sh` | A real Gateway and node host pair; the registered tools are invoked through `tools.invoke`, publish over duplex frames, refuse an occupied destination, fetch an artifact exclusively, preview and return a generated file into the local project, and status verifies the published tree. |
| Model-driven turn | `bash scripts/e2e-model-driven.sh` | One agent turn, driven through streaming chat completions, calls `node_workspace_push`, then native `exec` with `host=node` and the returned cwd, then `node_workspace_artifact`; the node stdout shows the pushed cwd and the fetched bytes match on both sides. |

## Results

`npm test`:

```
ℹ tests 99
ℹ pass 99
ℹ fail 0
```

`bash scripts/pack-and-inspect.sh`:

```
loaded node-workspace with tools node_workspace_push, node_workspace_artifact, node_workspace_status, node_workspace_changes, node_workspace_return
PASS: plugin installed and loaded in isolated state /tmp/nodews-loader-…
```

`bash scripts/integration-isolated.sh` (rerun on 2026-11-07 with the incremental and return stages):

```
gateway listening on …
node advertised nodews.fetch, nodews.push, nodews.return, nodews.status, nodews.tree
status payload verified
created 6 files ... published tree matches the source
coded refusal reached the tool result and the destination stayed untouched
artifact bytes verified ...
existing artifact refused with a coded result and left untouched
status verifies the plugin-owned tree with the published digest
preview reports the generated addition without writing
generated file returned through the real Gateway/node boundary
PASS: plugin tools pushed, refused an unsafe second publish, fetched an artifact, returned a generated file and verified the tree across the real Gateway/node boundary
```

`bash scripts/e2e-model-driven.sh` (2026-11-07):

```
plugin tools registered on the gateway
agent turn finished
{
  "modelCalls": 4,
  "toolOrder": ["node_workspace_push", "exec", "node_workspace_artifact"],
  "execWorkdir": "/tmp/nodews-e2e-…/node-root/agent-workspace",
  "artifactDigest": "92fdebe7aeebf0385aa40ec91a17d070a363b92bb621630089da50e1d21affac",
  "agentCalls": 3,
  "agentFailures": 0
}
agent session is present in the Gateway session store
PASS: a model turn published, executed in the pushed node cwd, fetched the artifact, and the session recorded it
```

The same session was opened in the Control UI and rendered three tool steps
(`node_workspace_push`, `exec`, `node_workspace_artifact`) followed by the final assistant text; the
screenshot is kept outside the repository as run evidence.

The script asserts the wire trace, not the transcript alone: the tool order in the model requests,
the `exec` arguments (`host: "node"`, `workdir` equal to the push result's cwd), the node stdout
containing that cwd, the fetched bytes and their digest, the agent's tool summary (3 calls, 0
failures), and the session's presence in `sessions.list`.

## Security-review regressions

The first review found defects that the original suite missed. Each now has a regression test:

| Finding | Test |
| --- | --- |
| Remote mode 0777 applied to the Gateway | `a remote 0777 artifact becomes owner-only on the Gateway`, `a malicious remote mode of 0777 is still reduced to 0700` |
| Marker alone reported `already-applied` after node-side drift | `an unchanged marker with modified node content is drift, not already-applied` |
| `rename(2)` silently replaced a concurrently created empty directory | `claimDestination refuses an existing empty directory and a file`, `an empty destination created before the push is never replaced` |
| Destructive `replace` swap window | `replace` removed; `a changed workspace at an occupied destination is a conflict, never a replace`, `an empty destination created before the push is never replaced` |
| Stale staging blocked a retry | `a stale staging directory never blocks a retry or a first attempt` |
| Published failure lost as a plain error | `a published-but-failed node result is an unknown outcome` |
| Slow-drip deadline | `a stalled artifact transfer stops at the absolute deadline` |
| Skipped files were silent | `skipped symlinks are returned, not silently dropped` |
| Frame listener leak / concurrent waiter | `FrameSession unsubscribes its listener on close`, `FrameSession rejects a concurrent read instead of losing a waiter` |
| Unvalidated tool parameters | tool-parameter assertions in `the registered push tool publishes through the injected runtime...` |
| Root `/` containment prefix | `a root of / matches its children instead of failing on a // prefix` |
| `tools.invoke` flattened coded errors to `internal_error` | `toolFailure preserves unknown-outcome as an actionable tool result`, integration coded refusal assertions |
| Status verification had no deadline | `tree verification stops at its deadline` |
| Legacy markers were ignored | `a legacy marker without state or manifest is verifiable against the incoming manifest` |
| Root config was not normalized/deduplicated | config normalization assertion in `plugin config applies safe defaults...` |
| Post-marker fsync failure was reported as `partial` while status said complete | `a parent fsync failure after the complete marker is an unknown outcome` |
| A same-user parent symlink swap wrote outside the destination | `a subdirectory swapped to a symlink before a file write is rejected` (outside directory stays empty; residual race documented) |
| Marker could exceed its reader limit | `an oversized marker manifest is rejected before publication` |
| Failure schema did not match returned keys | TypeBox `Value.Check` on structured push failures in `test/entry.test.ts` |
| Coded failures lacked operation context | `toolFailure preserves unknown-outcome as an actionable tool result` plus context fields in the failure schema |
| Status verification and `parentExists` | `status reports verified content and drift after modification`, `status reports parentExists only for allowed paths` |

## Review regressions

The independent review of the incremental/return change produced these regression tests:

| Finding | Test |
| --- | --- |
| A compromised node could return a traversal path | `a node tree path with a traversal segment is rejected on the Gateway` |
| A node could return a digest that does not describe its manifest | `a node tree digest that does not match its manifest is rejected` |
| A node tree file could omit its parent directory | `a node tree file without its declared parent directory is rejected` |
| A second return of the same generated path became a permanent conflict | `a second return of the same generated path remains applicable` |
| A local directory at an added file path failed late | `a local directory at an added path is a conflict, not a late overwrite` |
| Empty generated directories were dropped | `an empty node directory is created on return` |
| Exclude patterns could not rescue the node scan | `exclude patterns rescue a node scan before its limits apply` |
| A local mode change was silently undone | `a local mode change is a conflict instead of being silently undone` |
| A malformed node marker reached the planner | `a malformed marker manifest is ignored instead of reaching the planner`, `a marker with a non-array manifest is ignored` |
| Two nodes on the same absolute path shared a return base | `two nodes with the same remotePath keep separate return baselines` |
| A plan above the 200-operation report cap could still execute | `a plan above the report cap is refused before any write` |
| An unverified marker authorized a replacement | `an unverified marker is not used as a conflict base` |
| A foreign state file was silently replaced | `a foreign file named like the state file is left untouched` |
| A mode-only return reset unrelated permission bits | `a mode-only change preserves group and other bits` |

## What is not proven

- **Same-UID atomicity.** The local return re-checks parents, digests, and destinations immediately
  before each write and rolls back on failure, but Node lacks an openat/renameat2-with-expected-inode
  primitive. A deliberate same-user process racing the apply window is not contained; see Security.
- **A process kill during the local apply window.** The return stream is staged first, so a
  disconnect is safe; a SIGKILL between two local renames can still leave a partial project and a
  stale `.nodews-return-*` directory. Recovery is a fresh preview, not automatic cleanup.
- **Large trees.** The suites use small trees and 1 KiB chunks; the 2000-entry/256 MiB limits are
  unit tested, not load tested. A local project above the limits fails closed until `exclude`
  narrows it.
- **Rollback under injected I/O failure.** Rollback is exercised by construction and unit paths, but
  a real mid-apply ENOSPC/EIO injection is not part of the gate.

- **A hosted model's tool choice.** The model in `e2e-model-driven.sh` is a scripted
  OpenAI-compatible test double: the HTTP path, the agent loop, tool dispatch, and every side effect
  are real, but the choice to call these tools in this order is fixed by the script. Whether a
  particular hosted model selects them correctly from the same prompt is not measured here.
- **The Control UI assertion is manual.** The rendered session was inspected once in Chromium; the
  script does not automate the browser.
- **Windows nodes.** Unsupported by design.
- **Filesystem failure modes** such as ENOSPC, EIO, and an interrupted publication on a real network
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
bash scripts/e2e-model-driven.sh
```

The scripts create their own temporary state and remove it on exit. They refuse to use an inherited
live state because every OpenClaw path is set explicitly for the child process.
`e2e-model-driven.sh` needs no model credentials: it starts its own scripted endpoint on loopback,
on a free port, and stops it with the rest of the disposable processes. It takes about four minutes
because it installs the packed plugin into two fresh states and starts a Gateway twice over.
Set `NODEWS_E2E_SERVE=1` to keep the pair running and print the UI URL and the stop marker path.

# Verification

## Layers

| Layer | What it decides |
| --- | --- |
| `test/policy.test.ts` | Cache/protected/selection matching |
| `test/managed-plan.test.ts` | Pure three-way diff, conflicts, releases, restore, adoption |
| `test/manifest.test.ts` | Local source scan, digests, limits, symlink/special refusal |
| `test/managed.test.ts` | Real node handlers over the in-process framed channel, real files on disk |
| `test/artifact.test.ts` | Real fetch handler, digest and exclusive publication |
| `scripts/pack-and-inspect.sh` | Real loader and registered tool/command surface |
| `scripts/integration-isolated.sh` | Two real processes, disposable state and port |
| `scripts/e2e-model-driven.sh` | Scripted model drives a real agent turn through sync/exec/artifact |

Tests use the real node handlers through `test/helpers/sim.ts`. The only replacement is the network
hop. No test mocks a handler to claim a behaviour the handler does not implement.

## Covered cases

- Missing base, add, change, delete, mode change, unchanged files.
- Node drift, node-absent restore (authorized and refused), untracked collisions even with equal
  bytes, file/directory type collisions, unmanaged parent files.
- Released paths by selection narrowing; re-adoption only with `adoptPaths`; no deletion on release.
- Creation, adoption, policy transition requiring a pinned preview; no-op writes nothing and keeps
  the revision; inode and mtime unchanged.
- Cache and protected-path invariants: excluded before traversal, absent from the node tree, existing
  cache inode/mtime untouched.
- Revision CAS, stale `planDigest`, operation replay after revision advance, operation mismatch,
  receipt quota/expiry semantics (unit-level where the clock is controllable).
- Ownership mismatch, forged in-tree marker, path traversal in a hello manifest, live versus provably
  dead lock, fencing.
- Crash injection at prepared journal, mid-apply, committed journal and post-record; rollback,
  roll-forward, external-drift `recovery-blocked`, staging `ENOSPC`, transport loss before and after
  `end`.
- Status `full` versus `metadata-only`, bounded inventory, source-only drift counts.

## Deliberate limits

- No whole-tree atomicity claim; a concurrent native reader can see the documented missing-name
  window during a backup-first replacement.
- Per-file before/after stat detects many races but is not a global snapshot.
- `indexed` verification is not implemented; status reports `full` or `metadata-only`.
- General managed return/merge is not part of this release. `node_workspace_artifact` remains the only
  Gateway-directed retrieval path.

## Running

```bash
npm run typecheck
npm test
npm run build
bash scripts/pack-and-inspect.sh
bash scripts/integration-isolated.sh
bash scripts/e2e-model-driven.sh
```

The integration scripts set `HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH` and `TMPDIR` under a
temporary directory and pick a free port. They never touch live state.

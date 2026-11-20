# Verification

## Layers

| Layer | What it decides |
| --- | --- |
| `test/policy.test.ts` | Cache/protected/selection matching |
| `test/managed-plan.test.ts` | Pure three-way diff, conflicts, releases, restore, adoption |
| `test/manifest.test.ts` | Local source scan, digests, limits, symlink/special refusal |
| `test/managed.test.ts` | Real node handlers over the in-process framed channel, real files on disk |
| `test/receipts.test.ts` | Seven-day boundary, committed-only quota and ledger bound without wall-clock waits |
| `test/transport-errors.test.ts` | Structured node error decoding, status owner/budget, abort propagation |
| `scripts/bench-managed.mjs` | Reproducible managed-sync benchmark and TypeScript incremental-build smoke |
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
- Receipt liveness strictly before the seven-day boundary, refusal at it, expired pruning and the
  64-entry quota, driven by an explicit test clock (`NODE_WORKSPACE_TEST_NOW`).
- Mid-apply `ENOSPC`: the first file is already replaced when the injection fires; every touched file
  is rolled back, the revision is unchanged, readiness returns to `ready`, and the retry applies.
- Durability order: staged payload `sync()` precedes `close()`; staged bytes are re-verified before
  mutation; `end` marks a possible commit before the send attempt, so a delivered-then-error send is
  `unknown-outcome`.
- Converged node/local bytes become an `adopt` base; subsequent edits and deletions work; the
  committed directory manifest drops a directory whose last file was deleted.
- Ownership is Gateway-asserted: missing owner, foreign owner, a mismatched invocation session and
  forged cache/protected paths are refused. The node has no SDK agent-id field; the trust boundary is
  documented rather than faked.
- Dead locks fail closed; explicit maintenance refuses a replaced live lock. Reserved
  `.nodews-state` path ancestry and `create=false` on a new path are refused.
- Crash seams before/after the applying journal, during apply, before the registry record, after the
  record and after cleanup; rebind-after-commit recovery from the full journal binding with a deleted
  registry.
- Receipt replay returns the original plan digest and counts; payload-only progress byte totals.

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
npm run bench:managed
```

The integration scripts set `HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH` and `TMPDIR` under a
temporary directory and pick a free port. They never touch live state.

# Architecture

The plugin keeps one **durable managed source workspace** per project on a paired node. The node
path never changes across syncs, build caches stay in place, and the plugin owns only the source
files it has committed in its registry.

## Surfaces

| Surface | Kind | Purpose |
| --- | --- | --- |
| `node_workspace_sync` | agent tool | Preview or apply one managed source update |
| `node_workspace_status` | agent tool | Readiness, revision, policy, drift summary, owned inventory |
| `node_workspace_artifact` | agent tool | Fetch one selected file back, exclusively |
| `nodews.sync` | node command (duplex) | Plan, stage, transaction, commit |
| `nodews.status` | node command | Read-only registry and source scan |
| `nodews.fetch` | node command (duplex) | Artifact streaming |

There is no arbitrary command parameter, no archive format, and no general bidirectional merge in
this release.

## Gateway side

1. Resolve the node id and the **host session workspace**. The workspace is the authority; configured
   `gateway.localRoots` and `gateway.artifactRoots` can only narrow it. There is no working-directory
   fallback.
2. Resolve the effective policy and scan the selected local source. Cache and dependency subtrees are
   skipped before `lstat`; protected paths are counted and never hashed or sent.
3. Open one duplex channel and send a hello with the selected manifest, policy, owner identity,
   operation id, revision CAS and optional plan digest.
4. For an apply, the node returns a canonical plan; the Gateway streams only the requested payloads,
   verifying each against the digest from its own scan.

## Node side

Each configured managed root owns a state directory beside the workspace:

```
<root>/.nodews-state/
  state.json                    per-volume identity pin (device + inode)
  workspaces/<key>.json         registry record for one remote path
  locks/<key>.lock              single mutation lock with process identity
  tx/<key>/journal.json         write-ahead transaction journal
  tx/<key>/stage/               fsynced staged payloads
  tx/<key>/backup/              renamed pre-transaction files
```

The registry, not a file inside the workspace, is the ownership record. A marker-shaped file in the
tree is ordinary untracked data and grants nothing.

### Plan

The node independently scans its source tree and builds the diff from three inputs: the committed
base manifest (registry), the selected local manifest (hello), and the current node scan. It also
validates every incoming path and limit independently of the Gateway.

Rules:

- Only previously managed, still-selected base files missing locally are deletion candidates.
- A node file that differs from the base blocks the update (`node-modified`).
- Node and local bytes that converged independently of the base become a verified `adopt` entry
  (no transfer), so the next edit or deletion works.
- The committed directory manifest is the selected local shape, not a union of every directory that
  ever existed.
- A node-absent base file is `node-missing` unless the pinned preview listed it in `restore`.
- A local addition colliding with an untracked node file blocks, even with equal bytes.
- A file/directory type change cannot remove unmanaged descendants.
- Selection narrowing releases management; it never deletes the node copy.
- Re-including a released path needs an explicit `adoptPaths` entry in a pinned apply.
- Adopting an unmanaged directory records equal existing bytes as an `adopt` entry (no transfer) and
  leaves node-only files untracked.
- Policy, creation, adoption, deletion, restore, rebind and release transitions require a pinned
  preview (`planDigest`).

### Transaction

`staging -> applying -> committed`, with the journal durable before the first source mutation and a
committed journal durable before the registry advertises the new revision.

- Staged payloads are fsynced and re-hashed on the node.
- Each changed file is verified against its `before` digest, renamed to the backup area, then the
  staged file is renamed into place. Deletions are backup-first moves.
- Destination bytes are verified, touched directories are fsynced, then the committed journal is
  written. The registry record and operation receipt follow; cleanup happens last.
- A crash is repaired by the next operation: a prepared journal is discarded, an applying journal is
  rolled back from backups, a committed journal is rolled forward into the registry.
- External drift during recovery stops with `recovery-blocked` and preserves the backups.

This is not whole-tree atomicity. A reader outside the lock can observe the documented missing-name
window during a backup-first replacement, and native `exec` does not participate in the lock.

### Locks

One lock per workspace. A live owner always blocks, regardless of age. An unreadable lock blocks. A
lock whose recorded process is provably dead also blocks: POSIX offers no compare-and-delete, so
automatic reclamation could remove a live replacement created between the read and the unlink. The error names the inspected pid/token; release is `node scripts/lock-maintenance.mjs` on a stopped node,
with the exact token/pid or exact sha256 and `--quiescent --yes`, and refuses a live or replaced lock.
Lock bodies are published with a fsynced temp file plus `link(2)` so a crash cannot leave a partial
lock at the final name. Each mutation phase
re-checks the lock token (fencing), so a late handler cannot write after its lock was replaced.

## Idempotency

An apply carries a stable 32-hex `operationId`. The registry stores a request fingerprint and outcome
under that id. A committed receipt is returned again after later revisions advance. A different
request under the same id is `operation-mismatch`. An interrupted receipt allows resuming the same
intent; it is never treated as success. Receipts expire after seven days and are bounded by a committed-entry quota (4096) and a 2 MiB live
ledger; a full quota refuses a mutation rather than evicting live receipts, while preview and no-op
still work. Interrupted or rolled-back attempts do not consume the committed quota.

## Status

Status is read-only. With `verify: true` it hashes the node's selected source and reports
`verification: "full"` plus bounded drift counts. With `verify: false` it reports registry metadata
only and says `metadata-only`; it never claims a content scan it did not perform. A present journal is
reported as `committed`, `interrupted`, or `recovery-blocked` and overrides a stale ready marker.

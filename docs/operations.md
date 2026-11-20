# Operations

## Install

```bash
npm ci
npm run build
npm pack
openclaw plugins install npm-pack:./fleischerdesign-openclaw-node-workspace-0.1.0.tgz --force
```

Install the same package on the Gateway and on every participating node. There is no separate
credential or SSH surface: the plugin uses the existing authenticated node channel.

## Configuration

Gateway:

```json
{
  "gateway": {
    "localRoots": ["/srv/workspace/projects"],
    "artifactRoots": ["/srv/workspace/artifacts"],
    "exclude": [],
    "maxFiles": 2000,
    "maxFileBytes": 33554432,
    "maxTotalBytes": 268435456,
    "chunkBytes": 65536,
    "timeoutMs": 120000
  }
}
```

Node:

```json
{
  "node": {
    "pushRoots": ["/srv/node-workspace"],
    "artifactRoots": ["/srv/node-workspace"],
    "maxFiles": 2000,
    "maxFileBytes": 33554432,
    "maxTotalBytes": 268435456
  }
}
```

`localRoots` and `artifactRoots` can only narrow the session workspace the host resolves. A managed
destination must be a child of a `pushRoots` entry, on the same device, with an existing real parent.

## First sync

1. `node_workspace_sync` with `mode: "preview"`, `create: true`, `localPath`, `remotePath`, and a
   `policy`. Read the plan: entry counts, conflicts, protected count, and `planDigest`.
2. `node_workspace_sync` with `mode: "apply"`, the same inputs, `planDigest`, and a stable 32-hex
   `operationId`.
3. Run the build through `exec` with `host=node` and `workdir` equal to the returned `cwd`.
4. Edit locally and sync again. Unchanged files are not rewritten; caches are untouched.

Use one persistent slot per concurrent job. Do not create `-vN` copies and do not delete the
workspace to force a refresh; the path is the cache.

## Routine versus pinned updates

- A routine apply (add/change/mode/adopt only, no conflicts) may omit `planDigest`.
- `create` must be true (or `adopt` true) for an apply to a path with no registry record.
- Converged node bytes are recorded as an `adopt` entry; no payload is transferred.
- Deletion, creation, adoption, restore, rebind, release re-inclusion and policy transitions need a
  fresh preview and its `planDigest`.
- `expectedRevision` is an optional CAS. A mismatch is `revision-mismatch`; preview again.
- Receipts are bounded at 4096 unexpired committed entries and 2 MiB per workspace. A full quota
  refuses a mutation; preview and a no-op still work. Interrupted/rolled-back attempts do not count
  against the committed quota.
- A no-op apply writes nothing and does not advance the revision.

## Status and recovery

`node_workspace_status` with `remotePath` reports readiness, revision, policy, protected/untracked
counts and, with `verify: true` (default), a full source drift summary. Without `remotePath`, it lists
the bounded owned inventory. With `operationId`, it returns the durable receipt.

After an `unknown-outcome`:

1. Query status with the same `operationId`.
2. A committed receipt is the historic result; do not apply it again.
3. An interrupted operation may be resumed with the same intent and id.
4. `recovery-blocked` means the node holds bytes matching neither the base nor the target. Inspect the
   affected paths and preserve the backup area; do not delete state blindly.

Recovery is automatic on the next operation: prepared journals are discarded, applying journals are
rolled back, committed journals are rolled forward. Native `exec` processes are not fenced; stop them
before syncing if they may write source files.

## Dead lock maintenance

Automatic dead-lock reclamation is disabled because POSIX has no compare-and-delete primitive; a
read-then-rename can delete a newly created live lock. When status or an error names a dead pid and
token, stop the node host, then run `node scripts/lock-maintenance.mjs` with `--quiescent --yes` and that
exact `--token`/`--pid` (dead readable lock) or that exact `--sha256` (unreadable lock). It refuses a
live process, a changed/replaced lock and missing confirmation. Never delete a lock file by path from
a running system.

## Retention and space

- Registry, journal and receipts live under `<root>/.nodews-state`. Never delete that directory to
  "clean up"; it is the ownership record.
- Stage and backup data exist only during a transaction. A committed journal is cleaned on the next
  operation if cleanup was interrupted.
- Receipts expire after seven days. The committed ledger is capped at 4096 entries and 2 MiB; a full cap refuses
  a mutation instead of evicting live receipts. Interrupted history is bounded by the same byte cap
  and pruned oldest-first on every write, keeping the operation named by the active journal.
- Only the plugin's own unreferenced transaction data is auto-cleaned. Caches and workspaces are not
  deleted by age, marker or glob.

## Upgrade

The managed protocol is version 5. Managed and old generation tools do not share a path or a marker
format; install the same package on both sides before creating a managed workspace. There is no
migration of an old immutable generation in this release: adopt the source as a new managed workspace
with a preview, or create the managed workspace from the local tree and leave the old directory in
place.

## Troubleshooting

| Symptom | Meaning / action |
| --- | --- |
| `preview-required` | The update is destructive or structural; preview it and pass `planDigest`. |
| `conflict` with `node-modified` | The node copy changed. Retrieve or discard it explicitly; the plugin will not overwrite it. |
| `conflict` with `untracked` | A node-only file occupies a selected path. Move, adopt or rename it. |
| `workspace-locked` | Another operation owns the workspace lock, the lock is unreadable, or a dead owner left it. Automatic reclamation is disabled. |
| `identity-unresolved` | The Gateway supplied no agent identity for a managed call. The node cannot attest an agent id; this is a Gateway-assertion requirement. |
| `create-not-authorized` | The path is unmanaged and the apply did not set `create` or `adopt`. |
| `policy-violation` | A forged manifest tried to send a cache, protected or unselected path. |
| `symlink-rejected` | Source contains a symlink outside an excluded cache. Move the link into an excluded dependency directory or remove it. |
| `workspace-forbidden` | The authenticated agent or local project does not match the registry binding. |
| `recovery-blocked` | A previous transaction is mixed. Inspect the affected paths and the backup area. |
| `receipt-quota-exceeded` | The committed receipt ledger is at its entry or byte bound; wait for expiry. A preview or no-op still succeeds. |

# Persistent managed source workspaces — design exploration

> Superseded where conflicting by [consolidated decisions](persistent-workspaces-decisions.md).
> This exploration retains alternatives and rejected ideas; it is not the implementation contract.
> In particular, merge/pull, return deprecation, indexed defaults, transaction identity and layout
> follow the consolidated decisions, not the exploratory sections below.

Status: design only, no implementation in this change. Written 2026-11-20 against `7014ee1`,
revised after review. Nothing here has been executed against a node; see
[Evidence status](#evidence-status).

## 1. Summary

Today every publish creates a **new immutable generation**. `incrementalFrom` saves wire bytes but
not disk or path stability: it requires a *new* destination and copies the unchanged files on the node.
Two agent behaviours follow, both bad:

- delete the old directory (`rm -rf`) to reclaim disk, which also destroys every path-keyed build
  cache (`node_modules/`, `target/`, `.venv/`, `.cache/`) and makes the next build cold;
- keep every generation, so node disk grows with each sync and the agent has to remember which path is
  current.

The fix is not a faster generation copy. It is a **persistent managed workspace**: one stable
directory per project on the node, updated in place, with a tracked file set, a node-owned metadata
record, explicit deletion and collision rules, a journal, and cheap no-op syncs. Build caches survive
because the path never changes and because cache directories are never tracked.

**Recommendation:** build this as the primary workflow (`node_workspace_sync`), keep the immutable
generation tools for one-way publishing and as the migration source, and do not add Git, rsync,
hardlink snapshots, or an archive format.

The safe default is deliberately narrow: **`mode: "push"` (local → node) refuses to run when the node
tree has changes it cannot explain from the base** (`remote-dirty`). Reaching node changes requires an
explicit `mode: "pull"` or `mode: "merge"`. A routine "publish my work" call must never silently
absorb a dirty remote.

The guarantee we can honestly offer:

1. plan-level all-or-nothing — a plan with any conflict, collision, or dirty peer writes nothing;
2. per-file atomic replacement — every individual path holds either its old complete content or its
   new complete content, never a truncated write;
3. crash-recoverable — a journal and a trash area outside the tree let the next operation converge to
   the target revision, or report exactly which paths are mixed;
4. no whole-tree atomicity, and no safety against an arbitrary `exec` command writing in the tree
   while a sync runs. Both are stated as non-goals below rather than papered over.

## 2. What the current model does, and why it fails this workload

From the code (`src/gateway/push.ts`, `src/node/commands.ts`, `docs/architecture.md`):

| Property | Current behaviour | Consequence for a build/iterate loop |
| --- | --- | --- |
| Destination | `mkdir(2)` claim, must not exist | New path per publish |
| Unchanged files | Copied on the node from a verified base with `COPYFILE_EXCL` | Full tree occupies disk again; `O(tree)` copy per sync |
| Deletion | Never; an omitted file simply stays in the old generation | Old content accumulates |
| Node edits | Only via a separate preview/return into the local project | Not part of the publish loop |
| Base for return conflicts | Local `.nodews-return-state.json`, keyed by node+path | Per-project file, not tied to a managed tree |
| Crash recovery | Incomplete marker; the operator removes the directory | No roll-forward; a retry to the same path is refused |
| Scanning | Full tree re-hash on every status/tree/push | Repeated cost proportional to tree size |

The incremental path is a good wire-level optimization. It solves none of the three problems the
user names: path stability, cache preservation, and directory proliferation.

## 3. Requirements

R1. **Stable path.** A project's node directory keeps its absolute path across syncs. `exec`
`workdir` stays valid for the lifetime of the project.
R2. **Cache preservation.** Files the sync does not track — build caches, dependency trees, tool
state — are never read for content, never deleted, and never moved. Their bytes must not count
against the tracked transfer set.
R3. **Bidirectional convergence, but not by default.** Local edits go to the node; node edits and
generated files come back only through an explicit `pull`/`merge`. The default `push` refuses a dirty
remote.
R4. **No lost update.** A concurrent local edit, node edit, or plan change must produce a coded
conflict or a CAS refusal before any write, never a silent overwrite.
R5. **Recoverable.** After a crash, disconnect, or unknown outcome, the next call can either complete
the transaction or report a precise mixed state. No silent "looks fine".
R6. **Cheap repeat.** A no-op sync is one metadata exchange; it does not copy the tree and does not
re-hash the whole tree by default.
R7. **Bounded.** Per-workspace quotas on tracked bytes, staging, and undo data, checked before the
first write; free-space check on the node.
R8. **Agent-shaped.** One call for the common case, deterministic results, small closed error code
set, no generation bookkeeping in the agent's head, no new command-execution surface.
R9. **Same authority model.** The Gateway side is authorized only by the workspace the host resolved
for the calling session (plus optional narrowing). No configured root ever becomes the source of
authority, and the process cwd is never a fallback.
R10. **Compatible.** Existing generations stay readable; upgrade order stays node-then-gateway; a
mixed-version pair fails closed.
R11. **Policy changes never delete source.** Adding an exclude pattern, narrowing `include`, or
removing a path from the tracked set must never delete the node copy, the local copy, or the
metadata record of a previously tracked path. Selection changes are not deletions.
R12. **Dirty peer blocks the safe default.** `push` with node-side changes, `pull` with local-side
changes, or any difference the plan cannot explain is `remote-dirty` / `local-dirty` before any
write.
R13. **Metadata is node-owned and outside the tree.** The workspace's control record lives in a
node-owned state directory, not inside the synced project, so `exec`, a build, or a stray `rm` in the
project cannot corrupt or delete it.
R14. **No mtime-only integrity claim.** Stat-based caches may decide *what to hash*; they never stand
in for a digest in a result, a plan, or a verification claim.

## 4. Non-goals and explicit non-claims

N1. **No whole-tree atomic switch.** Readers can observe a tree mid-update. The marker says
`state: "incomplete"` and status reports the journal. Consumers must wait for `complete` /
`revision` to advance.
N2. **No protection against arbitrary concurrent writes.** The plugin serializes its own operations
with a lock. An `exec` process the agent starts — a compiler writing `target/`, a formatter, a
second shell — is outside that lock. The plugin narrows the race with per-path re-checks immediately
before each rename and detects the result as drift at commit; it does not prevent it.
N3. **No content merge.** Textual 3-way merge is out of scope. Per path: one side changed → take it;
both changed differently → conflict. No merge markers are written anywhere.
N4. **No hardlinks between mutable trees.** Two paths sharing an inode means an edit through one
mutates the other; that is corruption, not a snapshot. Rejected.
N5. **No raw `rm` and no automatic cleanup of unknown directories.** Deletions move to a trash area
and are unlinked only after a committed marker. The plugin never recursively deletes a directory it
cannot prove it owns, and never "cleans up" an unknown directory to reclaim space.
N6. **No watcher, no daemon, no background sync.** Every mutation is an explicit call.
N7. **No new archive or manifest-in-a-blob format.** The frame protocol stays flat; tree metadata is
JSON with per-path entries.
N8. **No ownership/ACL/xattr/timestamp/hardlink preservation.** Content plus the owner execute bit,
as today.
N9. **Not a sandbox**, and not a defence against a malicious node operator or a same-UID attacker.
N10. **No Windows.** POSIX path and rename semantics only.
N11. **No command execution endpoint.** The plugin will not gain a `run`, `exec`, `build`, or
`shell` tool, and will not accept a command in a sync request. Execution stays with the native `exec`
tool and its own approvals and allowlists. Because there is no shared lock or lease with `exec`, a
sync cannot be made simultaneous-safe with an agent-run build; that limitation is stated, not
engineered around.
N12. **No `--force`, `clean`, or `reset`.** There is no flag that discards one side, overwrites an
untracked path, deletes a foreign directory, or ignores a conflict. Destructive reconciliation is an
operator action through `exec`, after which a sync observes the new state.

## 5. Authority and ownership

Unchanged in principle, extended in surface.

- **Local authority** is `context.workspaceDir`, else `resolveAgentWorkspaceDir(cfg, agentId)`, else
  `workspace-unresolved`. Every `localPath` resolves through
  `resolveWorkspaceBoundary`/`assertLocalAccess` before any filesystem access
  (`src/gateway/workspace-boundary.ts`). `gateway.localRoots` and friends may only narrow.
- **Node authority** remains `node.pushRoots` / `node.returnRoots`: absolute real directories the
  operator granted. The node has no session concept and must not acquire one.
- **Workspace ownership** is proven by the thin marker in the tree plus the control record in the
  node state root, never by the path alone. A managed workspace is created by the plugin or adopted
  explicitly (D11). A foreign directory is never taken over.
- **Node state root** (`node.stateRoot`) is a new operator-owned directory, for example
  `/var/lib/openclaw/node-workspace`, resolved on the node host — never the process cwd. Config is
  rejected if it lies inside, or contains, any `pushRoots` entry (checked with real paths), so a
  publish can never write the plugin's own metadata. The state root is `0700`.
- The managed workspace's **local identity** is the canonical `realpath` of `localPath`. The control
  record stores `localIdentity = sha256(canonical local root)` and a non-sensitive `label` (the last
  path component) so a rebind is visible. A different local project syncing to the same node path is
  `identity-mismatch`, not a silent merge. No config file participates.

## 6. Identity and session continuity

The durable record lives with the workspace, on the node, and is reachable from any session.

- **Workspace id** (opaque handle) = `sha256(canonical remotePath)[0..32]`. It is stable for the
  lifetime of the directory and survives a Gateway restart, a new session, a different agent, and a
  plugin reinstall. The control directory is `$stateRoot/workspaces/<workspaceId>/`.
- **The handle never grants authority.** `workspaceId` may be returned in results for logs, UI
  correlation and operator tooling, but v1 accepts no `workspaceId` input: every call re-resolves
  `node` + `remotePath`, re-checks node roots, and re-checks the local path against the calling
  session's workspace. A handle copied from another session is inert.
- **Base revision** = the manifest committed by the last successful sync, stored in the control
  directory. It travels with the node, not with the agent's session.
- **No `sessionKey` in identity.** The session key stays a progress-scope concept only. Any session
  whose workspace contains the local project can drive the same managed workspace, which is what
  "continuity" should mean. Concurrent sessions are handled by the lock, not by identity.
- **No local state file.** There is no `.nodews/` directory and no baseline file inside either tree.
  The Gateway re-reads the node's metadata on each call; offline planning was never possible anyway
  because the node tree must be scanned. This also removes the current failure mode where a lost
  local `.nodews-return-state.json` degrades the next return to `no-base` conflicts although the
  node still knows its state.

## 7. On-node layout and path/cache boundaries

```
<remotePath>/                         # stable; the agent's exec workdir
  .openclaw-node-workspace.json       # thin marker: workspaceId, kind, revision, digest, state
  src/…  Cargo.toml  …                # tracked project files
  node_modules/  target/  .venv/ …    # untracked build state: never read, never touched

<node.stateRoot>/workspaces/<id>/     # node-owned, outside every pushRoot
  meta.json                           # revision, digest, localIdentity, label, kind, lastSyncAt
  manifest.json                       # committed manifest (full, no 4 MiB marker cap)
  journal.json                        # the one in-flight transaction
  tmp/<txId>/                         # staged new contents, same filesystem as the tree
  trash/<txId>/                       # previous contents of replaced/deleted tracked paths
  scan-cache.json                     # optional stat-identity hash cache
  lock                                # atomic claim + holder + lease
```

The marker stays deliberately small. The current marker carries the whole manifest and is capped at
4 MiB (`MAX_MARKER_BYTES`), which caps the tree at a few thousand entries; the control directory
removes that cap and keeps the in-tree file cheap to read. The marker is written last on commit and
is the only file the plugin puts in the project; it is reserved in manifests
(`assertSafeRelativePath` already reserves the marker name).

**Three sets, not two.** The distinction is the core of R11:

| Set | Definition | Plugin may |
| --- | --- | --- |
| **tracked** | paths selected by the current `include`/`exclude` | read, write, rename, delete (via trash) |
| **released** | paths in `meta.json`'s tracked history that the current selection no longer includes | never delete; keep in a `released` list so a later re-include does not look like a new file |
| **untracked** | everything else present on disk, including caches and generated trees | never read, never write, never delete, never move |

Rules:

- The plan's deletion candidates are exactly `tracked ∩ base`. A path in `base` that is not selected
  by the current filter is released, not deleted. Its node file stays, its entry moves to `released`,
  and neither side reports it as an addition or a deletion.
- An exclude change is therefore non-destructive by construction: excluding `target/` after a first
  sync leaves the node `target/` alone and stops tracking it. Re-including it adopts the existing node
  copy as tracked again, with the node version as the current truth (and a conflict if the local
  version differs).
- **Default protection list** (documented, reported in every result, removable by the caller):
  `node_modules`, `target`, `dist`, `build`, `out`, `.venv`, `venv`, `__pycache__`, `.mypy_cache`,
  `.pytest_cache`, `.gradle`, `.next`, `.turbo`, `.git`, `.hg`, `.svn`, `.openclaw-node-workspace.json`.
  Rationale: a cache appearing as a "node addition" would otherwise import tens of thousands of files
  on the first pull.
- **Cache freshness is the project's responsibility.** The plugin never inspects, invalidates, or
  rebuilds a cache. A stale `target/` or `node_modules/` is a build problem; a sync that changes
  `Cargo.lock` or `package.json` does not run `cargo build` or `npm install`, and a cache it preserved
  may no longer match the sources. Say so in the tool text: "caches were preserved, not validated".
- The plugin writes only to tracked paths, the marker, and the control directory. It never descends
  into an excluded directory and never computes a digest over one.

## 8. Revision model, CAS and snapshot coherence

- `revision` is a monotonically increasing integer per workspace, incremented **only** by a
  committed transaction.
- `treeDigest` is the existing canonical manifest digest over the tracked set. The pair
  `(revision, treeDigest)` is the workspace state.
- A mutating request carries `baseRevision` when the caller wants strict CAS, and `planDigest` when it
  wants to pin a previewed plan (as `node_workspace_return` does today).
- The node refuses `baseRevision ≠ current revision` with `revision-mismatch`, returning
  `currentRevision` and `currentDigest`; no write. Distinct from `plan-stale`, which means the derived
  plan changed.
- **Transaction identity** is deterministic:
  `txId = sha256(nodeId, remotePath, baseRevision, targetTreeDigest, planDigest)[0..32]`.
  A retry of the same intent after an unknown outcome maps to the same `txId`; the node resumes the
  journal or reports `already-applied` with the committed revision.

**Snapshot coherence.** A plan is only meaningful for the exact bytes it hashed.

- Each side produces a snapshot — `path → (size, sha256, exec)` — and the plan is a pure function of
  the two snapshots plus the base manifest. The `planDigest` covers `baseRevision`, both snapshot
  digests, and every operation.
- A file that changes while it is being read fails the snapshot (`source-unstable`, not a silent
  mixed hash), using the same before/after `lstat` check the scanner already performs
  (`hashFile` in `src/manifest.ts`).
- At apply time the node takes a fresh snapshot under the lock and requires its digest to equal the
  plan's expected node digest; otherwise `plan-stale` before staging. The local side is re-read for
  every path it is about to write, and the base hash is compared immediately before the rename.
- **CAS invalidation is explicit**: a committed revision, a changed plan digest, or a changed touched
  path all refuse before the first write. A retry is a new preview, not a resumed half-plan, except
  where the journal proves the transaction is the same `txId`.
- **No mtime-only claims.** The scan cache (`size, mtimeNs, ino, sha256`) only decides whether to
  re-hash. Every path in a plan, every acknowledgement, and every reported digest comes from bytes.
  Results name what was verified: `verified: "touched"` after a commit (changed paths re-hashed from
  disk) or `"full"` after `verify: "full"`. A stat match is never reported as integrity.

## 9. Reconciliation and the dirty-peer gate

Inputs: `b` = committed manifest of `baseRevision`, `l` = local snapshot, `n` = node snapshot, all
restricted to the tracked set. Identity of a file is `(size, sha256)`; the exec bit is compared
separately.

**Modes** (the default is the safe one):

| Mode | Direction | Refuses when |
| --- | --- | --- |
| `push` (default) | local → node | the node has any change vs `b` that the local snapshot does not reproduce exactly → `remote-dirty` |
| `pull` | node → local | the local tree has any change vs `b` that the node snapshot does not reproduce → `local-dirty` |
| `merge` | both, per-path table | any conflict |

A "change vs `b`" that is identical on both sides is a convergence, not dirt: if the agent edited the
same file on both sides to the same bytes, `push` may proceed (nothing to send) and the base advances.
Everything else blocks. `remote-dirty` and `local-dirty` results list the paths and their kinds, and
suggest `mode: "merge"`; they never write.

**Per-path table** (used by `merge`, and by `push`/`pull` after the dirty check):

| # | base | local | node | Result |
| --- | --- | --- | --- | --- |
| 1 | X | X | X | unchanged |
| 2 | X | Y | X | local change → write node |
| 3 | X | X | Y | node change → write local |
| 4 | X | Y | Y | converged → no write, advance base |
| 5 | — | Y | — | local addition → add node |
| 6 | — | — | Y | node addition → add local |
| 7 | — | Y | Z | add/add conflict |
| 8 | X | — | X | local deletion → delete on node (to trash) |
| 9 | X | X | — | node deletion → reported; never applied in v1 |
| 10 | X | — | — | both deleted → drop from base |
| 11 | X | — | Y | delete/modify conflict |
| 12 | X | Y | — | modify/delete conflict |
| 13 | any | file↔dir | | type conflict |
| 14 | — | untracked* | | untracked collision (if the plan writes there) |
| 15 | X | same content, different exec bit | | mode change; applies only when the other side matches `b` |

`*` "untracked" here means present on the receiving side but outside the tracked set. It is reported
as `untracked-collision` and the plan is refused; the plugin never overwrites or deletes a path it
does not track.

**Deletion policy (D8):**

- Local deletion of a tracked path propagates to the node by moving the node file into
  `trash/<txId>/` — recoverable, no `rm`.
- Node deletion of a tracked path is **reported, never applied** in v1. A build script that cleans a
  directory must not silently delete the source of truth. The result lists `removedOnNode`. An
  explicit local delete is an operator action through `exec`, then a sync observes it.
- Directory removal is never recursive: a directory disappears only when every tracked path below it
  is gone and the directory is empty. Untracked entries keep it alive.
- A selection change is never a deletion (R11).

**Conflict UX:** a plan with any conflict or collision writes nothing and returns `code: "conflict"`
or `"untracked-collision"`, the list, and the `planDigest`. The agent resolves and calls again. There
is no override flag (N12); if an operator truly needs to discard one side, they do it through `exec`
and then sync, which is honest about who destroyed what.

## 10. Transaction, journal, crash recovery, unknown outcome

An apply runs in phases. All metadata is fsynced before it is depended on. Journal, staging, trash and
lock all live in the control directory, on the same filesystem as the tree, so every rename is atomic
and no metadata is exposed inside the project.

1. **Lock.** `mkdir $stateRoot/workspaces/<id>/lock` (atomic, `EEXIST` on contention); write holder +
   lease. Refuse with `lock-held` (holder, leaseUntil). A lease is renewed during long transfers; an
   expired lease is recoverable, a live one is not overridden.
2. **Recover.** If `journal.json` exists, enter the recovery path before planning.
3. **Snapshot and plan.** Local snapshot, node snapshot (under the lock), base manifest, mode gate,
   merge, `planDigest`, `targetTreeDigest`.
4. **Refuse.** Conflicts, collisions, dirty peer, quota, free space, `baseRevision` mismatch: stop
   before any write, release the lock, return a coded result with the plan.
5. **Journal.** Write `journal.json` with `txId`, `baseRevision`, `targetRevision`, `targetDigest`, the
   exact `puts`/`deletes`/`modes` and expected base hashes, then fsync. Set the marker to
   `state: "incomplete"` with `journalId` (the marker still names the previous revision).
6. **Stage.** Receive changed file bytes into `tmp/<txId>/`, verify size and SHA-256, fsync each. No
   target path is touched yet.
7. **Preserve.** For every overwritten or deleted tracked path, copy (overwrite) or rename (delete)
   the current content into `trash/<txId>/`. Fsync.
8. **Apply.** For each `put`, re-check that the target still matches the planned base hash, then
   `rename(tmp → target)` — atomic per file on the same filesystem. For each `delete`, the rename to
   trash already removed it from the tree. Re-check parents are real directories beneath the
   workspace root before every rename.
9. **Commit.** Write `manifest.json` and `meta.json`, then atomically replace the marker with
   `revision + 1`, `state: "complete"`, `journalId: null`, and fsync the marker, the control
   directory, and the touched directories in a bounded pool.
10. **Clean.** Purge `tmp/<txId>`; keep `trash/<txId>` until the next successful commit or a TTL (see
    retention). Release the lock.

**Crash windows and what recovery does:**

| Crash point | State on disk | Recovery |
| --- | --- | --- |
| Before journal fsync | nothing changed | none needed |
| After journal, before any put | marker incomplete, journal, base intact | roll back: restore marker to previous revision, purge journal |
| Mid-stage | journal + partial tmp | roll forward: the gateway re-sends missing staged files (same `txId`), then continue |
| After some renames | mixed tree, journal records all intended ops | roll forward: for each put, if target hash == new hash, skip; else rename from tmp (re-staged if needed). Deletes are already in trash. |
| After commit, before cleanup | consistent new revision, trash/tmp present | no-op success; cleanup on next call |
| After trash purge | consistent | none |

**Honest limit:** if a put's staged bytes are lost (node rebooted with an unclean fs) and the source
is unavailable, recovery cannot conjure the target. It reports `recovery-incomplete` with the exact
paths and their current hashes; the tree stays mixed and is marked `state: "incomplete"`. Nothing is
deleted to hide it.

**Unknown outcome (unchanged principle, sharper identity):** if the channel dies after the node
accepted the transaction, the Gateway raises `unknown-outcome` with `txId`, `nodeId`, `remotePath`,
`baseRevision`, `targetRevision`. `node_workspace_status` is the only reconciliation path; it reports
revision, state, journal phase, and whether the tree matches the target. A retry with the same
`planDigest` and `baseRevision` resumes the same `txId`; a retry with a new plan against an advanced
revision is `revision-mismatch`. Never collapse `unknown-outcome` into `transport`.

**Idempotency of cleanup:** trash and tmp names are `txId`-scoped, so a repeated cleanup is a no-op.

## 11. Concurrency and the limits of coordinating `exec`

- **Plugin-side serialization:** one writer per workspace, enforced by the node lock and a gateway-side
  in-memory queue keyed by the resolved workspace, so two sessions do not race into `lock-held` for no
  reason; the node lock remains the authority.
- **Readers:** a dry run does not block a writer; it reports the revision it planned against. `status`
  is lock-free and always safe.
- **Exec is not coordinated, and cannot be made so by this plugin.** There is no shared lock protocol
  with the native `exec` tool, no way to make a shell command join the workspace lease, and no
  intention to add one (N11). Caches are excluded, so the common concurrent build is harmless; a
  tracked file written concurrently is detected by the pre-rename re-check or the final touched-set
  verification and reported as `destination-drifted`. A build that writes into a tracked path is a
  conflict, not a plugin bug. If a workflow needs stronger isolation, it must serialize `exec` against
  sync itself.
- **No advisory lock on the project root** that other tools might be expected to honour: it would be
  ignored by arbitrary processes and invite a false sense of mutual exclusion.

## 12. Symlink policy

Unchanged default, extended to apply time.

- Scan: `symlinks: "reject"` fails the plan on any link in the tracked selection; `"skip"` omits it
  and reports it in `skipped`. Never follow.
- Apply: every existing parent between the workspace root and a target must be a real directory
  (`lstat` + `realpath === path`), re-checked immediately before the rename. A symlinked or replaced
  parent → `symlink-rejected` / `local-conflict`; nothing is written through it.
- A tracked path that is a symlink on either side and a file on the other is a **type conflict**, not
  a replacement. The plugin never unlinks a symlink to make room for a file.
- Residual same-UID race is unchanged and documented (Node lacks `openat`/`renameat2` with expected
  inode). The managed design does not make it worse: per-file renames have a smaller window than a
  whole-tree copy, and the journal makes the outcome visible.

## 13. Tool surface

Goal: the agent thinks in **one project, one call**, not in generations and plan digests. No new
execution surface: the only new tool is a sync.

### 13.1 `node_workspace_sync` (new, primary)

```ts
{
  node: string,
  localPath: string,                 // inside the session workspace
  remotePath: string,                // inside node.pushRoots
  mode?: "push" | "pull" | "merge",  // default "push"; pull/merge are explicit
  create?: "new" | "adopt",          // default "new"; "adopt" only for a complete generation
  include?: string[],
  exclude?: string[],
  baseRevision?: number,             // CAS; omit for "whatever is current"
  planDigest?: string,               // pin a dry-run plan
  dryRun?: boolean,
  verify?: "quick" | "full",         // default "quick"; "full" re-hashes everything
  recover?: "resume" | "abort"       // only meaningful with a pending journal
}
```

Result (success and blocked share one shape; `ok` distinguishes):

```ts
{
  ok: true,
  state: "applied" | "noop" | "blocked" | "already-applied" | "recovered",
  mode,
  workspaceId,                       // opaque handle; output only, never an input
  nodeId, remotePath, localPath,
  revision, previousRevision, treeDigest, planDigest, txId,
  counts: { pushed, pulled, deletedRemote, deletedLocal, unchanged, conflicts, released },
  conflicts: [{ path, kind: "content" | "add-add" | "delete-modify" | "type" | "untracked" }],
  dirty: { side: "local" | "node", paths: { path, kind }[] } | null,
  skipped: { path, reason: "excluded" | "symlink" }[],
  protected: { paths: number, bytes: number },   // untracked/released volume, informational
  quota: { trackedBytes, limit, peakBytes, freeBytes },
  verified: "touched" | "full" | "none",
  durationMs
}
```

- Default `push`, clean node → apply, return `applied` or `noop` (zero writes, zero file frames).
- Default `push`, dirty node → `state: "blocked"`, `code: "remote-dirty"`, the changed paths and their
  kinds, nothing written. The text names the two explicit ways forward (`mode: "merge"` or
  `mode: "pull"`).
- `pull` with a dirty local tree → `local-dirty`, same shape.
- Conflicts → `state: "blocked"`, `code: "conflict"`, the same `planDigest`, nothing written.
- `dryRun` → the same body with no writes; this is the only way to preview, so the agent never needs
  a second tool name to look before leaping.
- The text content is one line plus a hint: `pushed 12, deleted 1, 0 conflicts; revision 7 at
  /…/project on node … (caches preserved, not validated)`.

### 13.2 `node_workspace_status` (extended)

Adds `kind: "generation" | "managed"`, `managed`, `workspaceId`, `revision`, `treeDigest`, `journal`
(`{txId, phase, startedAt}` or null), `lock` (`{holder, leaseUntil}` or null), `quota`,
`reclaimableBytes`, and `metadata: "ok" | "missing" | "mismatched"`. Everything existing stays. Text
keeps naming the drift reason.

### 13.3 `node_workspace_changes` (kept, redefined)

Becomes the explicit dry run for `sync`: same result shape plus `planDigest`. It stays because a
read-only preview is valuable for review flows and because it is the compatibility path for
`node_workspace_return`.

### 13.4 `node_workspace_return` (deprecated alias)

Maps to `sync` with `mode: "pull"`, default deletion policy. Kept for one minor version; docs mark it
deprecated. `node_workspace_push` and `node_workspace_artifact` are unchanged; `push` refuses a
managed destination with `workspace-managed` (use `sync`).

Why not fewer tools: dropping `changes` forces every review to be a `dryRun` call, which is fine, but
keeping it costs nothing and preserves the safety story. Why not more: no `gc`, no `unlock`, no
`revision list`, no restore tool, and above all no `run`/`exec`/`build` tool in v1. Status reports
reclaimable bytes and a stale lock; recovery happens inside `sync` (`recover`), which is the operation
that has the plan and the bytes.

### 13.5 Error codes (closed set, added only)

| Code | Meaning |
| --- | --- |
| `workspace-not-managed` | destination exists but is not a managed workspace; use `create: "adopt"` or a new path |
| `workspace-managed` | a generation `push` targeted a managed workspace |
| `metadata-missing` | the control directory or `meta.json` is absent/foreign; read-only status, sync refuses |
| `identity-mismatch` | the record is bound to a different local project |
| `revision-mismatch` | CAS failed; `currentRevision`/`currentDigest` returned |
| `remote-dirty` | node differs from base in a way the local snapshot does not reproduce; nothing written |
| `local-dirty` | local differs from base in a way the node snapshot does not reproduce; nothing written |
| `conflict` | plan has conflicts; nothing written; `planDigest` returned |
| `untracked-collision` | a plan would write a path that exists untracked on the receiving side |
| `lock-held` | another sync holds the workspace lock; `leaseUntil` returned |
| `recovery-required` | a journal is pending; call with `recover` |
| `recovery-incomplete` | recovery cannot reach the target; exact paths reported |
| `quota-exceeded` | tracked/staging peak above the workspace quota; nothing written |
| `no-space` | node free space below the planned peak + margin |
| `source-unstable` | a file changed while it was being hashed; nothing written |
| `destination-drifted` | a tracked path changed between plan and apply (may be exec) |

Existing codes keep their meaning. Every failure result carries `ok: false`, `code`, `message`,
`unknownOutcome`, and the operation context (`nodeId`, `remotePath`, `localPath`, and `txId` /
`revision` when applicable), matching `toolFailure`.

## 14. Incremental transfer performance

The dominant cost today is not bytes on the wire, it is passes over the tree
(`docs/verification.md`: three per-file filesystem passes plus the fsync pool).

- **Zero copy for unchanged files.** In-place update means unchanged content is already at the target
  path. The current incremental copy phase disappears; a sync of 1 changed file in a 50 000-file tree
  transfers one file and creates zero extra disk copies.
- **Rejected as the initial default; indexed optimization only.** The node keeps `scan-cache.json` in the control directory:
  `path → (size, mtimeNs, ino, sha256, exec)`. A scan reuses a recorded hash when the stat identity
  matches; touched paths are always re-hashed and the final touched-set verification is always
  computed from bytes. `verify: "full"` ignores the cache. The cache is a *change detector*, not an
  integrity claim (R14); a same-UID writer can forge mtime/size, and `full` exists for that. Results
  say `verified: "touched"` or `"full"`, never "verified" from a stat match.
- **Manifest exchange first.** A no-op sends no payload frames, but strict verification still hashes
  selected source on both sides. Cached snapshots are an optional weaker indexed mode only, not the
  initial default. No-op is not a claim of metadata-only integrity verification.
- **Batched renames.** Stage all changed files, then rename in a bounded pool (16), fsync directories
  in one phase, as the push path already does for durability.
- **Block-level delta (deferred).** Only if measurements show whole-file re-sends dominate (large
  generated artifacts, append-only logs). It needs a new frame type and a rolling-checksum
  implementation; adding it speculatively would double the protocol surface for no measured gain.
- **Benchmarks to add before claiming improvement** (none run for this design): warm and cold
  `noop`, `1-file`, `10%-changed` on 2 000 × 4 KiB and 50 000 × 2 KiB fixtures; one 1 GiB file with a
  4 KiB change; report wall time, bytes on the wire, files opened, and node CPU. Target: no-op ≤ one
  scan each side and no writes.

## 15. Disk, staging and quotas

- Workspace config (node side): `maxTrackedBytes`, `maxStageBytes`, `maxTrashBytes`, `minFreeBytes`,
  `maxEntries` (reuse `maxFiles`), `scanCache: boolean`.
- Projected peak before write = `staged new bytes + trash preservation bytes + manifest`. If it
  exceeds quota → `quota-exceeded` with exact numbers and the largest contributing paths.
- `fs.statfs` (Node ≥ 18.15) check before the first write; below `minFreeBytes` → `no-space`.
- Trash is bounded: if `maxTrashBytes` would be exceeded, the sync refuses rather than silently
  dropping undo data.
- Control-directory bytes (manifest, journal, staging, trash) count against the workspace's metadata
  budget, not the tree's; `status` reports both. Caches are excluded from tracked bytes but are
  measured for free space.

## 16. Retention and safe cleanup

- `tmp/<txId>` is removed at commit; a leftover is removed only by a recovery of the same `txId` or by
  cleanup when its journal is absent and the directory is older than the grace period (default 1 h).
- `trash/<txId>` is kept for one successful commit (single-step undo) or 24 h, whichever comes first.
  Purging is `rm -rf` **only** of a `trash/<txId>` directory whose `txId` is referenced by no journal
  and is older than the grace period. Never a whole workspace, never a tracked path, never a path
  outside `$stateRoot/workspaces/<id>`.
- No automatic deletion of a previous revision tree — there is only one tree.
- **Unknown directories are never cleaned up.** A directory under `$stateRoot/workspaces/` without a
  valid `meta.json`, or a directory in the project the plugin did not create, is reported and left
  alone. Reclaiming it is an operator decision, not a plugin action (N5, N12).
- Stale lock: status reports it. `sync` with `recover: "abort"` may break a lock whose lease expired
  **and** whose journal is absent or aborted; otherwise `lock-held`.
- `reclaimableBytes` in status lets the agent report disk pressure without a cleanup tool.

## 17. Alternatives evaluated

Reviewed documentation only; nothing here was benchmarked or integrated. The Git worktree page and
the rsync primary manual were fetched successfully (HTTP 200); `download.samba.org` returned 403, so
that mirror was not read.

| Option | Verdict | Why |
| --- | --- | --- |
| Keep immutable generations, add a `latest` symlink | Rejected | A symlink root breaks `realpath` containment checks and path-based caches still change when the link target changes only for tools that resolve it; `pwd` and build systems disagree. Also leaves generations on disk. |
| Hash-linked generations (`cp -al`) | Rejected | Shared inodes: editing a file through one generation mutates the other. Any build that writes in place corrupts the "unchanged" copy. Explicitly forbidden by the brief. |
| Reflink snapshots (`COPYFILE_FICLONE`) | Deferred, optional | Cheap copy-on-write generations on btrfs/XFS; not available on ext4/tmpfs, not portable, adds a second state model. Useful later as an *undo* store, not as the live tree. |
| `git worktree` ([docs](https://git-scm.com/docs/git-worktree)) | Rejected | Worktrees share the repository's object database and refs, but a linked worktree is still a separate checkout with its own index and working tree; the documentation describes branch-oriented worktree management, not propagation of generic uncommitted filesystem changes between two trees. It also requires the `git` binary, an index, ignore rules, and history pruning, and it invites `git clean`/`reset` — the cache-destroying operation we are removing. Concepts (manifest + three-way + CAS) are adopted without the tool. No git is used anywhere in this repository today. |
| `rsync` ([manual](https://raw.githubusercontent.com/RsyncProject/rsync/master/rsync.1.md)) | Rejected as transport | The manual documents a delta-transfer algorithm and, separately, `--delete` and in-place options whose semantics are exactly the unsafe part; a binary or full protocol implementation plus SSH is a second transport to secure beside the existing node channel. Its delta pays off mainly for large changed files, covered by the deferred block-delta option if measured. No rsync dependency exists in this repository. |
| Append-only content-addressed object store on the node | Rejected as the live tree | Materialising it requires links or copies; links are unsafe, copies reintroduce the disk cost. Acceptable later for undo data (object per changed file, referenced by `txId`). |
| Overlay/bind mounts | Rejected | Needs privileges, is not portable, and hides a second filesystem view from `exec`; the plugin would be claiming isolation it does not provide. |
| Archive (tar/zip) transfer | Rejected | Violates the repository rule: archive parsing is where traversal bugs live, and the flat frame protocol is deliberate. |

## 18. Backward compatibility and migration

- **Protocol 5.** New frames (`same`, `tx`, `recover`) and fields (`revision`, `journalId`, `kind`).
  A v4 peer fails at `hello` exactly as today; both halves are upgraded together (node first).
- **Marker stays protocol 1, additive fields** `workspaceId`, `kind`, `revision`, `manifestDigest`.
  The marker `state` keeps the existing `complete` / `incomplete` values: a transaction sets
  `incomplete`, a commit sets `complete`. An old reader therefore refuses a mid-update tree and
  reports it as incomplete — fail-closed, no new enum value to break parsing. `legacy` is unchanged.
- **A managed marker never carries the manifest.** Old readers that require `marker.manifest` report
  the tree as unverifiable; correct for an old reader, and the new reader uses the control directory.
- **Old readers on a managed workspace** see `exists, owned, complete`; they cannot call `nodews.sync`
  (command missing) and `push` to the path returns `destination-exists`. Acceptable and documented.
- **Control directory absence is not adoption.** A managed marker without its control record is
  `metadata-missing`: status is read-only, sync refuses, and the operator decides whether to restore
  the state root, adopt, or start a new path. There is no reconstruction from a dirty tree.
- **Migration from generations:** `sync(create: "adopt")` accepts an existing complete generation,
  verifies its digest, writes the control record with `kind: "managed"`, `revision: 1`, and the
  current manifest as base. No files move. Old generations stay until the operator removes them (the
  plugin still never deletes a directory). Recommend one adoption per project, then one sync.
- **`.nodews-return-state.json`** keeps being read as a secondary base for generation targets; a
  managed workspace does not read or write it.
- **Tool contract:** existing five tools keep their names; `return` is deprecated with a forwarding
  implementation; `push` gains one refusal code. `openclaw.plugin.json` contracts gain
  `node_workspace_sync`.
- **Rollback of the plugin** to a pre-managed version leaves managed workspaces readable but not
  syncable; they are not corrupted. Document that downgrade requires deciding whether to keep using
  them read-only.

## 19. Test matrix (lowest layer that can decide it)

| Layer | What it decides | Cases |
| --- | --- | --- |
| Unit (pure) | Merge semantics, dirty gate, plan digest, txId, quota math, retention eligibility, state reducer | All 15 rule rows; `push`/`pull` dirty decisions including "same change on both sides is not dirt"; delete/modify both directions; add/add; type change; mode-only; untracked collision; empty-dir lifetime; policy change moves paths to `released` and deletes nothing; planDigest determinism across path order; txId idempotence; projected peak; trash eligibility (referenced vs orphaned vs unknown). |
| Unit (paths/config) | Path and reserved-name rules | Marker reserved; state root inside a pushRoot rejected; traversal; component length; identity hash stability; default protects and explicit removal. |
| In-process transport, real files | Every filesystem transition with the real node handlers | create → sync → noop (zero writes, asserted by mtime/ino); change one file; add; delete local → trash on node; node edit → `remote-dirty` in `push`, applied in `pull`; both changed → conflict, tree untouched; untracked cache preserved byte-identical and absent from manifest; exclude added after a sync leaves the node copy and releases its metadata entry; re-include adopts it; symlink reject/skip; parent symlink at apply time; `baseRevision` mismatch; same plan retry → `already-applied`; journal present → `recovery-required`; forced crash points (kill between journal/stage/apply/commit by constructing the on-disk state) → roll forward and roll back; `recovery-incomplete` when staged bytes vanish; quota and no-space refusal before any write; scan cache hit/miss/invalidation; `verify: "full"` catches a forged stat and `quick` never reports it as integrity; lock contention and expired-lease break; 50 000-entry manifest in the control directory; control directory missing → `metadata-missing` and no write. |
| Packaging/loader | Registration and command surface | `pack-and-inspect.sh` lists `node_workspace_sync` and six commands; capability acceptance still required; old config without new keys works. |
| Two-process integration | Real Gateway + node host, real channel | create, exec writes a generated file, `push` blocks `remote-dirty`, `pull` brings it back, exec builds a cache dir, second sync preserves it, kill the node host mid-sync, status reports the journal, sync resumes, revision advances once; adopt an existing generation; upgrade path; state root moved between runs → `metadata-missing`. |
| Model-driven e2e | Agent usability of the surface | One turn: sync, exec in the stable cwd, edit, sync, report. Asserts the tool order, that the blocked `remote-dirty` path is understandable, and that the second sync transferred only changed bytes. |
| Benchmark (not a gate) | Performance claims | Fixtures in §14; results committed to `docs/verification.md` only with hardware and date. |

Rule: no grep test for a string; no mock in place of the real handler. Crash injection constructs the
state the code would leave, then calls the real recovery path — the same technique the push tests use
for symlink-swap windows.

## 20. Phased rollout

**Phase 0 — decide (this document).** Confirm D1–D13, especially the default-mode gate (D3), deletion
direction (D8), and the default cache protects (D7).

**Phase 1 — managed create/adopt, push-only convergence.** `sync(create, mode: "push")`; in-place
update of changed/added files; no deletions; no node→local; control directory, thin marker, lock,
journal, recovery, CAS, status fields, quota. Exit gate: a second sync of an unchanged tree writes
nothing and transfers nothing; a crash at each phase converges; caches are byte-identical after ten
syncs; adding an exclude pattern deletes nothing.

**Phase 2 — explicit pull/merge.** `remote-dirty`/`local-dirty` gates, the per-path table, tracked
deletions to trash, `dryRun`, `changes` redefined, `return` deprecated. Exit gate: the conflict matrix
in §19 passes at the in-process layer and in the two-process integration.

**Phase 3 — performance and operations.** Scan cache, batched renames, `verify: "full"`, retention
cleanup, `status` quota/reclaimable, Control UI states for `recovering`/`blocked`, benchmark results
in `docs/verification.md`. Only then evaluate block-level delta.

Each phase ships with its own tests and keeps generation tools working; no phase requires a data
migration beyond the explicit adopt step.

## 21. Open questions

1. **D8 default.** Node deletions are report-only in v1. A pure-mirror workflow would want them
   applied. Confirm report-only is acceptable, or make `pull` apply them to a local trash.
2. **Default cache protects.** The list in §7 is opinionated. Is a documented default acceptable, or
   should the first sync require an explicit `exclude` and fail with `exclude-required`?
3. **`node.stateRoot` default.** Should it be required in config, or default to
   `$XDG_STATE_HOME/openclaw-node-workspace` resolved by the node host? A default is convenient; a
   required value is one more thing to get wrong at install. Either way it must be rejected if it
   overlaps a pushRoot.
4. **Lock lease length and break policy.** Who may break a stale lock: any session with workspace
   access after lease expiry, or only an operator action? The proposal allows `recover: "abort"`; a
   conservative alternative requires a status-first manual step.
5. **Handle exposure.** `workspaceId` is output-only in v1. If operators later want a
   `status(workspaceId)` convenience, it must still re-derive authority from the resolved paths —
   confirm that is the intended bar.
6. **Multi-node fan-out.** One local project synced to several nodes is natural. Should `sync` accept
   a node list, or stay one call per node? The proposal stays one call per node to keep results and
   locks simple.
7. **Progress widget.** Add `blocked` (conflicts/dirty) and `recovering` states, or keep the widget to
   measured transfer only? A `blocked` terminal row with a reason code seems more useful than silence.
8. **Adoption of a foreign but identical tree.** `adopt` currently requires a complete plugin
   generation. Adopting an arbitrary directory would mean writing a marker and metadata for a tree the
   plugin did not create; the proposal refuses it. Confirm.

## 22. Evidence status

- This is a design document. **No benchmark, crash test, or node run was performed** for it.
  Performance statements are deductions from the current implementation and the measured
  `docs/verification.md` numbers for the generation model; they are not measurements of the proposal.
- The repository state inspected is `7014ee1`; `node_modules/` is not installed, so the OpenClaw
  plugin SDK surface beyond what `src/` already uses (tool context, `registerNodeHostCommand`,
  `openDuplex`, session actions, feature contracts) was **not** verified. Claims about a
  host-provided durable state directory are explicitly unverified; the node-owned state root is the
  design answer to that gap.
- Git worktree documentation and the rsync primary manual were reviewed as documentation (both
  HTTP 200 at review time); neither was installed, run, or benchmarked for this proposal, and
  `download.samba.org` returned 403.
- Protocol and marker compatibility claims are derived from `src/protocol.ts`, `src/manifest.ts`, and
  `src/node/fs-atomic.ts` as read in this revision, not from a mixed-version run.

## 23. Decision log

| ID | Decision |
| --- | --- |
| D1 | One stable node directory per project, updated in place; no generation chain for managed workspaces. |
| D2 | Base = the workspace's own committed manifest in a node-owned control directory; no session or gateway memory in identity. |
| D3 | Safe default is `mode: "push"`; a dirty remote blocks with `remote-dirty`; pull/merge are explicit. |
| D4 | Plan-level all-or-nothing; per-file atomic rename; no whole-tree atomicity claim. |
| D5 | Journal + trash outside the tree; roll forward by default; `recovery-incomplete` rather than silent cleanup. |
| D6 | `revision` + `treeDigest` + deterministic `txId` for CAS and idempotent retry; snapshots are hash-based. |
| D7 | Only tracked paths are read or written; caches are untracked with documented default protects and are never validated. |
| D8 | Local deletions propagate to node trash; node deletions are reported, never applied, in v1. |
| D9 | Conflicts and dirty peers are never forced; the plan digest is returned so resolution is one more call. |
| D10 | One new tool (`sync`) plus an extended `status`; `changes` = dry run; `return` deprecated; no execution endpoint. |
| D11 | Explicit `adopt` for an existing complete generation; foreign directories and unknown metadata are refused and never cleaned up. |
| D12 | No Git, rsync, hardlinks, overlays, archives, or block delta in v1. |
| D13 | Metadata is node-owned, outside every pushRoot; the opaque `workspaceId` is output-only and never grants authority. |

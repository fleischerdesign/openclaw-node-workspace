# Persistent source workspaces: consolidated decisions

Status: design only, 2026-11-20. This is the authoritative decision record for the accompanying
persistent-workspaces-proposal.md exploration. Where they differ, this record supersedes it.
No runtime implementation, tests or benchmarks are included.

## Recommended first release

Keep immutable push unchanged. Add a separate managed workspace operation: one stable node path,
a declared source set, a committed revision and preserved node-local caches. Initial mutation is
one-way Gateway-to-node. Do not ship general merge/pull or deprecate existing return in this release.
Node source edits block push unless they exactly converge with the selected local content.
There is no force/reset/clean flag. A later managed-return adapter needs independent local conflict
checks and its own recovery; there is no atomic transaction spanning Gateway and node.

Use the existing framed transport and file-level changes first. Git remains recommended for builds
from committed remote history; Git ref atomicity is not working-tree checkout atomicity. Scratch Git
refs/pack transfer and rsync adapters add integration and retention obligations, not just free delta.
Do not introduce another credential or SSH surface. Profile before adding block delta or a new backend.

## Source policy

Separate managed source, protected persistent subtrees, untracked entries and control data.
Exclude caches before traversal in every MANAGED source/status/return scan, not only transfer.
Legacy changes/return selection behavior remains unchanged. Persist an
inspectable policy, with presets rather than assuming every target/dist directory is disposable.
Include/exclude selection is not authority. Neither gitignore nor default patterns prove no secrets;
Default protected patterns (relative to project root, matching at any depth): .env, .env.*,
.npmrc, .pypirc, .netrc, .ssh/**, .aws/**, .gnupg/**, **/*.pem, **/*.key, and
**/id_rsa, **/id_ed25519. This intentionally also protects some harmless examples/configs. Overrides
require explicit exact-path exceptions plus a pinned preview. Preview/result expose protected path
counts and bounded private protectedPaths detail; never file contents or public progress filenames.
Preview the effective selected set before first publication.

Only previously managed, still-selected files absent locally can be deleted. Selection narrowing
releases management; it does not delete files. Persist provenance for released entries. Re-inclusion
requires explicit adoption/reconciliation, never silent overwrite. Incoming paths colliding with
untracked files block even when bytes match. Type changes cannot remove unmanaged descendants.
Source symlinks/special files are rejected initially; excluded dependency symlinks are not traversed.
A missing node path with local content equal to base is remote-dirty by default. A pinned preview
may explicitly authorize restore of those exact paths; it re-sends the local base content and reports
restored paths. This is not permission to discard changed node files. Other dirty-node reconciliation
remains an explicit reviewed retrieval/discard workflow.
Executable bits participate in diff. Full ownership, ACLs, hardlink topology and xattrs are not copied.

## Authority and ownership

Every call re-resolves the host calling-session workspace; configured roots only narrow it. Every
received path is independently checked on node. No cwd fallback and no id/plan grants access.
A node registry outside source binds random workspaceId to authenticated host identity where exposed,
canonical local project, actual remote directory identity, policy, revision and manifest. The exact
SDK identity fields need inspection before implementation; caller-supplied owner text is not proof.
New authorized sessions can reuse the binding; unrelated projects cannot attach by display name.
Ids are locators, not bearer credentials. Markers alone never authorize adoption or deletion.
Missing registry fails closed; same-UID hostile writes are outside the threat model.
Operator-only re-registration requires full source inspection, fresh ownership authorization and
explicit confirmation of selected base/policy. Mint a fresh epoch and invalidate old receipts/plans;
never infer old ownership from a marker. Preserve unknown/recovery data for manual resolution.
A moved local project can explicitly rebind under the same authenticated owner with a pinned preview
of both bindings, observed node revision/digest and policy. Record reboundFrom, invalidate prior
plans, and do not grant access to the old local path through the new binding.

## Concurrency and capture: honest limits

One plugin mutation per workspace, with atomic lock acquisition, process-start identity, operation id
and fencing against stale asynchronous handlers. Never steal a lock merely because TTL elapsed.
Unknown/live owners block; restart recovery checks actual node process state and durable journal.

Native exec does not join this lock. A compiler can READ a mixed source tree while writing only to
excluded caches. Therefore supported workflow is sync completes, build runs, build completes, next
sync. Separate concurrent jobs need explicit persistent slots or external orchestration; not -vN per
push. A build/run tool is not added. Enforced reader leases require actual exec integration later.

Per-file before/after stat and final checks detect many source races; they cannot prove a simultaneous
whole-tree snapshot. Strict reproducibility requires quiescence or a real VCS/filesystem/content
snapshot. Hash the captured bytes. Bound any local capture staging. Do not claim per-file reads
alone prove globally coherent source capture.

## Same-filesystem transaction layout

The global registry may be on a different device, but rename staging/backups must share the destination
filesystem. Resolve a node-controlled per-volume transaction area, bind it in the registry, check device
identity before apply, and exclude it from all source scans. Pin the transaction-area path, device
and inode in the registry; missing/replaced areas fail closed rather than silently selecting a new
area and orphaning backups. If no safe placement is available, refuse
managed creation. Do not place everything in an arbitrary stateRoot then promise atomic rename.
State-root selection must use inspected supported host/node state facilities, not invented SDK paths.

## Transaction and recovery contract

States: ready -> staging -> applying -> committing -> ready; failures expose interrupted or
recovery-blocked. Last committed revision is distinct from actual mixed working-tree readiness.
An unresolved journal overrides a ready marker: inspect/recover it before claiming readiness.
Fsync creation of transaction, staging and backup directories and all affected parent entries,
including the marker parent, not just files. A completed retained journal is distinguished from an
unresolved one using its durable commit/cleanup state.

1. Reauthorize, lock, recover prior transaction, validate revision/policy/plan and source fingerprints.
2. Stage/hash changed payloads; validate types/paths/limits on node. Check free space plus reserve for
   payload, backups, journal and metadata. statfs is a forecast, not space reservation.
3. Persist/fsync prepared journal and payloads; durably mark non-ready BEFORE project mutation.
4. Write-ahead per-path intent, preserve needed old data, install staged regular files with atomic
   same-device replacement. Backup-first move can leave a missing-name window; do not claim old-or-new
   visibility for that sequence. This backup-first rename sequence is the initial default; readers
   must be quiescent and recovery preserves tracked source bytes despite a possible missing name.
   Copy-before-atomic-replacement is deferred until a concrete requirement justifies its extra I/O.
   No hardlinks between mutable source generations.
5. Verify touched destinations; fsync data and affected directory entries; persist target manifest and
   authoritative commit identity AND operation receipt in one ordered fsynced commit step before
   exposing ready revision. This is not multi-file atomicity: the journal repairs any partially
   persisted commit group, including rolling the receipt forward. Reconcile registry/marker disagreement
   using journal/commit identity. Never infer success from the final rename alone.
6. Persist operation receipt independently of payload retention. Cleanup failure does not turn a
   committed update into failure. Never remove data still referenced by unresolved recovery.

Recovery checks before/after hashes and identities, skips completed steps, and rolls forward from
staged bytes. External drift stops recovery with exact affected paths and preserves backups. Never
restore over unknown newer data. No whole-tree atomicity or safe arbitrary concurrent exec claim.

## Idempotency

Use stable explicit operationId captured BEFORE apply. Store request fingerprint and durable outcome
under workspace + operationId. Different intent with same id is operation-mismatch. Also use revision
CAS and planDigest for source/precondition identity. Do NOT derive retry identity from the current
baseRevision: after commit it changes. A retry after later revisions returns its original receipt,
not a new operation. Old receipt proves historic commit, not current source cleanliness.

After possible effects, retain unknown-outcome. Status queries operationId and reports active,
committed, interrupted, rejected or unavailable. Resume same intent, never republish at another path
or replay via another surface. Default receipt retention is seven days, subject to a documented bounded quota that refuses new
work rather than silently evicts unexpired receipts. Expiry returns receipt-expired, never assumed
failure. Inspect current readiness/revision and resolve uncertainty before a new operationId; expiry
alone never authorizes replay. Cancellation after apply begins retains recovery data.

## Minimal tool/API contract

Add one sync tool; retain legacy push/changes/return/artifact contracts. Extend status for managed
readiness, last revision, policy, verification level, dirty summary, operation query and bounded owned
inventory. Metadata status is cheap but not a verified content scan.

Sync conceptual inputs: node, localPath, stable remotePath, operationId for apply, mode preview|apply,
optional create new|adopt, expectedRevision, planDigest, persisted policy and verification mode.
Exact schema is an implementation deliverable. Routine non-destructive updates can plan/apply under
one lock. Creation/adoption, policy transitions and deletions require a pinned preview. Stale preview
changes no source. A no-op does not bump revision. Never choose a new remotePath automatically.

Results include cwd, operationId, revision, committed/ready, bounded add/change/delete/conflict lists,
logical changed/transferred bytes, verification level and caches=preserved-not-validated. Paginate
large detail, keep summaries short. Errors have known-effect state and typed next action:
inspect, resume-same-operation, resolve-conflict, free-space or upgrade-peer. No raw removal advice.

## Performance and freshness

Unchanged files are not copied, rewritten or touched: preserve node mtime/inode. Initial strict
verification hashes selected source only; O(selected bytes) cannot be sold as metadata-only no-op.
Verification enum: full (selected source bytes hashed under the documented capture limits),
indexed (some hashes reused from stat identity), metadata-only (registry/operation state, no content
claim). committed is historical transaction state, not a verification level.
Indexed verification is a later opt-in optimization with size/device/inode/high-resolution mtime,
ctime and mode; it is weaker and reports indexed, never full. Hash transferred payloads regardless.
Do not use cached metadata alone for delete/recovery/authorization preconditions.

Changed files get node update times, not old sender times that might cause make-like tools to skip
changes. Unchanged files retain timestamps. Clock/coarse-timestamp and real compiler behavior require
tests. Preserved cache is not validated cache: dependency install and toolchain freshness belong to
the project command. Lockfile sync never claims dependencies are current.

Keep bounded buffers/workers, batches, streaming, backpressure. Align negotiated node/Gateway total
and idle budgets; fix the current hard five-minute node versus configurable Gateway mismatch.
Keep the node hard operation deadline within the Gateway deadline minus an explicit response/cleanup
grace, so a live node can report a typed timeout first. Gateway-side setup time is separately
budgeted; disconnection can still leave unknown-outcome.
Compression/block delta/reflinks/object stores are deferred until measured benefit justifies them.

Benchmark cold/no-op/1-10-100-file updates/deletes/recovery, many-small/few-large files, cache absent
versus large, real/slow link. Record p50/p95, scan/hash/apply/fsync time, bytes read/written/transferred,
RSS, peak disk and cold/warm Rust/JS builds. Publish environment/results; invent no speed targets.
Heavy tests/builds run on nodes, not the Gateway.

## Retention and migration

Steady disk: source + caches + bounded metadata. Peak also includes changed payloads and backups.
Only registry-bound unreferenced transaction data is auto-cleanable. Recovery pins payloads;
receipts have separate retention. No cache/workspace deletion by age, marker alone or raw glob.
Whole-workspace prune is a later previewed feature with identity and inactive-operation checks.

Explicit adoption previews selected source/base and unmanaged collisions. Existing Git checkouts or
foreign dirs are refused by default, never reset. Known complete legacy publication can migrate after
validated baseline establishment without copying away caches.

Use separate managed capability/commands/control format; preserve legacy protocol. New peers reject
cross-kind use. Old binaries cannot be assumed to inspect a new kind field, so mixed-version testing
must prove fail-closed behavior. If safe shared-path coexistence is not proven, require coordinated
upgrade before adoption. Managed return baselines must not contaminate legacy return state.

## Acceptance and delivery

Gate 1: policy/diff/identity/locks and strict scans; unit matrix for missing/add/edit/delete/mode,
released/reincluded paths, type ancestors, untracked conflicts, canonical plans and revision CAS.
Gate 2: real-handler journal/apply; inject crash at EVERY durable boundary, disk-full, truncation,
transport loss before/after commit, stale/live locks and late handlers. Include explicit restore of
node-absent base files, registry re-registration, project rebind, changed transaction-area identity,
secret-policy exceptions, journal-present/ready-marker disagreement and receipt crash ordering. Verify no loss of tracked source bytes,
the documented missing-name window, and bounded resume or explicit blocked recovery. Include receipt retry after commit/revision advance/expiry.
Gate 3: sync API/adoption/capability; real loader, isolated two-process tests, old/new peer rejection,
forged marker, changed host authority, symlink ancestors, secret-selection policy and registry loss.
Gate 4: real node canary: Rust/JS warm workspace survives repeated edits, exact source deletion,
lockfile change, failed build, node restart and interrupted sync. Verify actual files, not digest text.
Gate 5: profile before indexed mode, managed return, lifecycle cleanup or alternate delta backends.

Before coding: inspect SDK owner identity, persistent node-state support, same-volume transaction
placement, fencing implementation and capability negotiation. These are explicit integration gates,
not authority for an agent to guess. Correct current error guidance and timeout mismatch early.
No production cleanup, migration, config edit or benchmark has been performed for this design.

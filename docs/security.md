# Security

## What is enforced

- **Path authorization.** A Gateway push reads only inside `gateway.localRoots`; an artifact writes
  only inside `gateway.artifactRoots`; a return writes only inside `gateway.returnRoots`; a node push
  creates only below `node.pushRoots`; a node artifact reads only inside `node.artifactRoots`; a node
  tree or return reads only inside `node.returnRoots`. Roots are resolved with `realpath`; an empty
  list denies the operation.
- **The return base is local state, not a node claim.** The last successful return writes
  `.nodews-return-state.json` (0600) in the project with the node content it reconciled. A missing or
  malformed file falls back to the publication marker; neither grants an overwrite by itself.
- **A return is a previewed, conflict-checked plan.** `node_workspace_return` requires the
  `planDigest` from `node_workspace_changes` and re-derives the plan. A changed node tree or local
  tree is `plan-stale`; any local modification since the published base is `local-conflict`. Nothing
  is written in either case. Additions are created exclusively; modifications re-check the local
  digest immediately before an atomic replace; a failure rolls back files and directories this call
  created. No local file is ever deleted.
- **Returned bytes are staged first.** A return streams into a private `.nodews-return-<id>`
  directory inside the target project. Every file is verified by size and SHA-256 against the node's
  manifest, and the local tree is touched only after the node's `end` frame. A disconnect during the
  stream leaves no local change.
- **Destinations are new by an atomic claim.** The node claims the name with `mkdir(2)`, which
  fails for an existing file, symlink, or directory, including an empty directory that `rename(2)`
  would have replaced. A marker only allows an `already-applied` answer after the node re-hashes
  every file against the incoming manifest; it never authorizes a rename, overwrite, or delete.
- **No link following at the checked points.** Symlinks in a selected workspace are rejected or
  skipped, never followed. A symlink at the node's destination or at any artifact path is rejected,
  and a symlinked destination parent is rejected before resolution. The node re-checks every parent
  immediately before each write.
- **Residual same-user race.** Node has no `openat`/`O_NOFOLLOW`-across-components primitive, so a
  process running as the same user can replace a checked parent with a symlink in the gap between the
  check and `open`. The plugin detects that state in final verification and refuses success, but it
  cannot guarantee containment against a concurrent same-user attacker. Run node roots under an
  account and permissions that exclude such writers if that matters.
- **No implicit directory creation.** A push destination's parent must already exist inside a
  configured root. The plugin does not create a chain that could escape the operator's intent.
- **Traversal and name rules.** Manifest paths are relative, component-checked, length-bounded, and
  may not use the reserved marker name. Absolute paths, `..`, empty segments, and backslashes are
  rejected on both sides.
- **Independent verification.** The Gateway hashes what it sends; the node hashes what it receives
  and re-hashes the staged files before publication; the tree digest is recomputed on the node. A
  return is validated on the Gateway too: every path is component-checked, duplicates and missing
  parents are rejected, and the tree digest is recomputed from the received manifest before a plan
  is built or a byte is written. The
  artifact path is verified in both directions before the local file is created.
- **Exclusive artifact creation.** The Gateway destination is created with `link()` (or
  `COPYFILE_EXCL`), never by writing over an existing file. A concurrent creator wins and the fetch
  reports `destination-exists`.
- **Bounded work.** File count, per-file bytes, total bytes, artifact bytes, frame sizes, chunk sizes,
  and time limits are enforced by both sides. A peer cannot make the plugin buffer without bound.
  A return reuses the same limits for both the node tree and the local project.
- **Incremental reuse is re-verified on the node.** A base marker is not trusted for content: the
  node copies each reused file with `COPYFILE_EXCL` and re-hashes it against the incoming manifest.
  A base that drifted after the Gateway's verification fails with `destination-drifted`.
- **Explicit node authority.** The commands declare `dangerous: true`. OpenClaw requires a registered
  node-invoke policy, a command allowlist entry, and the node's own advertisement. Installing the
  Gateway plugin alone does not grant a node command.
- **No shell.** The plugin never spawns a process, never runs `rsync`, and never opens an SSH
  connection. Execution is left to the native `exec` tool and its own approval path.

## What is not claimed

- **This is not a sandbox.** A Gateway operator who can configure `localRoots` can publish any
  readable file below those roots. A node operator who can write the destination can also alter it
  after publication. Roots are an authorization policy, not mandatory access control.
- **No end-to-end signature.** Integrity is checked against transport and disk corruption and against
  a peer that makes mistakes. The node is a trusted endpoint; the plugin does not defend a node
  against its own operator, nor a Gateway against a malicious node that fabricates a consistent
  digest.
- **No confidentiality from the node.** Everything pushed is readable by the node's operating system
  account according to the file modes the plugin sets (0600, or 0700 for executable source files).
  The marker is 0600. An artifact never inherits group/other bits from the node: a remote 0777 is
  published locally as 0700, and any non-executable mode as 0600.
- **No preservation of ownership, ACLs, xattrs, hard links, or timestamps.** Only content and the
  executable bit are reproduced.
- **No protection against a hostile root.** If `pushRoots` contains a directory that an untrusted
  local user can replace with a symlink between the parent realpath check and the `mkdir` claim, local filesystem security
  is already lost. Configure roots under directories only the node's service account controls.
- **An incomplete publication is visible.** The destination appears before all files arrive and is
  marked `state: "incomplete"`. Consumers must not read it until the tool returns success or
  `node_workspace_status` reports `complete: true, verified: true`. The plugin does not hide a
  partial tree behind an atomic rename.
- **No Windows support.** The path rules and publication model are POSIX. A Windows node is not a
  supported target, and the command's `isAvailable` is not used to claim otherwise.
- **No deletion at all.** The plugin never removes a published directory or a file inside it, and a
  return never deletes a local file or a node file. Replacing content means publishing a new
  generation out of band.
- **A return's mode changes are owner-only.** A returned file is published as 0600, or 0700 when the
  node marked it executable. Group and other bits never cross.
- **Residual same-user race on return.** The local apply re-checks each parent, digest and
  destination immediately before writing, but Node has no `openat`/`renameat2`-with-expected-inode
  primitive. A process running as the same local user can still replace a checked parent between the
  check and the write. The conflict checks and rollback catch the common case, not a deliberate
  same-UID attacker. Run `returnRoots` under an account that excludes such writers when that
  matters.

## Attack and failure matrix

| Scenario | Result |
| --- | --- |
| Manifest path `../../etc/passwd` | `path-invalid` on the node; nothing written. |
| Absolute or backslash path in a forged hello | Rejected by the node's manifest validation. |
| Duplicate or missing parent directory entry | `invalid-manifest`. |
| Symlink inside the selected workspace | `symlink-rejected` (or omitted with `symlinks: "skip"`). |
| Symlinked push destination or parent | `symlink-rejected`. |
| Destination parent outside `pushRoots` | `path-outside-root`. |
| Destination exists, no marker | `destination-exists`; the directory is untouched. |
| Existing empty directory at the destination | `mkdir(2)` fails `EEXIST`; the directory stays empty. |
| Existing file at the destination | `mkdir(2)` fails `EEXIST`; the file is untouched. |
| Marker with wrong push id or digest | `destination-exists`; the directory is untouched. |
| Marker matches but a file changed | `destination-drifted`; the directory is untouched. |
| File created at the destination during transfer | Rename fails `destination-exists`; the new directory is untouched. |
| Bytes altered in transit | Per-file `integrity`; staging is removed and the destination is unchanged. |
| Staged file altered on disk before publication | Re-hash fails with `integrity`; staging is removed. |
| Peer sends more bytes than declared | `protocol`; staging is removed. |
| Peer stops responding after `accepted` | `unknown-outcome`; nothing is claimed either way. |
| Artifact destination already exists | `destination-exists` before any node read. |
| Artifact node path is a symlink | `symlink-rejected`. |
| Artifact bytes disagree with `done` digest | `integrity`; temporary file removed, destination absent. |
| Canceled push before acceptance | `canceled`; no effect. |
| Canceled push after acceptance | `unknown-outcome`; reconcile with status. |
| Incremental base modified after publication | `destination-drifted` before the new destination is claimed. |
| Incremental base is not a complete plugin publication | `conflict`; no destination is created. |
| Return plan used after the node tree changed | `plan-stale`; no local write. |
| Return plan used after a local file changed | `plan-stale` (plan digest) or `local-conflict` (re-check); no overwrite. |
| Local file differs from the published base and the node version | `local-conflict`; the file is untouched. |
| Node tree contains a symlink | `symlink-rejected` by `nodews.tree`; nothing is read. |
| Return destination already exists and the plan says add | `local-conflict`; nothing is overwritten. |
| Disconnect during a return stream | The staging directory is removed; no local file changes. |
| Failure while applying a verified return | Applied additions and replacements are rolled back; the error names rollback failures. |

## Operator guidance

- Keep roots narrow and specific. Never point a root at `/`, a home directory, or a path writable by
  an unrelated local user.
- Prefer `symlinks: "reject"`; use `"skip"` only when the tree's links are known and irrelevant.
- Keep the node command allowlist limited to the three `nodews.*` names and remove any entry you do
  not use.
- Treat `unknown-outcome` as a real state: inspect with status, then decide. Do not build automation
  that retries it without that check.

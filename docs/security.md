# Security

## What is enforced

- **Path authorization.** A Gateway push reads only inside `gateway.localRoots`; an artifact writes
  only inside `gateway.artifactRoots`; a node push creates only below `node.pushRoots`; a node
  artifact reads only inside `node.artifactRoots`. Roots are resolved with `realpath`; an empty list
  denies the operation.
- **Destinations are new.** A push refuses every existing destination. A marker only allows an
  `already-applied` answer after the node re-hashes every file against the incoming manifest; it
  never authorizes a rename, overwrite, or delete.
- **No link following.** Symlinks in a selected workspace are rejected or skipped, never followed.
  A symlink at the node's destination or at any artifact path is rejected. A symlinked destination
  parent is rejected before resolution.
- **No implicit directory creation.** A push destination's parent must already exist inside a
  configured root. The plugin does not create a chain that could escape the operator's intent.
- **Traversal and name rules.** Manifest paths are relative, component-checked, length-bounded, and
  may not use the reserved marker name. Absolute paths, `..`, empty segments, and backslashes are
  rejected on both sides.
- **Independent verification.** The Gateway hashes what it sends; the node hashes what it receives
  and re-hashes the staged files before publication; the tree digest is recomputed on the node. The
  artifact path is verified in both directions before the local file is created.
- **Exclusive artifact creation.** The Gateway destination is created with `link()` (or
  `COPYFILE_EXCL`), never by writing over an existing file. A concurrent creator wins and the fetch
  reports `destination-exists`.
- **Bounded work.** File count, per-file bytes, total bytes, artifact bytes, frame sizes, chunk sizes,
  and time limits are enforced by both sides. A peer cannot make the plugin buffer without bound.
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
  local user can replace with a symlink between the check and the rename, local filesystem security
  is already lost. Configure roots under directories only the node's service account controls.
- **No Windows support.** The path rules and publication model are POSIX. A Windows node is not a
  supported target, and the command's `isAvailable` is not used to claim otherwise.
- **No deletion at all.** The plugin never removes a published directory or a file inside it;
  replacing content means publishing to a new path out of band.

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

## Operator guidance

- Keep roots narrow and specific. Never point a root at `/`, a home directory, or a path writable by
  an unrelated local user.
- Prefer `symlinks: "reject"`; use `"skip"` only when the tree's links are known and irrelevant.
- Keep the node command allowlist limited to the three `nodews.*` names and remove any entry you do
  not use.
- Treat `unknown-outcome` as a real state: inspect with status, then decide. Do not build automation
  that retries it without that check.

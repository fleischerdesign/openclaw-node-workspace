# Security model

## Authority

- The **host session workspace** is the only local authority. `gateway.localRoots` and
  `gateway.artifactRoots` may narrow it; they can never widen it. A missing workspace fails closed;
  the process working directory is never used.
- Every path that crosses the channel is validated again on the node: absolute shape, relative
  manifest paths, parent declarations, reserved state directory, size/count limits and type.
- A `planDigest` or `revision` is a precondition, never an authorization token. Ids are locators.

## Ownership binding

The node keeps a registry outside the workspace at `<root>/.nodews-state/workspaces/<key>.json`. It
records the canonical remote path, canonical local project, the Gateway-asserted agent id, policy,
revision, manifest, released entries, epoch, state-directory identity pin and receipts.

**Trust boundary.** The inspected node command context exposes `sessionKey` and `signal`, but no
agent id (`OpenClawPluginNodeHostCommandContext`). The node command invocation policy context exposes
node id, client scopes/connection and config, again no agent id. Therefore:

- The agent id in a managed call is **asserted by the Gateway tool context** (`agentId` from the
  plugin tool factory), not attested by the node.
- The node records `owner.assertedBy = "gateway"` and rejects a missing assertion. When both the
  invocation context and the hello carry a session key, they must agree.
- A different asserted agent is `workspace-forbidden`; a status call without an asserted owner is
  `identity-unresolved`; inventory filters by the asserted owner and detail rejects another owner.
- This separates normal callers inside one authenticated Gateway. It is **not** protection against a
  malicious authorized Gateway, a locally forged node command, or a same-UID process; those are
  outside the threat model.
- Changing the bound local project needs an explicit `rebind` with a pinned preview; the epoch
  advances, receipts are invalidated, and the previous path is kept only as `reboundFrom` audit data.
- A marker-shaped file inside the tree is ordinary data. It never authorizes adoption, deletion or
  access. A missing registry on an existing directory requires explicit `adopt` with a preview.
- Inventory and status hide records owned by another agent when the caller's agent is known.

Same-UID hostile processes are outside the threat model. Native `exec` does not join the mutation
lock; it can read or write the tree concurrently, and the plugin does not claim otherwise.

## Secrets and caches

Default protected patterns (matched at any depth): `.env`, `.env.*`, `.npmrc`, `.pypirc`, `.netrc`,
`.ssh/**`, `.aws/**`, `.gnupg/**`, `**/*.pem`, `**/*.key`, `**/id_rsa`, `**/id_ed25519`. Protected
paths are counted, never hashed and never transferred. The defaults intentionally cover some harmless
examples; explicit `protect` patterns can add more.

`node_modules`, `target`, `.git` and the selected preset's cache directories are skipped before
`lstat`, so they are neither read nor moved. A preserved cache is not a validated cache; dependency
and toolchain freshness belong to the project's own install/build command.

Default protected patterns are a mitigation, not a proof that a tree contains no secrets. Exclusion
selection is not authority either. The first release does not implement exact protected-path
overrides: `protect` can only add patterns. There is no hidden bypass.

## Path safety

- The managed destination must be a child of a configured root and on the same device as that root.
- Parent directories must exist and be real; a symlinked parent is rejected.
- Source symlinks and special files abort the scan. Symlinks inside excluded caches are never
  traversed.
- Directory creation and replacement re-check every parent for symlinks. Node has no `openat`-style
  traversal primitive, so this narrows rather than eliminates the same-user race; the final tree scan
  and status drift report expose a changed result.

## Artifact fetch

The source must be an existing regular file inside `node.artifactRoots`, after `realpath`. The Gateway
destination must be inside the session workspace (narrowed by `gateway.artifactRoots`), must not
exist, and is published with an exclusive link/copy after the bytes match the node digest. Modes are
owner-only (`0600`, or `0700` when executable).

## Failure semantics

A stale workspace lock is never reclaimed automatically: without a compare-and-delete primitive, a
stale read followed by a rename can delete a newly created live lock. Dead locks fail closed with the
inspected pid and token; release is an explicit quiescent-node maintenance action that must name the
exact inspected token and pid and refuses a live or replaced lock.

A failure before any possible effect is a typed error. A failure after `end` may have committed; it
is `unknown-outcome` and must be resolved with `node_workspace_status` and the same `operationId`,
never replayed through another surface. A recovery that finds bytes matching neither the base nor the
target is `recovery-blocked` and preserves the backups for manual inspection.

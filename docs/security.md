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
records the canonical remote path, the canonical local project, the authenticated agent id, policy,
revision, manifest, released entries, epoch, state-directory identity pin and receipts.

- A workspace belongs to the agent identity the host supplies to the node command. A call whose
  authenticated agent differs is `workspace-forbidden`.
- A registry bound to an agent rejects a call that carries no authenticated identity.
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
selection is not authority either.

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

A failure before any possible effect is a typed error. A failure after `end` may have committed; it
is `unknown-outcome` and must be resolved with `node_workspace_status` and the same `operationId`,
never replayed through another surface. A recovery that finds bytes matching neither the base nor the
target is `recovery-blocked` and preserves the backups for manual inspection.

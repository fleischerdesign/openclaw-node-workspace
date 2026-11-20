# openclaw-node-workspace

Keep one durable source workspace on a paired OpenClaw node and update it in place.

The plugin is for the loop "edit locally, sync, build on the node, edit again". The node path stays
stable, so build caches (`node_modules`, `target`, …) survive, and the plugin tracks only a declared
source set.

## What it does

- **One stable managed directory** per project. No new generation per sync, no `rm -rf` to reclaim
  space.
- **In-place three-way diff** between the last committed base, the selected local source, and the
  node's current source.
- **Caches are preserved and never read.** `node_modules`, `target`, `.git` and preset cache paths are
  skipped before traversal.
- **Secret-like paths are protected by default** (`.env`, `.npmrc`, keys, `.ssh`, …). They are counted,
  never hashed and never transferred.
- **Node edits block a write.** A file that differs from the committed base is a conflict; nothing is
  silently overwritten or deleted.
- **Pinned previews for decisions.** Creation, adoption, deletion, restore, rebind, policy change and
  re-adoption require a plan digest from a preview.
- **Crash recovery.** A same-volume journal and backup area roll an interrupted transaction back, or a
  committed one forward, with `recovery-blocked` when external bytes make that unsafe.
- **Durable receipts.** A stable `operationId` makes a retry after an unknown outcome return the
  original outcome instead of applying twice.

## Tools

| Tool | Purpose |
| --- | --- |
| `node_workspace_sync` | Preview or apply one managed source update |
| `node_workspace_status` | Readiness, revision, policy, drift, operation receipt, owned inventory |
| `node_workspace_artifact` | Fetch one selected file back, exclusively |

Typical session:

```text
node_workspace_sync { mode: "preview", create: true, localPath, remotePath, policy: { preset: "node" } }
node_workspace_sync { mode: "apply", planDigest, operationId, localPath, remotePath, policy: { preset: "node" } }
exec { host: "node", workdir: <returned cwd>, command: "npm test" }
```

Later, after local edits:

```text
node_workspace_sync { localPath, remotePath, operationId: "<new stable id>" }
```

That routine apply is allowed without a preview only when it adds, changes or chmods files and has no
conflicts. Anything destructive or structural needs the pinned preview path.

## Configuration

Gateway (`gateway.localRoots`, `gateway.artifactRoots`) and node (`node.pushRoots`,
`node.artifactRoots`) roots can only narrow the host session workspace; they never widen it. The
managed destination must be a child of a node root on the same device.

See [docs/operations.md](docs/operations.md) for a full configuration example.

## Honest limits

- There is no whole-tree atomicity guarantee. A native reader outside the lock can observe a
  backup-first replacement's short missing-name window.
- Native `exec` does not join the mutation lock. A compiler may read while a sync runs; the supported
  workflow is sync → build → sync.
- Per-file before/after checks detect many source races but are not a global snapshot.
- Preserved caches are not validated caches; dependency freshness belongs to the project command.
- Only `full` and `metadata-only` verification are reported. `indexed` is not implemented.
- General merge/pull is not in this release. Artifact fetch is the only Gateway-directed retrieval.
- Source symlinks and special files are refused. Ownership, ACLs, xattrs and hardlink topology are not
  copied.

## Commands

```bash
npm ci
npm run typecheck
npm test
npm run build
bash scripts/pack-and-inspect.sh
bash scripts/integration-isolated.sh
bash scripts/e2e-model-driven.sh
```

The integration scripts use disposable state and a free port; they never touch live Gateway state.

## Docs

- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Security](docs/security.md)
- [Operations](docs/operations.md)
- [Verification](docs/verification.md)
- [Design decisions](docs/persistent-workspaces-decisions.md)
- [Design exploration (historical)](docs/persistent-workspaces-proposal.md)

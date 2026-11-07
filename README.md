# Node Workspace

An OpenClaw plugin that publishes **one explicitly selected directory** from a Gateway to a paired
node, incrementally reuses unchanged files from an earlier publication, and returns **changed or
generated project files** after a preview. It uses the public OpenClaw plugin SDK and the existing
node channel: no SSH, no rsync, no remote shell, and no second transport to secure.

The plugin is not a watcher or a mirror. A publish is a verified, no-clobber generation: the
destination name is claimed with `mkdir(2)` before any file is written, so an existing file or even
an empty directory can never be replaced. With `incrementalFrom`, only changed bytes cross the
channel; unchanged files are copied on the node from the previous generation, which is never
modified. The destination becomes visible while files are still arriving;
`node_workspace_status` reports `complete: false` until the marker is finalized.

A return is explicit and previewed. `node_workspace_changes` compares the node tree with the local
project and returns a plan digest. `node_workspace_return` applies exactly that plan, rejects a
changed plan, refuses local conflicts, stages and verifies every byte before writing, and never
deletes a local file because it disappeared on the node.

## What it does

| Tool | Effect |
| --- | --- |
| `node_workspace_push` | Scans a Gateway directory, sends it over a framed duplex node command, verifies every file by SHA-256, and claims a new destination with `mkdir(2)` before writing. Returns the canonical node id and the remote `cwd`. |
| `node_workspace_artifact` | Fetches one file from the node, verifies its SHA-256, and creates the Gateway destination exclusively. An existing file is never overwritten. |
| `node_workspace_status` | Read-only check of a node destination: present or absent, whether this plugin published it, and whether the bytes still match the published manifest. |
| `node_workspace_changes` | Read-only preview of a node directory against a local project: additions, safe modifications, mode changes, unchanged files, conflicts, and paths only on the node. Returns a `planDigest`. |
| `node_workspace_return` | Applies one previewed plan. Requires the `planDigest`; a stale plan or any conflict aborts before writing. Streams into a private staging directory, verifies digests, then applies with exclusive creates, re-checked atomic replaces, rollback, and owner-only modes. Files removed on the node are reported, never deleted. |

After a push the agent runs commands itself through the native `exec` tool with `host=node`. The
plugin does not proxy execution.

## What it does not do

- It does not watch, mirror, or delete. An incremental push publishes a new generation; an existing
  generation is never updated in place. A return never deletes a local file and never overwrites a
  local file that differs from the last published generation.
- It does not follow symlinks while scanning or resolving artifacts; node-side parent re-checks are
  best-effort against a concurrent same-user process, as described in Security. It does not preserve
  ownership, ACLs, xattrs, hard links, or timestamps, and it does not run on Windows nodes.
- It is not a sandbox. Configured roots are an authorization boundary, not a containment mechanism
  against a malicious Gateway operator or a compromised node.

See [Security](docs/security.md) for the precise claims and the remaining risks.

## Requirements

- OpenClaw `2026.11.1`, where these plugin APIs are experimental.
- Node `24.16` or newer on the Gateway and the paired node host.
- A POSIX node (Linux or macOS) for the node half.
- The plugin installed and enabled on **both** sides: Gateway for the tools, node host for the
  commands.

## Install

The package is private and has no license yet (see [Licensing](LICENSING.md)), so it is not
published to npm or ClawHub. Build a tarball and install that:

```bash
npm ci
npm run build
npm pack
```

On the Gateway and on the node host:

```bash
openclaw plugins install npm-pack:./fleischerdesign-openclaw-node-workspace-<version>.tgz \
  --accept-capabilities
openclaw plugins enable node-workspace
```

`--accept-capabilities` is required because the plugin registers agent tools and node commands. Read
the plugin source before consenting; the node commands are `nodews.push`, `nodews.fetch`,
`nodews.status`, `nodews.tree`, and `nodews.return`.

Restart the node host after installing or updating:

```bash
openclaw node restart
```

## Configure

Both halves read one config object; each uses its own namespace. A Gateway ignores `node.*`, and a
node ignores `gateway.*`, so the same block can be copied to both.

```json5
{
  plugins: {
    entries: {
      "node-workspace": {
        enabled: true,
        config: {
          gateway: {
            // A push may only read inside these real directories. Empty denies every push.
            localRoots: ["/srv/projects"],
            // An artifact may only be written inside these directories. Empty denies every fetch.
            artifactRoots: ["/srv/incoming"],
            // A returned project tree may only be written inside these directories. Empty denies every return.
            returnRoots: ["/srv/projects"],
            // minimatch patterns relative to the selected workspace root.
            exclude: [".git", "node_modules"],
            // "reject" fails on a symlink; "skip" omits it. Never follows links.
            symlinks: "reject",
            maxFiles: 2000,
            maxFileBytes: 33554432,
            maxTotalBytes: 268435456,
            maxArtifactBytes: 33554432,
            chunkBytes: 65536,
            timeoutMs: 120000,
          },
          node: {
            // A push may only create children of these real directories.
            pushRoots: ["/home/agent/work"],
            // An artifact may only be read inside these real directories.
            artifactRoots: ["/home/agent/work"],
            // A project tree may only be returned from these real directories.
            returnRoots: ["/home/agent/work"],
            maxFiles: 2000,
            maxFileBytes: 33554432,
            maxTotalBytes: 268435456,
            maxArtifactBytes: 33554432,
          },
        },
      },
    },
  },
  gateway: {
    nodes: {
      commands: {
        // Node commands are dangerous and are not allowlisted by default.
        allow: ["nodews.push", "nodews.fetch", "nodews.status", "nodews.tree", "nodews.return"],
      },
    },
  },
}
```

Set values with the CLI if you prefer:

```bash
openclaw config set plugins.entries.node-workspace.config.node.pushRoots '["/home/agent/work"]'
openclaw config set gateway.nodes.commands.allow '["nodews.push","nodews.fetch","nodews.status","nodews.tree","nodews.return"]'
```

Both sides must agree on the command names, and the node must advertise them. A command denied by
`gateway.nodes.commands.deny` stays denied even if it is also in `allow`.

## Progress accessory

The plugin can place a native accessory in the Control UI session header. It shows the measured
scanning, sending, publishing, receiving and applying counters for the current session, with a
determinate bar, and turns into a short completion, unknown-outcome or failure state. It is session-scoped: the query
uses the session key and agent id supplied by the host, and the broadcast carries no counters,
paths or node names. It does not use the shared progress card.

Native plugin UI is gated by the **Custom plugin UI** lab:

```json5
{
  gateway: {
    controlUi: {
      experimental: { customPlugins: true },
    },
  },
}
```

Enable it in **Settings → Labs → Custom plugin UI**, or with the config above. The Control UI must
be opened from the same Gateway over HTTPS or a browser-trusted loopback URL such as
`http://127.0.0.1:18789/`. Plain HTTP on a LAN address can serve the dashboard but cannot set the
secure cookies required for native plugin assets. Disabling the lab removes the accessory; it does
not uninstall the plugin or stop its backend operations.

## Use

```text
node_workspace_push(
  node: "hom-wrk-01",
  localPath: "/srv/projects/report",
  remotePath: "/home/agent/work/report"
)
```

Publishing a later generation reuses every unchanged file on the node:

```text
node_workspace_push(
  node: "hom-wrk-01",
  localPath: "/srv/projects/report",
  remotePath: "/home/agent/work/report-gen2",
  incrementalFrom: "/home/agent/work/report-gen1"
)
```

Only changed bytes use the channel. The result reports `reusedFiles`, `reusedBytes`, and
`transferredBytes`; the base directory is never modified.

The result names the node id and `cwd`, for example:

> published: 42 files (1.83 MiB) at /home/agent/work/report on node hom-wrk-01. sha256 tree digest
> 6f1c… One-way copy; later Gateway changes are not synchronized. Run commands there with the exec
> tool: host=node, node=hom-wrk-01, workdir=/home/agent/work/report.

`remotePath` must not exist. If an identical earlier push is still there, the node re-hashes every
file and reports `already-applied`; any difference is `destination-exists` or `destination-drifted`,
and the existing directory is left untouched. Entries omitted by `symlinks: "skip"` or an exclude
pattern are returned in `details.skippedPaths`, not silently dropped.

Progress is reported per tool as a phase plus file and byte counts (`scanning`, `sending`,
`publishing`); no file paths or contents enter progress text.

Fetching a produced artifact:

```text
node_workspace_artifact(
  node: "hom-wrk-01",
  remotePath: "/home/agent/work/report/result.json",
  localPath: "/srv/incoming/result.json"
)
```

The destination must not exist. The bytes are verified before they are published under that name.

Returning files a command generated on the node:

```text
node_workspace_changes(
  node: "hom-wrk-01",
  remotePath: "/home/agent/work/report-gen2",
  localPath: "/srv/projects/report"
)
# then, with the returned planDigest:
node_workspace_return(
  node: "hom-wrk-01",
  remotePath: "/home/agent/work/report-gen2",
  localPath: "/srv/projects/report",
  planDigest: "<64 hex characters>"
)
```

The preview writes nothing. Apply refuses a changed node tree, a changed local tree, or any local
conflict. Additions are exclusive, modifications only replace a file that still matches the last
published generation, and paths that exist only on the node are reported rather than deleted.

## Failure semantics

A failed tool returns a structured result instead of throwing: `details.ok` is `false`, with
`code`, `message`, and `unknownOutcome`; the model-visible text also names the code. This survives
the Gateway `tools.invoke` boundary, which would otherwise flatten a thrown error into
`internal_error`. The important distinction is whether the effect may have happened.

| Code | Meaning |
| --- | --- |
| `config-invalid` | Plugin config is missing or contradictory; nothing was dispatched. |
| `path-invalid`, `path-outside-root`, `path-not-found`, `not-a-directory` | Path rejected before transfer. |
| `symlink-rejected`, `special-file-rejected` | The selected tree contains a link or non-regular file and the policy is not `skip`. |
| `limit-exceeded` | File count or byte limits rejected the operation before publication. |
| `destination-exists` | The destination exists with different content. This plugin never replaces an existing directory. |
| `destination-drifted` | A previous push marker matches, but the node copy no longer matches its manifest. |
| `node-rejected` | The node returned a coded rejection; nothing was published. |
| `protocol` | A frame was malformed or out of order. The operation failed; nothing was published. |
| `integrity` | A digest or byte count disagreed. Treat the copy as invalid. |
| `transport`, `timeout`, `canceled` | The channel failed **before** the node accepted the push; no effect. |
| `unknown-outcome` | The channel failed **after** the node claimed the destination. The plugin cannot prove whether publication completed. |
| `conflict` | A node name is ambiguous, or an incremental base is not a complete, verified plugin publication. |
| `plan-stale` | The previewed node tree or local project changed; request a new preview. Nothing was written. |
| `local-conflict` | A returned change would overwrite a locally modified file or a non-regular path. Nothing was written. |

A failed return before the node's `end` frame leaves no local change: every byte is staged and
verified first. A failure during the short local apply rolls back the files and directories that
call created; if rollback itself fails, the error names the paths. Request a fresh preview rather
than reusing an old `planDigest`.

A failed push may leave an incomplete destination: `mkdir(2)` has already claimed the name. Call
`node_workspace_status`; it reports `complete: false` and `verified: false`. Remove that directory
yourself after confirming no push is running; the plugin never recursively deletes a partial tree.

`unknown-outcome` never claims failure. Do not retry it blindly: call `node_workspace_status` with
the same `remotePath` first. A retry of the same content to the same destination derives the same
push id, so if the first attempt did publish, the node re-verifies every byte and reports
`already-applied`; if the content changed on the node it reports `destination-drifted` instead.
An occupied destination with different content is never replaced.

See [Operations](docs/operations.md) for the full runbook.

## Development

```bash
npm ci
npm run typecheck
npm test                 # unit + in-process transport tests
npm run build
bash scripts/pack-and-inspect.sh        # real plugin loader, isolated disposable state
bash scripts/integration-isolated.sh    # isolated Gateway + node host on a free port
bash scripts/e2e-model-driven.sh        # scripted model turns the real agent tool path
```

The integration scripts refuse to use the live state directory: they set
`OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and `HOME` under a temporary directory and clear
`OPENCLAW_NIX_MODE` only for that disposable process. `e2e-model-driven.sh` additionally serves an
OpenAI-compatible endpoint whose decisions are a fixed script (`scripts/model-stub.mjs`); that
stub is a test double for the model, not a model.

## Documentation

- [Architecture](docs/architecture.md) — the two halves, the framing protocol, and publication.
- [Protocol](docs/protocol.md) — every frame, limit, and timeout.
- [Security](docs/security.md) — threat model, non-goals, and residual risks.
- [Operations](docs/operations.md) — setup, reconciliation, and troubleshooting.
- [Verification](docs/verification.md) — what was actually run and what remains unproven.
- [Licensing](LICENSING.md) — an open decision, not a chosen license.

## Licensing

**No license has been chosen.** The package is marked private and no permission is granted until
the repository owner selects a license. Contributions are not accepted. See [LICENSING.md](LICENSING.md).

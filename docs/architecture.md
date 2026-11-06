# Architecture

## One package, two hosts

`node-workspace` is a single plugin entry, loaded by both OpenClaw hosts:

- The **Gateway** registers three agent tools, a node-invoke policy, and the transport adapter over
  `api.runtime.nodes`.
- The **node host** registers three duplex node commands that perform all filesystem work.

Both registration paths run in both processes. That is intentional and harmless: a node has no
agent tool surface, and a Gateway has no node command surface. The authority boundary is the OpenClaw
node channel, not which process loaded a module.

```
agent
  │  node_workspace_push
  ▼
Gateway tool ──► policy + allowlist ──► openDuplex("nodews.push")
  │                                             │
  │  framed duplex (control + file chunks)      │
  ▼                                             ▼
node command "nodews.push" ──► staging dir ──► verify ──► rename ──► destination
                                                              │
agent ◄── nodeId + cwd + digest ──────────────────────────────┘
  │
  └─ native exec: host=node, workdir=<cwd>
```

The plugin never executes a shell command and never opens an SSH connection. Execution stays with
the native `exec` tool, which retains its own approvals and node allowlists.

## Components

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Entry point; registers tools, node commands, and the invoke policy. |
| `src/config.ts` | Fail-closed config validation with explicit defaults. |
| `src/manifest.ts` | Deterministic scan of one selected directory; independent manifest validation. |
| `src/digest.ts` | Canonical manifest bytes, tree digest, content-derived push id. |
| `src/paths.ts` | Absolute-path, relative-path, traversal, and marker-name rules. |
| `src/frames.ts` | Binary frame codec (one control byte + JSON or file bytes). |
| `src/transport.ts` | `FrameSession`: ordered frame queue, timeouts, closure semantics. |
| `src/gateway/*` | Tool definitions, push/artifact/status engines, runtime adapter. |
| `src/node/*` | Node command handlers and atomic filesystem helpers. |

## Why a framed duplex command

A single JSON `nodes.invoke` payload would have to carry the whole workspace inline and is bounded by
message size. `openDuplex` is the public SDK transport for complete binary messages, and the node
command receives them through `io.frames`. The plugin uses it for both directions, with an explicit
protocol rather than an archive:

- no tar parsing, so no archive traversal or member-name ambiguity;
- one file at a time, acknowledged by the receiver, so backpressure is implicit;
- every file's SHA-256 crosses the wire and is recomputed on the receiving side;
- progress frames are available while the file stream is active.

## Push lifecycle

1. **Authorize and scan (Gateway).** `localPath` must be absolute, resolve inside a configured
   `gateway.localRoots` entry, and be a real directory. The scan records every directory, every
   regular file's SHA-256, size, and executable bit. Symlinks and special files fail the scan by
   default. The tree digest is the SHA-256 of the canonical manifest JSON.
2. **Derive the push id.** `pushId = SHA-256(nodeId + "\n" + remotePath + "\n" + treeDigest)[0..32]`.
   Same content to the same destination is idempotent; different content is not.
3. **Open the channel.** `openDuplex` with `nodews.push`, an idempotency key equal to the push id,
   the configured timeout, and the caller's abort signal.
4. **Negotiate.** The Gateway sends `hello` with the manifest, directories, total bytes, and digest.
   The node validates the protocol version, every path, limits, destination parent, and replace
   eligibility before accepting. A rejection is a coded `rejected` frame.
5. **Transfer.** For each file the Gateway sends a `file` header and then exactly `size` bytes in
   `chunkBytes` chunks. The node writes into a private staging directory and acknowledges each file
   with `file-ok` only after the digest matches.
6. **Verify and publish.** On `end` the node checks that every manifest file arrived, re-hashes the
   staged files from disk, recomputes the tree digest, writes the marker, fsyncs, and renames the
   staging directory into place. For a replacement it renames the old directory aside first and
   restores it if the swap fails.
7. **Confirm.** The node sends `result` with the digest, file count, byte count, and whether it
   replaced a previous copy. The Gateway compares these against what it scanned before returning.

Publication is a single `rename` on the same filesystem. A reader sees either no destination or the
complete tree, never a partial copy.

## Artifact lifecycle

1. The Gateway validates `localPath` inside `gateway.artifactRoots`, requires the parent to be a real
   directory, and requires the destination not to exist.
2. `nodews.fetch` receives the request as command parameters. The node resolves the source with
   `lstat` + `realpath`, rejects symlinks and non-regular files, and enforces the artifact boundaries
   and size limits.
3. The node sends `meta`, then file chunks, then `done` with the SHA-256 and byte count.
4. The Gateway writes to a temporary file in the destination directory. After the digest and size
   match, it publishes with `link()` (atomic exclusive create) and unlinks the temporary file. On
   filesystems without hard links it falls back to `copyFile(..., COPYFILE_EXCL)`. `EEXIST` is always
   reported as `destination-exists`; the existing file is untouched.

## Marker and ownership

Every published directory contains `.openclaw-node-workspace.json`:

```json
{
  "plugin": "node-workspace",
  "protocol": 1,
  "pushId": "…",
  "digest": "…",
  "files": 42,
  "bytes": 1912345,
  "createdAt": "2026-11-06T19:00:00.000Z"
}
```

The marker is how a later `replace=true` proves the directory belongs to this plugin, and how status
reports ownership. A directory without a valid marker is never replaced or deleted. The marker name
is reserved in manifests, so a user file cannot impersonate it.

The marker is not a signature. Anyone who can write the node destination can create one; the security
model treats the node as an endpoint, not as an untrusted peer defending against its own operator.

## What is deliberately absent

- No incremental transfer or delta protocol. Every push sends the selected tree.
- No delete propagation. Removing a file on the Gateway and pushing again with `replace=true` yields
  a destination that matches the new scan; that is the only deletion-like operation, and it replaces
  the whole owned directory.
- No Rust sidecar or native helper. The plugin runs inside Node on both sides, and a second toolchain
  would add build and packaging surface without changing a filesystem operation that Node already
  performs.

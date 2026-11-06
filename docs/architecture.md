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
node command "nodews.push" ──► mkdir claim ──► write+verify ──► finalize marker ──► destination
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
| `src/node/*` | Node command handlers and no-clobber filesystem helpers. |

The commands declare `hasActiveWork: () => false` because all work is confined to `handle()`. The
node host separately tracks in-flight invocations, so this does not claim idleness while a call is
running; it only states that no background job survives the handler.

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
4. **Claim and negotiate.** The Gateway sends `hello` with the manifest, directories, total bytes,
   and digest. The node validates protocol version 2, every path, limits, and the destination
   parent. It then claims the destination with `mkdir(2)`: an existing file, symlink, or directory
   (including an empty one) makes that call fail with `EEXIST`, so nothing is ever replaced. Only
   after the claim does it write an `incomplete` marker and accept.
5. **Transfer.** For each file the Gateway sends a `file` header and then exactly `size` bytes in
   `chunkBytes` chunks. The node writes directly into the claimed directory, creating files with
   `O_EXCL`/`wx`, and acknowledges each file only after its digest matches.
6. **Verify and finalize.** On `end` the node checks that every manifest file arrived, re-hashes the
   tree from disk, recomputes the tree digest, atomically replaces the marker with
   `state: "complete"`, fsyncs every directory, and only then acknowledges success.
7. **Confirm.** The node fsyncs the destination parent, then sends `result` with the digest, file
   count, and byte count. The Gateway compares these against what it scanned before returning.

The destination name is never renamed over: `mkdir(2)` is the no-clobber primitive. The trade-off
is visibility: the claimed directory appears before its files finish arriving. A reader can see an
incomplete publication; the marker's `state` and `node_workspace_status` make that explicit.

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
  "createdAt": "2026-11-06T19:00:00.000Z",
  "state": "complete",
  "manifest": [{ "path": "a.txt", "size": 5, "sha256": "…", "executable": false }],
  "directories": []
}
```

The marker records ownership, lifecycle state, and the manifest of the published tree. It is written
as `incomplete` at claim time and atomically replaced with `complete` at the end. Status re-hashes
the directory against the manifest and reports `complete`, `verified`, or the drift reason; a
matching marker alone is never reported as success. Legacy markers without a state or manifest are
reported as owned but unverifiable. The marker name is reserved in manifests.

The marker is not a signature. Anyone who can write the node destination can edit both the files and
the marker. Verification detects accidental drift and stale copies; it does not defend a Gateway
against a node operator who deliberately fabricates a consistent tree.

## What is deliberately absent

- No incremental transfer or delta protocol. Every push sends the selected tree.
- No replace and no delete. A destination must be new; updating means publishing to a new path and
  retiring the old one yourself. This removes the destructive swap window entirely.
- No Rust sidecar or native helper. The plugin runs inside Node on both sides, and a second toolchain
  would add build and packaging surface without changing a filesystem operation that Node already
  performs.

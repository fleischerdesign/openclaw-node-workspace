# Protocol

The channel is `api.runtime.nodes.openDuplex()` on the Gateway and `registerNodeHostCommand({ duplex: true })`
on the node. Every message is a complete `Uint8Array`; the plugin supplies its own one-byte frame
type inside it.

## Frames

| Byte | Kind | Body |
| --- | --- | --- |
| `0x01` | data | raw file bytes, 1 byte to 1 MiB |
| `0x02` | control | UTF-8 JSON object, at most 8 MiB |

A data frame is never empty. Control frames are parsed as JSON and must be objects. Unknown frame
types, invalid JSON, oversized control frames, and empty data frames are protocol errors and fail the
operation.

The Gateway accepts at most 512 unread frames (small progress frames); a peer that streams without reading is failed rather
than buffered without bound.

## Push: Gateway → node

| Message | Direction | Fields |
| --- | --- | --- |
| `hello` | G→N | `protocol: 3`, `pushId`, `remotePath`, `totalBytes`, `treeDigest`, `manifest[]`, `directories[]`, optional `base`, optional `reuse[]` |
| `accepted` | N→G | `pushId` |
| `rejected` | N→G | `code`, `message` |
| `progress` | N→G | `phase`, `filesDone`, `bytesDone` |
| `file` | G→N | `path` |
| *data frames* | G→N | exactly the manifest entry's `size` bytes |
| `file-ok` | N→G | `path`, `bytes`, `sha256` |
| `file-error` | N→G | `path`, `code`, `message` |
| `end` | G→N | — |
| `result` (ok) | N→G | `pushId`, `digest`, `files`, `bytes` |
| `result` (error) | N→G | `code`, `message`, `published`, `partial` |

Manifest entries are `{ path, size, sha256, executable }`, where `path` is relative POSIX, `sha256`
is lowercase hex, and `executable` records whether any owner execute bit was set. Directories are
relative POSIX paths and include empty directories.

`base` is `{ remotePath, digest }` and `reuse` is a list of manifest file paths. Both are absent
from a full publish. When present, every reuse path must be a manifest file, unique, and present in
the base publication with identical size, SHA-256, and executable bit. The base must be a different,
complete, plugin-owned directory. The node copies those files locally after claiming the destination
and verifies each copy; only the remaining manifest entries are sent as file frames.

Before `accepted`, the node claims the destination with `mkdir(2)`, writes an `incomplete` marker,
and only then accepts. An existing file, symlink, or directory (including an empty directory)
fails the claim with `EEXIST`; the node never renames over a destination. Files are sent in manifest
order. The node enforces that order, so an out-of-order or duplicated `file` header is a protocol
error. The Gateway waits for `file-ok` before sending the next header. The destination is visible
while files arrive; the marker state distinguishes incomplete from complete.

### Validation on the node

Before accepting, the node independently checks:

- `protocol` is exactly `3`; `pushId` is 16–64 lowercase hex; `treeDigest` is 64 lowercase hex;
- entry count and byte totals against its own limits;
- every path against the traversal, empty-segment, absolute, backslash, length, and reserved-marker
  rules;
- no duplicate file/directory path, every file has a declared parent directory, and
  `totalBytes` equals the manifest sum;
- `remotePath` is normalized and absolute, its parent exists, is a real directory, and resolves
  inside a configured `node.pushRoots` entry;
- the destination is absent (the node will claim it), or it already has a complete marker for the same push id and digest
  and every byte re-hashes to the manifest. Different content is never replaced;
- for an incremental publish, the base is a different real directory inside `node.pushRoots`, has a
  complete marker whose digest equals `base.digest`, and every reuse entry matches the base
  manifest. Every reused file is still re-hashed after the local copy.

Nothing is written before these checks pass.

### Idempotency

`pushId` is content-derived, not random:

```
pushId = sha256(nodeId + "\n" + remotePath + "\n" + treeDigest)[0..32]
```

A repeated identical push finds the marker, re-hashes the destination against the manifest, and
returns `result` with the same digest without writing. Modified content fails `destination-drifted`.
A different manifest produces a different push id, so the occupied destination is a conflict, not a
silent overwrite.

## Fetch: Gateway → node

The request is ordinary command JSON, since it is small:
`{ remotePath, maxBytes }`.

| Message | Direction | Fields |
| --- | --- | --- |
| `meta` | N→G | `size`, `sha256: null`, `mode` |
| *data frames* | N→G | exactly `size` bytes |
| `done` | N→G | `sha256`, `bytes` |
| `rejected` | N→G | `code`, `message`, before any data |
| `fetch-error` | N→G | `code`, `message`, after `meta` |

The hash is computed while streaming and carried in `done`. The Gateway writes to a temporary file,
requires the announced size, and compares the digest. The destination appears only after both match.

## Tree: node directory manifest

`nodews.tree` is a unary command. Parameters `{ remotePath, exclude? }`. The directory must exist, be
a real directory inside `node.returnRoots`, and contain no symlink or special file. `exclude` is an
optional array of minimatch patterns applied before the node's limits; the Gateway sends the same
list and re-applies it locally. The response is JSON:

```
{ ok: true, remotePath, directory, files[], directories[], totalBytes, treeDigest,
  owned, complete, verified, drift, marker }
```

`files` uses the manifest entry shape. `marker` is the plugin marker or `null`; `verified` is true
only when the live scan matches the marker manifest byte for byte. The Gateway validates every
returned path independently, re-derives the tree digest from the received manifest, and rejects a
path with a traversal segment, a duplicate, a missing parent directory, or a digest that does not
match. A compromised node therefore cannot redirect a return outside `gateway.returnRoots`. A changed generated tree is
normally `verified: false` while its marker still supplies the base manifest for conflict decisions.
This command is read-only and bounded by the node limits.

## Return: node → Gateway

`nodews.return` is a duplex command. The Gateway sends one control frame:

| Message | Direction | Fields |
| --- | --- | --- |
| `hello` | G→N | `protocol: 3`, `remotePath`, `paths[]`, `treeDigest`, `planDigest`, `exclude[]` |
| `accepted` | N→G | `treeDigest` |
| `file` | N→G | `path`, `size`, `sha256`, `executable` |
| *data frames* | N→G | exactly the announced bytes |
| `end` | N→G | `treeDigest`, `files`, `bytes` |
| `rejected` | N→G | `code`, `message`, before acceptance |
| `return-error` | N→G | `code`, `message`, after acceptance |

`paths` must be unique, sorted in byte order, and present in the freshly scanned tree. `exclude`
must match the list used by `nodews.tree`; the node applies it before recomputing `treeDigest`. The node
re-scans before accepting: a `treeDigest` that differs from the preview fails with `plan-stale`.
Each file is hashed while streaming; a file that changes during the read fails the transfer. The
node never writes, renames, or deletes anything.

The Gateway stages every file in a private directory, verifies size and SHA-256, requires `end`, and
only then applies the plan locally. A disconnect before `end` therefore changes no local file.

## Status

`nodews.status` is a unary command. Parameters: `{ remotePath }`. Response: a JSON string with
`exists`, `parentExists`, and for a directory `owned`, `complete`, `verified`, `drift`, and `marker`
(or `null`).

## Limits and timeouts

| Limit | Default | Enforced by |
| --- | --- | --- |
| Files + directories per push | 2000 | Gateway scan and node manifest check |
| File size | 32 MiB | both |
| Total push size | 256 MiB | both |
| Artifact size | 32 MiB | both |
| Data chunk | 64 KiB (max 1 MiB) | Gateway sender |
| Duplex message | OpenClaw default (100 MiB ceiling) | SDK |
| Control frame | 8 MiB | both |
| Marker | 4 MiB | node, manifest checked before claim |
| Whole operation | `timeoutMs` (default 120 s) | Gateway, absolute deadline |
| Per-frame wait | min(120 s, remaining deadline) | Gateway and node |
| Node operation | 300 s absolute | node |

A timeout before `accepted` means nothing was published; a claim that failed mid-write is cleaned
up when it is empty or contains only the incomplete marker. A timeout after `accepted` is reported as
`unknown-outcome`; see [Operations](operations.md).

## Compatibility

Protocol version `3` is the only version. Both sides must run the same plugin major version; the
node rejects any other `protocol` value rather than guessing. OpenClaw plugin APIs are experimental,
so pin the OpenClaw version and test both hosts on upgrade.

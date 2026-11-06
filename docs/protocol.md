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
| `hello` | G→N | `protocol: 1`, `pushId`, `remotePath`, `replace`, `totalBytes`, `treeDigest`, `manifest[]`, `directories[]` |
| `accepted` | N→G | `pushId` |
| `rejected` | N→G | `code`, `message` |
| `progress` | N→G | `phase`, `filesDone`, `bytesDone` |
| `file` | G→N | `path` |
| *data frames* | G→N | exactly the manifest entry's `size` bytes |
| `file-ok` | N→G | `path`, `bytes`, `sha256` |
| `file-error` | N→G | `path`, `code`, `message` |
| `end` | G→N | — |
| `result` (ok) | N→G | `pushId`, `digest`, `files`, `bytes`, `replaced` |
| `result` (error) | N→G | `code`, `message`, `published` |

Manifest entries are `{ path, size, sha256, executable }`, where `path` is relative POSIX, `sha256`
is lowercase hex, and `executable` records whether any owner execute bit was set. Directories are
relative POSIX paths and include empty directories.

Files are sent in manifest order. The node enforces that order, so an out-of-order or duplicated
`file` header is a protocol error. The Gateway waits for `file-ok` before sending the next header.

### Validation on the node

Before accepting, the node independently checks:

- `protocol` is exactly `1`; `pushId` is 16–64 lowercase hex; `treeDigest` is 64 lowercase hex;
- entry count and byte totals against its own limits;
- every path against the traversal, empty-segment, absolute, backslash, length, and reserved-marker
  rules;
- no duplicate file/directory path, every file has a declared parent directory, and
  `totalBytes` equals the manifest sum;
- `remotePath` is normalized and absolute, its parent exists, is a real directory, and resolves
  inside a configured `node.pushRoots` entry;
- the destination is absent, already has this plugin's marker for the same push id and digest, or is
  an owned directory with `replace=true`.

Nothing is written before these checks pass.

### Idempotency

`pushId` is content-derived, not random:

```
pushId = sha256(nodeId + "\n" + remotePath + "\n" + treeDigest)[0..32]
```

A repeated identical push finds the marker and returns `result` with the same digest without writing.
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

## Status

`nodews.status` is a unary command. Parameters: `{ remotePath }`. Response: a JSON string with
`exists`, `parentExists`, and for a directory `owned` plus `marker` (or `null`).

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
| Whole operation | 120 s | Gateway |
| Control wait | 120 s or remaining deadline | Gateway |
| Control wait on node | 120 s | node |

A timeout before `accepted` means nothing was published. A timeout after `accepted` is reported as
`unknown-outcome`; see [Operations](operations.md).

## Compatibility

Protocol version `1` is the only version. Both sides must run the same plugin major version; the
node rejects any other `protocol` value rather than guessing. OpenClaw plugin APIs are experimental,
so pin the OpenClaw version and test both hosts on upgrade.

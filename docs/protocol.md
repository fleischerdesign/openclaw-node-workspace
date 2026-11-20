# Frame protocol

`PROTOCOL_VERSION = 5`. Frames are one byte of kind followed by either raw file bytes (kind 1) or a
JSON control object (kind 2). The protocol is flat on purpose: no archive format is added.

## Commands

- `nodews.sync` — duplex, `dangerous`
- `nodews.status` — request/response, `dangerous`
- `nodews.fetch` — duplex, `dangerous`

The plugin registers exactly these commands and one invoke policy. It has no generic `run` or `exec`
command.

## Sync hello (Gateway to node)

```jsonc
{
  "t": "hello",
  "protocol": 5,
  "mode": "preview" | "apply",
  "operationId": "32 lowercase hex",
  "nodeId": "resolved node id",
  "owner": { "agentId": "…|null", "sessionKey": "…|null" },
  "localProject": "/absolute/gateway/project",
  "remotePath": "/absolute/node/workspace",
  "policy": { "preset": "none|node|rust", "include": [], "exclude": [], "protect": [] },
  "create": true,
  "adopt": false,
  "adoptPaths": [],
  "restore": [],
  "rebind": false,
  "expectedRevision": 3,
  "planDigest": "64 hex",
  "timeoutMs": 120000,
  "manifest": [{ "path": "src/a.ts", "size": 1, "sha256": "…", "executable": false }],
  "directories": ["src"]
}
```

`expectedRevision` and `planDigest` are optional. `manifest` and `directories` describe the selected
*local source only*; caches and protected paths never appear. The node independently validates every
path, parent declaration, duplicate, count and byte limit.

## Node plan (node to Gateway)

```jsonc
{
  "t": "plan",
  "planDigest": "64 hex",
  "baseRevision": 3,
  "counts": { "add": 1, "change": 0, "delete": 0, "mode": 0, "restore": 0, "adopt": 0,
              "conflicts": 0, "unchanged": 4, "untracked": 0, "released": 0 },
  "entries": [{ "kind": "add|change|delete|mode|restore|adopt", "path": "…", "before": null, "after": {…} }],
  "directories": ["src"],
  "restorable": [],
  "conflicts": [{ "path": "…", "reason": "node-modified" }],
  "createRequired": false,
  "adoptRequired": false,
  "policyChanged": false,
  "safeForRoutine": true,
  "policy": { "preset": "none", "include": [], "exclude": [], "protect": [] }
}
```

A preview sends the plan and then a `result`. An apply sends the plan and waits for exactly the
payload entries (`add`, `change`, `restore`). `adopt` verifies existing equal bytes and only adds
them to the committed base; it transfers nothing.

## Payload frames (Gateway to node)

- `{ "t": "file", "path": "src/a.ts" }` followed by data frames until the declared size.
- `{ "t": "batch", "files": n, "bytes": b }` requests an acknowledgement window.
- `{ "t": "end" }` after the last payload. The node commits only after `end`.

The node acknowledges with `{ "t": "files-ok", "files": [{ "path", "bytes", "sha256" }] }`.

## Result (node to Gateway)

```jsonc
{ "t": "result", "ok": true, "mode": "apply", "status": "planned|applied|noop|replayed",
  "operationId": "…", "revision": 4, "digest": "…", "planDigest": "…",
  "counts": { … }, "applied": ["src/a.ts"], "truncated": false,
  "caches": "preserved-not-validated", "verification": "full",
  "recovery": "clean|recovered|rolled-back|committed|blocked",
  "protectedCount": 0, "untracked": 0 }
```

Failure:

```jsonc
{ "t": "result", "ok": false, "code": "conflict", "message": "…",
  "effect": "none|unknown", "readiness": "ready|interrupted|recovery-blocked", "affected": [] }
```

`effect: "unknown"` is the only case the Gateway may turn into `unknown-outcome`.

A stored receipt includes its original `planDigest` and `counts`; a replayed result returns those,
not a fabricated empty summary. An expired id is `receipt-expired`; status reports
`operation.state = "expired"`.

## Status

Request: `{ "owner": { "agentId": "…", "sessionKey": "…|null" }, "timeoutMs"?: 120000, "remotePath"?: "/abs", "operationId"?: "32 hex", "verify"?: true, "limit"?: 50 }`.

With `remotePath`, the response reports `exists`, `directory`, `owned`, `adoptionRequired`,
`readiness`, `revision`, `digest`, `policy`, `verification`, `dirty` (when verified), `operation`
(receipt), `protectedCount`, `journal`, `localProject`, `epoch`, `reboundFrom` and `stateDir`.
Without `remotePath`, it returns a bounded `workspaces` inventory and `truncated`.

## Artifact fetch

Unchanged in shape: `meta`, data frames, `done`; failures are `rejected` or `fetch-error`. Bytes are
verified against the node's SHA-256 and published exclusively at the Gateway.

## Deadlines

Status and fetch carry `timeoutMs`; the node derives its deadline with the same response grace.

The hello carries the Gateway budget. The node derives its deadline as
`min(now + timeoutMs - NODE_RESPONSE_GRACE_MS, hard cap)`, so a live node reports a typed `timeout`
before the Gateway gives up. Gateway setup and response time are separate; a disconnect can still
produce `unknown-outcome`.

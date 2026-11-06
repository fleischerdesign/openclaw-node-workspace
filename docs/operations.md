# Operations

## Install order

1. Build and pack the plugin (`npm ci && npm run build && npm pack`).
2. Install it on the **node host** first and restart that node. The Gateway must see the three
   commands in the node's advertised surface.
3. Install it on the **Gateway**, enable it, configure `gateway.*`, and add the node command
   allowlist.
4. Approve the node's updated command surface in **Devices** if OpenClaw asks after the reconnect.

Installing only the Gateway half gives you tools that fail with a missing node command. Installing
only the node half advertises commands that no tool calls.

## Configure the allowlist

The commands are dangerous and are not in any default allowlist. Add exactly:

```json5
gateway: {
  nodes: {
    commands: {
      allow: ["nodews.push", "nodews.fetch", "nodews.status"],
    },
  },
}
```

A `deny` entry wins over `allow`. If a command is missing at dispatch, the error is
`node command not allowed at dispatch` and names the reason.

## Verify before relying on it

1. `openclaw nodes describe <node>` must list `nodews.push`, `nodews.fetch`, and `nodews.status`.
2. `node_workspace_status` for an absent path returns `exists: false` and, when the parent exists,
   `parentExists: true`.
3. Push a small directory. Confirm the result names the node id and `cwd`, then verify one file with
   the native `exec` tool:
   `exec host=node node=<id> workdir=<cwd> "sha256sum <file>"`. Compare that digest with the
   per-file digest if you have it, or simply read the file.

Do not chain a push and an exec into one agent step without checking the push result. The plugin
returns the cwd precisely so the agent can choose the next action.

## Reconcile an unknown outcome

`unknown-outcome` means the channel died after the node claimed the destination. The plugin cannot
prove whether the publication completed.

1. Call `node_workspace_status` with the same `remotePath`.
2. If it reports `exists: true, owned: true, complete: true, verified: true` with the expected
   `digest`, the push succeeded. The node re-hashed the directory against the manifest; the marker
   alone is not the proof.
3. If it reports `exists: false`, the push did not publish; retrying the same content is safe.
4. If it reports `verified: false` or `owned: false`, inspect the directory manually. Never delete
   or replace a directory you did not create; the plugin itself will not.

Do not retry by changing `remotePath` to get around a conflict. That creates a second copy and hides
the state you are trying to reconcile.

## Partial publications

The destination name is claimed with `mkdir(2)` before files arrive, so a process killed mid-push
leaves a directory with `state: "incomplete"` and some files. It is never silently treated as a
successful copy:

- `node_workspace_status` reports `exists: true, owned: true, complete: false, verified: false`.
- A retry to the same path is `destination-exists`; remove the incomplete directory yourself after
  confirming no push is still running.
- The plugin removes the claimed directory automatically only when it is empty or contains nothing
  but the incomplete marker. It never recursively deletes a partial tree or any foreign file.

There is no replacement path and no `rename` over a destination, so an existing file, symlink, or
empty directory is never clobbered.

## Disk space

The plugin checks file and byte limits before sending, but not free space on the node. A full
filesystem fails the push with an I/O error; an incomplete destination is left with its marker. Leave
headroom for the largest configured push; publication allocates no second full copy.

## Upgrades

Both sides must run the same protocol version. Upgrade in this order:

1. Stop publishing.
2. Upgrade the node host plugin, restart the node, approve the changed command surface if requested.
3. Upgrade the Gateway plugin and restart the Gateway.

A Gateway on protocol 1 against a node on another version fails at `hello` with a protocol error; no
files are written.

## Logs and diagnostics

- Gateway plugin failures are logged with the plugin id `node-workspace`.
- Node command failures are logged by the node host under the same id.
- Every tool error includes its code. `unknown-outcome` also includes the push id, node id, and
  `remotePath` for reconciliation.
- `openclaw plugins inspect node-workspace --runtime --json` reports whether the Gateway half
  loaded and which tools it registered.

## Removing the plugin

Removing the plugin does not delete published directories or markers. Directories remain owned by
the marker until you remove them yourself. Remove the allowlist entries when you remove the plugin so
a later reinstall does not silently regain authority.

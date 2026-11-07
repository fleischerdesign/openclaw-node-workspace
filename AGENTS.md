# Working in this repository

Agent-facing notes for `openclaw-node-workspace`, a TypeScript OpenClaw plugin.

## Commands

```bash
npm ci
npm run typecheck        # tsc --noEmit, strict, no unused locals or parameters
npm test                 # node:test through tsx; unit + in-process transport
npm run build            # tsc to dist/ (the plugin runtime entry)
npm pack                 # the install shape users get
bash scripts/pack-and-inspect.sh       # real loader, disposable state under /tmp
bash scripts/integration-isolated.sh   # disposable Gateway + node host, free port
bash scripts/e2e-model-driven.sh       # same pair, plus one model-driven agent turn
```

The two scripts must never see the live state. They set `HOME`, `OPENCLAW_STATE_DIR`,
`OPENCLAW_CONFIG_PATH`, and `TMPDIR` under a temporary directory and clear `OPENCLAW_NIX_MODE` only
for the child process. Keep that property if you edit them.

## Rules

- English for code, comments, commits, and documentation.
- Conventional Commits, scoped by area: `feat(protocol): …`, `fix(node): …`.
- No `any`. The host SDK is experimental; use structural types where a public type is not exported,
  and keep the seam narrow.
- Every path that crosses the channel is validated independently on the node. Do not replace the
  node's check with trust in the Gateway.
- Do not add an archive format. The frame protocol is flat on purpose; archive parsing is where
  traversal bugs live.
- A failure that may have had an effect is `unknown-outcome`; never collapse it into `transport`.
- Tests use a real in-process channel and the real node handlers. Do not replace the handler with a
  mock to make a test easier.
- Do not add a `LICENSE`, a `license` field, or contribution terms. The licensing decision is open
  and belongs to the repository owner; contributions are not accepted.

## Layer for assertions

- Protocol, path, digest, and manifest rules: unit tests.
- Gateway/node interaction with real files on disk: in-process transport tests.
- Plugin packaging and registration: `scripts/pack-and-inspect.sh` against the real loader.
- Two-process behaviour: `scripts/integration-isolated.sh`.

An assertion belongs at the lowest layer that can decide it. Do not add a grep test for a string the
generator just wrote.

`e2e-model-driven.sh` is the top layer: a scripted OpenAI-compatible endpoint
(`model-stub.mjs`) drives a real agent turn through the Gateway. The model is a test double; the
agent loop, tool dispatch, node transport, node exec, and artifact bytes are real.

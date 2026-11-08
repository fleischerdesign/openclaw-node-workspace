import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import entry from "../src/index.js";

function register() {
  const raw = {
    gateway: { localRoots: [os.tmpdir()] },
    node: { pushRoots: [os.tmpdir()] },
  };
  let action:
    | {
        id: string;
        requiredScopes?: string[];
        handler: (context: Record<string, unknown>) => unknown;
      }
    | undefined;
  const api = {
    pluginConfig: raw,
    runtime: {
      nodes: {
        openDuplex: async () => {
          throw new Error("not used");
        },
        invoke: async () => {
          throw new Error("not used");
        },
        list: async () => ({ nodes: [] }),
      },
    },
    session: {
      controls: {
        registerSessionAction: (registered: typeof action) => {
          action = registered;
        },
        registerControlUiDescriptor: () => undefined,
      },
    },
    registerService: () => undefined,
    registerTool: () => undefined,
    registerNodeHostCommand: () => undefined,
    registerNodeInvokePolicy: () => undefined,
  };
  entry.register(api as unknown as OpenClawPluginApi);
  assert.ok(action);
  return action;
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: "node-workspace",
    actionId: "progress.snapshot",
    sessionKey: "agent:main:main",
    agentId: "main",
    payload: {},
    client: {
      scopes: ["operator.read"],
      allowsAgent: (agentId: string) => agentId === "main",
    },
    ...overrides,
  };
}

test("progress snapshot rejects a call without a host session scope", async () => {
  const action = register();
  assert.deepEqual(action.requiredScopes, ["operator.read"]);
  const result = (await action.handler(context({ sessionKey: undefined }))) as {
    ok: boolean;
    code?: string;
  };
  assert.equal(result.ok, false);
  assert.equal(result.code, "session-scope-required");
});

test("progress snapshot fails closed when the client cannot prove agent access", async () => {
  const action = register();

  const denied = (await action.handler(
    context({ client: { scopes: ["operator.read"], allowsAgent: () => false } }),
  )) as { ok: boolean; code?: string };
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "session-scope-forbidden");

  const missing = (await action.handler(
    context({ client: { scopes: ["operator.read"] } }),
  )) as { ok: boolean; code?: string };
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "session-scope-forbidden");
});

test("progress snapshot returns a scoped empty snapshot for an allowed agent", async () => {
  const action = register();
  const result = (await action.handler(context())) as {
    ok: boolean;
    result?: { transfers: unknown[]; observedAt: number };
  };
  assert.equal(result.ok, true);
  assert.deepEqual(result.result?.transfers, []);
  assert.equal(typeof result.result?.observedAt, "number");
});

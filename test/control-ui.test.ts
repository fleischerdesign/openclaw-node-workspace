// The session header was the wrong surface and the terminal row never expired.
// These tests pin the single dashboard widget, its backend descriptor, the
// session-scoped snapshot request, and the client-side expiry and failure label.

import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import controlUi from "../src/control-ui.js";
import {
  ABNORMAL_TTL_MS,
  COMPLETED_TTL_MS,
  ExpiryScheduler,
  nextExpiryAt,
  rowText,
  visibleTransfers,
  type Transfer,
} from "../src/control-ui-model.js";
import { PROGRESS_WIDGET_ID } from "../src/feature-contract.js";
import entry from "../src/index.js";

function transfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    transferId: "t1",
    kind: "push",
    phase: "sending",
    state: "running",
    filesDone: 1,
    filesTotal: 2,
    bytesDone: 10,
    bytesTotal: 20,
    startedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

test("the browser entry registers one dashboard widget and no header accessory", () => {
  const widgets: { id: string; label: string }[] = [];
  let accessories = 0;
  const host = {
    ui: {
      registerWidget(widget: { id: string; label: string }) {
        widgets.push(widget);
        return () => undefined;
      },
      registerAccessory() {
        accessories += 1;
        return () => undefined;
      },
    },
  };

  controlUi.activate(host as never);

  assert.deepEqual(widgets.map(({ id, label }) => ({ id, label })), [
    { id: PROGRESS_WIDGET_ID, label: "node-workspace progress" },
  ]);
  assert.equal(accessories, 0, "the session-header accessory must be gone");
});

test("the backend advertises the matching widget descriptor for operator.read", () => {
  const raw = {
    gateway: { localRoots: [os.tmpdir()] },
    node: { pushRoots: [os.tmpdir()] },
  };
  const descriptors: Record<string, unknown>[] = [];
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
        registerSessionAction: () => undefined,
        registerControlUiDescriptor: (descriptor: Record<string, unknown>) => descriptors.push(descriptor),
      },
    },
    registerService: () => undefined,
    registerTool: () => undefined,
    registerNodeHostCommand: () => undefined,
    registerNodeInvokePolicy: () => undefined,
  };

  entry.register(api as unknown as OpenClawPluginApi);

  assert.deepEqual(descriptors, [
    {
      surface: "widget",
      id: PROGRESS_WIDGET_ID,
      label: "node-workspace progress",
      requiredScopes: ["operator.read"],
    },
  ]);
});

function fakeDom() {
  type Element = {
    ownerDocument: unknown;
    dataset: Record<string, string>;
    style: Record<string, string>;
    children: Element[];
    textContent: string;
    setAttribute: () => void;
    append: (...nodes: Element[]) => void;
    replaceChildren: (...nodes: Element[]) => void;
    remove: () => void;
  };
  const document = {
    createElement(): Element {
      const element: Element = {
        ownerDocument: document,
        dataset: {},
        style: {},
        children: [],
        textContent: "",
        setAttribute: () => undefined,
        append: (...nodes) => {
          element.children.push(...nodes);
        },
        replaceChildren: (...nodes) => {
          element.children = nodes;
        },
        remove: () => undefined,
      };
      return element;
    },
  };
  const container = {
    ownerDocument: document,
    replaceChildren: () => undefined,
  };
  return { document, container: container as unknown as HTMLElement };
}

test("the widget watches progress.snapshot with the host session and agent id", async () => {
  const { container } = fakeDom();
  let widget: {
    mount: (
      container: HTMLElement,
      context: Record<string, unknown>,
    ) => { update?: (context: Record<string, unknown>) => void; dispose?: () => void };
  } | undefined;
  controlUi.activate({
    ui: {
      registerWidget(candidate: typeof widget) {
        widget = candidate;
        return () => undefined;
      },
    },
  } as never);
  assert.ok(widget);

  const requests: Record<string, unknown>[] = [];
  const host = {
    pluginId: "node-workspace",
    signal: new AbortController().signal,
    connection: { connected: true },
    request: async (_method: string, params: Record<string, unknown>) => {
      requests.push(params);
      return { ok: true, result: { transfers: [transfer()], observedAt: 1 } };
    },
    onEvent: () => () => undefined,
    subscribe: () => () => undefined,
  };

  const view = widget.mount(container, {
    host,
    signal: host.signal,
    presented: true,
    mountDefault: () => () => undefined,
    props: {
      sessionKey: "agent:main:one",
      agentId: "main",
      widget: { name: PROGRESS_WIDGET_ID },
      canMutate: false,
      canGrant: false,
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  const first = requests.at(-1);
  assert.equal(first?.actionId, "progress.snapshot");
  assert.equal(first?.sessionKey, "agent:main:one");
  assert.equal(first?.agentId, "main");
  assert.deepEqual(first?.payload, {});

  view.update?.({
    host,
    signal: host.signal,
    presented: true,
    props: {
      sessionKey: "agent:main:two",
      agentId: "main",
      widget: { name: PROGRESS_WIDGET_ID },
      canMutate: false,
      canGrant: false,
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(requests.at(-1)?.sessionKey, "agent:main:two");

  view.dispose?.();
});

test("terminal entries expire on a fake clock and schedule exactly one re-render", () => {
  let now = 10_000;
  const timers: { callback: () => void; at: number }[] = [];
  let renders = 0;
  let shown: Transfer[] = [];

  const transfers = [
    transfer({ transferId: "done", state: "completed", finishedAt: now, updatedAt: now }),
    transfer({ transferId: "lost", state: "unknown", finishedAt: now, updatedAt: now }),
    transfer({ transferId: "failed", state: "failed", finishedAt: now, updatedAt: now }),
  ];
  const scheduler = new ExpiryScheduler(
    () => now,
    (callback, delayMs) => {
      timers.push({ callback, at: now + delayMs });
      return timers.length - 1;
    },
    () => undefined,
  );

  const render = (): void => {
    renders += 1;
    shown = visibleTransfers(transfers, now);
    scheduler.schedule(transfers, render);
  };

  assert.equal(nextExpiryAt(transfers, now), now + COMPLETED_TTL_MS);
  render();
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.at, now + COMPLETED_TTL_MS);
  assert.deepEqual(shown.map((entry) => entry.transferId), ["done", "lost", "failed"]);

  // Advance to the completed expiry and run the one scheduled render.
  now += COMPLETED_TTL_MS;
  timers[0]?.callback();
  assert.equal(renders, 2);
  assert.deepEqual(shown.map((entry) => entry.transferId), ["lost", "failed"]);
  // One new timer for the next expiry; the previous one is not retained.
  assert.equal(timers.length, 2);
  assert.equal(timers[1]?.at, now + (ABNORMAL_TTL_MS - COMPLETED_TTL_MS));

  now += ABNORMAL_TTL_MS - COMPLETED_TTL_MS;
  timers[1]?.callback();
  assert.deepEqual(shown, []);
  assert.equal(timers.length, 2, "no timer is scheduled when nothing terminal is pending");
});

test("a failed row names the machine-readable reason instead of a bare failure", () => {
  assert.equal(
    rowText(transfer({ state: "failed", reasonCode: "path-outside-root" })),
    "failed · path-outside-root",
  );
  assert.equal(rowText(transfer({ state: "failed" })), "failed");
});

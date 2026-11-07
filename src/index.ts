import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginGatewayEvents, PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";

import { resolvePluginConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { ProgressEventCoalescer } from "./gateway/progress-events.js";
import { TransferProgressStore, type TransferScope } from "./gateway/progress-store.js";
import { createNodeTransport } from "./gateway/transport.js";
import { createTools } from "./gateway/tools.js";
import { createNodeCommands } from "./node/commands.js";
import { COMMAND_FETCH, COMMAND_PUSH, COMMAND_STATUS } from "./protocol.js";

const PLUGIN_ID = "node-workspace";

function loadGatewayConfig(raw: unknown) {
  try {
    return { config: resolvePluginConfig(raw).gateway, error: undefined };
  } catch (error) {
    return { config: undefined, error: errorMessage(error) };
  }
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Node Workspace",
  description:
    "Publish an explicitly selected workspace from the Gateway to a paired node, and fetch selected artifacts back.",
  register(api) {
    const gateway = loadGatewayConfig(api.pluginConfig);
    const transport = createNodeTransport(api.runtime);
    const progress = new TransferProgressStore();
    let events: Pick<OpenClawPluginGatewayEvents, "emit"> | undefined;
    let disposeSessions: (() => void) | undefined;
    let pruneTimer: ReturnType<typeof setInterval> | undefined;

    // Progress callbacks arrive every ~150 ms per transfer. Coalesce the
    // broadcast while keeping the first event and every terminal event prompt.
    const notifier = new ProgressEventCoalescer(() => {
      try {
        events?.emit("progress-changed", {}, { scope: "operator.read" });
      } catch {
        // The service is not started during discovery; there is no subscriber yet.
      }
    });
    const notify = (terminal = false): void => notifier.notify(terminal);

    // One implementation serves the agent tool and the Control UI accessory.
    // The session key and agent id come from the host, not from tool arguments.
    api.session.controls.registerSessionAction({
      id: "progress.snapshot",
      description: "Measured node_workspace transfer progress for one session.",
      schema: { type: "object", additionalProperties: false },
      requiredScopes: ["operator.read"],
      handler: (context) => {
        if (!context.sessionKey) {
          return { ok: false, error: "session-scope-required", code: "session-scope-required" };
        }
        if (context.agentId && context.client) {
          const allows = context.client.allowsAgent;
          if (typeof allows !== "function" || !allows(context.agentId)) {
            return { ok: false, error: "session-scope-forbidden", code: "session-scope-forbidden" };
          }
        }
        const scope: TransferScope = {
          sessionKey: context.sessionKey,
          ...(context.agentId ? { agentId: context.agentId } : {}),
        };
        return {
          ok: true,
          result: { transfers: progress.snapshot(scope), observedAt: Date.now() } as unknown as PluginJsonValue,
        };
      },
    });

    api.registerService({
      id: `${PLUGIN_ID}:progress-events`,
      start(context) {
        events = context.gatewayEvents;
        pruneTimer = setInterval(() => progress.prune(), 60_000);
        (pruneTimer as { unref?: () => void }).unref?.();
        disposeSessions = context.gatewayEvents?.onSessionsChanged((event) => {
          if (!event.sessionKey) return;
          if (!/reset|delete|remove|new/iu.test(event.reason ?? "")) return;
          const scope: TransferScope = {
            sessionKey: event.sessionKey,
            ...(event.agentId ? { agentId: event.agentId } : {}),
          };
          if (progress.clearScope(scope)) notify(true);
        });
      },
      stop() {
        disposeSessions?.();
        disposeSessions = undefined;
        if (pruneTimer !== undefined) clearInterval(pruneTimer);
        pruneTimer = undefined;
        notifier.dispose();
        events = undefined;
      },
    });

    api.registerTool((context) => {
      const scope: TransferScope | undefined = context.sessionKey
        ? {
            sessionKey: context.sessionKey,
            ...(context.agentId ? { agentId: context.agentId } : {}),
          }
        : undefined;
      return createTools({
        transport,
        config: gateway.config,
        configError: gateway.error,
        ...(scope ? { scope } : {}),
        progress,
        onProgressChange: notify,
      });
    });

    const node = createNodeCommands(api.pluginConfig);
    for (const command of node.commands) {
      api.registerNodeHostCommand(command);
    }

    api.registerNodeInvokePolicy({
      commands: [COMMAND_PUSH, COMMAND_FETCH, COMMAND_STATUS],
      dangerous: true,
      handle: (context) => context.invokeNode(),
    });
  },
});

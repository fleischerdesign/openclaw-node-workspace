import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { resolvePluginConfig } from "./config.js";
import { errorMessage } from "./errors.js";
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

    for (const tool of createTools({
      transport,
      config: gateway.config,
      configError: gateway.error,
    })) {
      // The structural tool matches the host contract; the cast only bridges the
      // host's generic parameter schema type.
      api.registerTool(tool);
    }

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

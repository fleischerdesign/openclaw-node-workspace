import type { NodeConfig } from "../config.js";
import { resolvePluginConfig } from "../config.js";
import { createFetchCommand } from "./fetch.js";
import { createNodeCommands as createManagedCommands } from "./managed.js";
import type { NodeHostCommand } from "./managed.js";

export type { NodeHostCommand, NodeHostCommandContext } from "./managed.js";
export type { NodeHostCommandIo } from "./session.js";

export interface NodeCommandSet {
  readonly commands: readonly NodeHostCommand[];
  readonly configError: string | undefined;
}

/**
 * All node commands the plugin registers.
 *
 * Managed source sync is the only workspace mutation path; artifact fetch is a
 * separate, read-only transfer. There is no arbitrary command endpoint and no
 * raw deletion instruction.
 */
export function createNodeCommands(rawConfig: unknown): NodeCommandSet {
  const managed = createManagedCommands(rawConfig);
  let config: NodeConfig | undefined;
  try {
    config = resolvePluginConfig(rawConfig).node;
  } catch {
    config = undefined;
  }
  if (config === undefined) {
    return { commands: managed.commands, configError: managed.configError };
  }
  return {
    commands: [...managed.commands, createFetchCommand(config)],
    configError: managed.configError,
  };
}


import { errorMessage } from "../errors.js";

/**
 * The workspace the host resolved for one agent tool registration.
 *
 * `workspaceDir` is the effective workspace of the calling session when the
 * host knows it. It is deliberately optional here: the host SDK is
 * experimental, so the tool factory must keep working when a build passes no
 * context at all — and it must fail closed in that case, never guess.
 */
export interface ToolWorkspace {
  readonly workspaceDir?: string;
  /** Why no workspace could be resolved; used only to explain a refusal. */
  readonly workspaceError?: string;
}

export interface ToolWorkspaceContext<Config> {
  readonly workspaceDir?: string | undefined;
  readonly agentId?: string | undefined;
  readonly config?: Config | undefined;
}

export interface ToolWorkspaceSources<Config> {
  readonly context: ToolWorkspaceContext<Config> | undefined;
  /** `api.runtime.agent.resolveAgentWorkspaceDir`, the agent-level fallback. */
  readonly resolveAgentWorkspaceDir: ((config: Config, agentId: string) => string) | undefined;
  /** `api.runtime.config.current`, used when the context carries no config. */
  readonly currentConfig?: (() => Config) | undefined;
}

/**
 * Choose the authoritative workspace for a tool call.
 *
 * The session workspace wins. Only when the host does not provide one does the
 * agent workspace apply, resolved through the host's own resolver so the
 * plugin does not duplicate OpenClaw's agent-config rules. Without either
 * source the result carries an error and every path-bearing tool refuses.
 */
export function resolveToolWorkspace<Config>(sources: ToolWorkspaceSources<Config>): ToolWorkspace {
  const direct = sources.context?.workspaceDir;
  if (typeof direct === "string" && direct.length > 0) return { workspaceDir: direct };

  const agentId = sources.context?.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) {
    return {
      workspaceError:
        "the host provided no workspace directory for this session and no agent id to resolve an agent workspace",
    };
  }
  const resolver = sources.resolveAgentWorkspaceDir;
  if (resolver === undefined) {
    return {
      workspaceError:
        "the host provided no workspace directory for this session and no agent workspace resolver is available",
    };
  }
  let config = sources.context?.config;
  if (config === undefined && sources.currentConfig !== undefined) {
    try {
      config = sources.currentConfig();
    } catch (error) {
      return { workspaceError: `reading the current configuration failed: ${errorMessage(error)}` };
    }
  }
  if (config === undefined) {
    return {
      workspaceError:
        "the host provided no workspace directory for this session and no configuration to resolve the agent workspace",
    };
  }
  try {
    const resolved = resolver(config, agentId);
    if (typeof resolved === "string" && resolved.length > 0) return { workspaceDir: resolved };
    return { workspaceError: `the agent workspace resolver returned no directory for agent ${agentId}` };
  } catch (error) {
    return {
      workspaceError: `resolving the agent workspace for ${agentId} failed: ${errorMessage(error)}`,
    };
  }
}

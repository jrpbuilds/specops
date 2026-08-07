import type { Config, Plugin } from "@opencode-ai/plugin";
import { ActiveAgentSessions, createPermissionAskHook } from "./agents/permission-hook.js";
import { ALL_AGENT_IDS, type AgentId } from "./agents/ids.js";
import { DEFAULT_MANIFEST, manifestAgentConfig, type SpecOpsManifest } from "./agents/manifest.js";
import {
    materializeAgentManifest,
    registerManifestAgents,
    resolveManifestPath,
} from "./installation.js";
import { loadV1Configuration } from "./config/loader.js";
import { SpecOpsPlugin } from "./plugin.js";

/**
 * Default manifest location resolved with OpenCode's XDG configuration rules.
 *
 * Computed once at module load so the same path is reused by the plugin loader,
 * diagnostics, and installation tests.
 */
export const MANIFEST_PATH = resolveManifestPath();

/**
 * Backward-free public loader used by diagnostics and install tests.
 *
 * Materialises the manifest at {@link MANIFEST_PATH}, creating a default
 * manifest when none exists yet. Performs no network or git operations.
 *
 * @returns The currently persisted {@link SpecOpsManifest}.
 */
export async function loadOrInitManifest(): Promise<SpecOpsManifest> {
    return (await materializeAgentManifest(MANIFEST_PATH)).manifest;
}

/**
 * Runtime plugin wrapper that materialises the manifest and global config,
 * then registers every controller and worker in the same config hook that
 * registers commands.
 *
 * Composes the inner {@link SpecOpsPlugin} with manifest agent registration so
 * a single `config` callback installs commands, controllers, and workers in
 * one pass.
 * @param input - OpenCode plugin input used to resolve project configuration.
 * @returns A composed {@link Plugin} whose `config` hook also registers
 * manifest-driven agents.
 */
export const SpecOpsPluginWithManifest: Plugin = async input => {
    const inner = await SpecOpsPlugin(input);
    const materialisation = await materializeAgentManifest();
    await loadV1Configuration(input.directory);
    const sessions = new ActiveAgentSessions();
    const innerChatMessage = inner["chat.message"];
    const innerPermissionAsk = inner["permission.ask"];
    const permissionAsk = createPermissionAskHook(sessions);

    return {
        ...inner,
        config: async (config: Config) => {
            const specOpsConfig = await loadV1Configuration(input.directory);
            await inner.config?.(config);
            registerManifestAgents(
                config,
                materialisation.manifest,
                specOpsConfig.integrations.mcp,
            );
        },
        "chat.message": async (message, output) => {
            if (message.agent && isAgentId(message.agent))
                sessions.set(message.sessionID, message.agent);
            await innerChatMessage?.(message, output);
        },
        "permission.ask": async (request, output) => {
            await innerPermissionAsk?.(request, output);
            await permissionAsk(request, output);
        },
    };
};

/** Narrow a host-provided agent identifier to the V1 SpecOps catalogue. */
function isAgentId(value: string): value is AgentId {
    return ALL_AGENT_IDS.includes(value as AgentId);
}

/**
 * Package entry consumed by OpenCode's plugin loader.
 *
 * `id` is the canonical plugin identifier; `server` is the plugin factory
 * that registers SpecOps commands and tools.
 */
export default {
    id: "specops",
    server: SpecOpsPluginWithManifest,
} satisfies import("@opencode-ai/plugin").PluginModule;

export { DEFAULT_MANIFEST, manifestAgentConfig, SpecOpsPlugin };
export type { SpecOpsManifest };

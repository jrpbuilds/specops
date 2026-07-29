import { ALL_AGENT_IDS, type AgentId } from "./capabilities/ids.js"
import { AGENT_IDS } from "./capabilities/ids.js"
import { AGENT_REGISTRY } from "./capabilities/registry.js"
import { promptText } from "./prompts.generated.js"

/**
 * User-tunable provider options for one canonically registered agent.
 *
 * `model` and `steps` are required; any additional keys are forwarded
 * verbatim as provider options to the underlying model backend.
 */
export type ManifestEntry = { model: string; steps: number; [providerOption: string]: unknown }

/**
 * Persisted model/provider choices for precisely the final agent catalogue.
 *
 * `version` pins the manifest schema; `agents` maps each {@link AgentId} to its
 * {@link ManifestEntry}. A manifest is valid only when its agent set matches
 * the current installation's {@link ALL_AGENT_IDS} exactly.
 */
export type SpecOpsManifest = { version: 1; agents: Record<AgentId, ManifestEntry> }

/**
 * Generate the clean-install manifest directly from the capability registry.
 *
 * Built once at module load from {@link AGENT_REGISTRY} so the default
 * manifest always reflects the canonical agent IDs, models, and step counts.
 */
export const DEFAULT_MANIFEST: SpecOpsManifest = {
    version: 1,
    agents: Object.fromEntries(
        Object.values(AGENT_REGISTRY).map(agent => [
            agent.id,
            { model: agent.model, steps: agent.steps },
        ]),
    ) as SpecOpsManifest["agents"],
}

/**
 * Reject partial, stale, or otherwise invalid manifest catalogues.
 *
 * Verifies the manifest is an object with `version === 1`, a non-array
 * `agents` object whose keys match {@link ALL_AGENT_IDS} exactly, and that
 * each entry has a string `model` and number `steps`.
 *
 * @param value - Raw, untyped manifest value.
 * @returns The validated {@link SpecOpsManifest}.
 * @throws {Error} If the manifest is missing, malformed, or its agent set does
 * not match the installation.
 */
export function validateManifest(value: unknown): SpecOpsManifest {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("invalid SpecOps manifest")
    }
    const source = value as Record<string, unknown>
    if (
        source.version !== 1 ||
        !source.agents ||
        typeof source.agents !== "object" ||
        Array.isArray(source.agents)
    ) {
        throw new Error("invalid SpecOps manifest")
    }

    const entries = source.agents as Record<string, unknown>
    const expected = [...ALL_AGENT_IDS].sort()
    if (Object.keys(entries).sort().join("|") !== expected.join("|")) {
        throw new Error("manifest agent catalogue does not match this SpecOps installation")
    }
    for (const id of expected) {
        const item = entries[id]
        if (
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            typeof (item as ManifestEntry).model !== "string" ||
            typeof (item as ManifestEntry).steps !== "number"
        ) {
            throw new Error(`invalid manifest agent: ${id}`)
        }
    }
    return source as SpecOpsManifest
}

/**
 * Upgrade only the exact pre-frontier manifest catalogue.
 *
 * Existing model/provider choices are retained verbatim and the two new
 * frontier entries are appended from current defaults. Other partial or stale
 * catalogues are deliberately not merged.
 *
 * @param value - Parsed manifest candidate.
 * @returns An upgraded manifest, or `undefined` when it is not the exact
 * legacy catalogue.
 */
export function migrateLegacyFrontierManifest(value: unknown): SpecOpsManifest | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const source = value as Record<string, unknown>
    if (
        source.version !== 1 ||
        !source.agents ||
        typeof source.agents !== "object" ||
        Array.isArray(source.agents)
    ) {
        return undefined
    }
    const entries = source.agents as Record<string, unknown>
    const frontierIds = new Set<string>([
        AGENT_IDS.review.frontierLow,
        AGENT_IDS.review.frontierHigh,
    ])
    const legacyIds = ALL_AGENT_IDS.filter(id => !frontierIds.has(id)).sort()
    if (Object.keys(entries).sort().join("|") !== legacyIds.join("|")) return undefined
    for (const id of legacyIds) {
        const item = entries[id]
        if (
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            typeof (item as ManifestEntry).model !== "string" ||
            typeof (item as ManifestEntry).steps !== "number"
        ) {
            return undefined
        }
    }
    return validateManifest({
        version: 1,
        agents: {
            ...entries,
            [AGENT_IDS.review.frontierLow]: DEFAULT_MANIFEST.agents[AGENT_IDS.review.frontierLow],
            [AGENT_IDS.review.frontierHigh]: DEFAULT_MANIFEST.agents[AGENT_IDS.review.frontierHigh],
        },
    })
}

/**
 * Merge a user manifest entry with registry-controlled authority and prompts.
 *
 * Extracts `model` and `steps` from the entry, spreads remaining keys as
 * provider options, and overlays the registry's `mode`, `tools`, and
 * `permission` values together with the generated prompt.
 *
 * @param id - The canonical {@link AgentId}.
 * @param entry - The user's {@link ManifestEntry} for this agent.
 * @returns A complete agent configuration object ready for OpenCode's
 * `config.agent` map.
 */
export function manifestAgentConfig(id: AgentId, entry: ManifestEntry) {
    const policy = AGENT_REGISTRY[id]
    const { model, steps, ...providerOptions } = entry
    return {
        ...providerOptions,
        model,
        maxSteps: steps,
        mode: policy.mode,
        prompt: promptText(id),
        tools: policy.tools,
        permission: policy.permission,
    }
}

import { ALL_AGENT_IDS, type AgentId } from "./capabilities/ids.js"
import { AGENT_REGISTRY } from "./capabilities/registry.js"
import { promptText } from "./prompts.generated.js"

/**
 * User-selectable OpenCode model settings for one registered agent.
 *
 * An absent or empty `model` means "use OpenCode's configured global default
 * model"; a `variant` may pin a provider-specific model flavour when a model is
 * selected.
 */
export type ManifestEntry = { model?: string; variant?: string }

/**
 * Persisted model choices for precisely the current agent catalogue.
 *
 * Workflow policy remains registry-owned; the manifest deliberately accepts
 * only a model and an optional OpenCode model variant.
 */
export type SpecOpsManifest = { version: 2; agents: Record<AgentId, ManifestEntry> }

/** Generate clean-install model settings from the capability registry. */
export const DEFAULT_MANIFEST: SpecOpsManifest = {
    version: 2,
    agents: Object.fromEntries(
        Object.values(AGENT_REGISTRY).map(agent => [
            agent.id,
            agent.model ? { model: agent.model } : {},
        ]),
    ) as SpecOpsManifest["agents"],
}

/**
 * Reject partial, stale, empty, or extensible manifest catalogues.
 *
 * The top level must contain exactly `version` and `agents`; every agent entry
 * may contain `model` (empty counts as "use OpenCode global default") and,
 * optionally, `variant`.
 */
export function validateManifest(value: unknown): SpecOpsManifest {
    if (!isRecord(value) || !hasExactKeys(value, ["agents", "version"]) || value.version !== 2) {
        throw new Error("invalid SpecOps manifest")
    }
    if (!isRecord(value.agents)) throw new Error("invalid SpecOps manifest")

    const expected = [...ALL_AGENT_IDS].sort()
    if (Object.keys(value.agents).sort().join("|") !== expected.join("|")) {
        throw new Error("manifest agent catalogue does not match this SpecOps installation")
    }
    for (const id of expected) {
        const item = value.agents[id]
        if (!isRecord(item) || !hasOnlyKeys(item, ["model", "variant"])) {
            throw new Error(`invalid manifest agent: ${id}`)
        }
        const modelOk = !("model" in item) || typeof item.model === "string"
        const variantOk =
            !("variant" in item) || (typeof item.variant === "string" && !!item.variant.trim())
        if (!modelOk || !variantOk) {
            throw new Error(`invalid manifest agent: ${id}`)
        }
    }
    return value as SpecOpsManifest
}

/**
 * Combine user-selected model settings with registry-owned workflow policy.
 */
export function manifestAgentConfig(id: AgentId, entry: ManifestEntry) {
    const policy = AGENT_REGISTRY[id]
    const model = entry.model?.trim()
    // A variant pins a chosen model's flavour; without a model it has no
    // meaning, so drop it rather than forward a dangling variant to OpenCode.
    return {
        ...(model ? { model, ...(entry.variant ? { variant: entry.variant } : {}) } : {}),
        maxSteps: policy.steps,
        mode: policy.mode,
        prompt: promptText(id),
        permission: policy.permission,
    }
}

/** Narrow an unknown value to a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Check that every object key is in the allowed list. */
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key))
}

/** Check that an object's keys exactly equal the expected list. */
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    return Object.keys(value).sort().join("|") === [...expected].sort().join("|")
}

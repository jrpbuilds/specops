import { agentPrompt, AGENT_REGISTRY } from "./registry.js";
import { ALL_AGENT_IDS, type AgentId } from "./ids.js";

/** User-selectable model settings for one final SpecOps role. */
export type ManifestEntry = { model?: string; variant?: string };

/** Persisted model choices for exactly the seven final SpecOps roles. */
export type SpecOpsManifest = { version: 3; agents: Record<AgentId, ManifestEntry> };

/** Default manifest defers every role to OpenCode's configured global model. */
export const DEFAULT_MANIFEST: SpecOpsManifest = {
    version: 3,
    agents: Object.fromEntries(ALL_AGENT_IDS.map(id => [id, {}])) as SpecOpsManifest["agents"],
};

/** Validate the strict V3 manifest shape and exact seven-role catalogue. */
export function validateManifest(value: unknown): SpecOpsManifest {
    if (!isRecord(value) || !hasExactKeys(value, ["agents", "version"]) || value.version !== 3) {
        throw new Error("invalid SpecOps manifest");
    }
    if (!isRecord(value.agents)) throw new Error("invalid SpecOps manifest");

    const expected = [...ALL_AGENT_IDS].sort();
    if (Object.keys(value.agents).sort().join("|") !== expected.join("|")) {
        throw new Error("manifest agent catalogue does not match this SpecOps installation");
    }
    for (const id of expected) {
        const item = value.agents[id];
        if (!isRecord(item) || !hasOnlyKeys(item, ["model", "variant"])) {
            throw new Error(`invalid manifest agent: ${id}`);
        }
        const modelOk = !("model" in item) || typeof item.model === "string";
        const variantOk =
            !("variant" in item) ||
            (typeof item.variant === "string" && Boolean(item.variant.trim()));
        if (!modelOk || !variantOk) throw new Error(`invalid manifest agent: ${id}`);
    }
    return value as SpecOpsManifest;
}

/** Combine model choices with the final registry-owned prompt and permissions. */
export function manifestAgentConfig(id: AgentId, entry: ManifestEntry) {
    const policy = AGENT_REGISTRY[id];
    const model = entry.model?.trim();
    return {
        ...(model ? { model, ...(entry.variant ? { variant: entry.variant } : {}) } : {}),
        maxSteps: policy.maxSteps,
        mode: policy.mode,
        prompt: agentPrompt(id),
        permission: policy.permission,
    };
}

/** Narrow an unknown value to a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Check that an object has no unsupported fields. */
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key));
}

/** Check that an object's keys exactly equal the expected list. */
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

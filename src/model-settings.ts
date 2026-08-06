import { AGENT_IDS, ALL_AGENT_IDS, type AgentId } from "./agents/ids.js";
import { DEFAULT_MANIFEST, type SpecOpsManifest } from "./agents/manifest.js";

const PLANNING_SETTINGS_IDS = new Set<AgentId>([
    AGENT_IDS.explorer,
    AGENT_IDS.planner,
    AGENT_IDS.designer,
]);

/** Resolved OpenCode model choice shown by the settings UI. */
export type ConfiguredModel = {
    id: string;
    name: string;
    providerID: string;
    providerName: string;
    variants: readonly string[];
};

/** Minimal resolved provider shape exposed by OpenCode's TUI state. */
export type ConfiguredProvider = {
    id: string;
    name: string;
    models: Readonly<
        Record<
            string,
            {
                id: string;
                providerID: string;
                name: string;
                variants?: Readonly<Record<string, unknown>>;
            }
        >
    >;
};

/** A staged manifest plus agents whose defaults are unavailable. */
export type ManifestDraft = {
    manifest: SpecOpsManifest;
    unresolved: readonly AgentId[];
};

/** Flatten OpenCode's configured providers into stable `provider/model` IDs. */
export function configuredModels(
    providers: readonly ConfiguredProvider[],
): readonly ConfiguredModel[] {
    return providers
        .flatMap(provider =>
            Object.values(provider.models).map(model => ({
                id: `${model.providerID || provider.id}/${model.id}`,
                name: model.name,
                providerID: model.providerID || provider.id,
                providerName: provider.name,
                variants: Object.keys(model.variants ?? {}).sort(),
            })),
        )
        .sort((left, right) =>
            `${left.providerName}/${left.name}`.localeCompare(
                `${right.providerName}/${right.name}`,
            ),
        );
}

/**
 * Build an editable complete mapping from a current manifest.
 *
 * The registry default may be blank (meaning "use OpenCode's global default
 * model"), so a missing/blank model is valid and not unresolved; only a
 * non-blank model that is not currently available is flagged unresolved.
 */
export function createManifestDraft(
    source: SpecOpsManifest,
    models: readonly ConfiguredModel[],
): ManifestDraft {
    const available = new Set(models.map(model => model.id));
    const agents = {} as SpecOpsManifest["agents"];
    const unresolved: AgentId[] = [];

    for (const id of ALL_AGENT_IDS) {
        const sourceEntry = source.agents[id];
        const sourceModel = sourceEntry.model?.trim() ? sourceEntry.model : undefined;
        const defaultModel = DEFAULT_MANIFEST.agents[id].model?.trim()
            ? DEFAULT_MANIFEST.agents[id].model
            : undefined;
        const sourceVariant = sourceEntry.variant ?? undefined;

        const model = sourceModel ?? defaultModel;

        agents[id] = {
            ...(model ? { model } : {}),
            ...(sourceVariant ? { variant: sourceVariant } : {}),
        };

        if (model && !available.has(model)) {
            unresolved.push(id);
        }
    }

    return { manifest: { version: 3, agents }, unresolved };
}

/**
 * Apply a selected model while retaining only a variant supported by it.
 */
export function selectConfiguredModel(
    entry: SpecOpsManifest["agents"][AgentId],
    model: ConfiguredModel,
): SpecOpsManifest["agents"][AgentId] {
    return {
        model: model.id,
        ...(entry.variant && model.variants.includes(entry.variant)
            ? { variant: entry.variant }
            : {}),
    };
}

/**
 * Clear the agent-specific model so OpenCode's configured global default is
 * used. The variant is retained as a staging preference: it is re-applied (or
 * dropped) when the user next selects a model via {@link selectConfiguredModel},
 * and a modelless entry carrying a variant cannot be saved because
 * {@link validateManifestSelections} rejects it.
 */
export function clearConfiguredModel(
    entry: SpecOpsManifest["agents"][AgentId],
): SpecOpsManifest["agents"][AgentId] {
    return entry.variant ? { variant: entry.variant } : {};
}

/** Return the functional section used by the agent mapping screen. */
export function agentSettingsCategory(id: AgentId): string {
    if (id === AGENT_IDS.coordinator) return "Coordination";
    if (PLANNING_SETTINGS_IDS.has(id)) return "Planning";
    if (id === AGENT_IDS.implementer) return "Implementation";
    if (id === AGENT_IDS.reviewer) return "Review";
    return "Frontier";
}

/** Validate a complete staged mapping against the current OpenCode catalogue. */
export function validateManifestSelections(
    manifest: SpecOpsManifest,
    models: readonly ConfiguredModel[],
): readonly string[] {
    const available = new Map(models.map(model => [model.id, model]));
    const issues: string[] = [];
    for (const id of ALL_AGENT_IDS) {
        const entry = manifest.agents[id];
        const modelId = entry.model?.trim();
        // A blank model means "use OpenCode's global default"; it is always valid.
        if (!modelId) {
            if (entry.variant?.trim()) {
                issues.push(`${id}: variant ${entry.variant} requires a model`);
            }
            continue;
        }
        const model = available.get(modelId);
        if (!model) {
            issues.push(`${id}: model ${modelId} is not currently configured`);
        } else if (entry.variant && !model.variants.includes(entry.variant)) {
            issues.push(`${id}: variant ${entry.variant} is unavailable for ${modelId}`);
        }
    }
    return issues;
}

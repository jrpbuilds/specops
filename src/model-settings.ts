import { AGENT_IDS, ALL_AGENT_IDS, type AgentId } from "./capabilities/ids.js"
import { DEFAULT_MANIFEST, type SpecOpsManifest } from "./manifest.js"

const CONTROLLER_SETTINGS_IDS = new Set<AgentId>(Object.values(AGENT_IDS.controller))
const CORE_SETTINGS_IDS = new Set<AgentId>(
    Object.values(AGENT_IDS.core).filter(id => id !== AGENT_IDS.core.repairer),
)
const FRONTIER_SETTINGS_IDS = new Set<AgentId>([
    AGENT_IDS.review.frontierLow,
    AGENT_IDS.review.frontierHigh,
])
const REVIEW_SETTINGS_IDS = new Set<AgentId>([
    AGENT_IDS.core.repairer,
    AGENT_IDS.review.risk,
    AGENT_IDS.review.correctnessJudge,
    AGENT_IDS.review.complianceJudge,
    AGENT_IDS.review.refuter,
])

/** Resolved OpenCode model choice shown by the settings UI. */
export type ConfiguredModel = {
    id: string
    name: string
    providerID: string
    providerName: string
    variants: readonly string[]
}

/** Minimal resolved provider shape exposed by OpenCode's TUI state. */
export type ConfiguredProvider = {
    id: string
    name: string
    models: Readonly<
        Record<
            string,
            {
                id: string
                providerID: string
                name: string
                variants?: Readonly<Record<string, unknown>>
            }
        >
    >
}

/** A staged manifest plus agents whose defaults are unavailable. */
export type ManifestDraft = {
    manifest: SpecOpsManifest
    unresolved: readonly AgentId[]
}

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
        )
}

/**
 * Build an editable complete mapping from a v1 or v2 manifest.
 *
 * Legacy model values are retained only when OpenCode currently exposes them.
 * The registry default may now be blank (meaning "use OpenCode's global
 * default model"), so a missing/blank model is valid and not unresolved; only
 * a non-blank model that is not currently available is flagged unresolved.
 */
export function createManifestDraft(
    source: { version: 1; agents: Record<string, unknown> } | SpecOpsManifest,
    models: readonly ConfiguredModel[],
): ManifestDraft {
    const available = new Set(models.map(model => model.id))
    const agents = {} as SpecOpsManifest["agents"]
    const unresolved: AgentId[] = []

    for (const id of ALL_AGENT_IDS) {
        const sourceEntry = source.agents[id]
        const rawSourceModel =
            sourceEntry &&
            typeof sourceEntry === "object" &&
            !Array.isArray(sourceEntry) &&
            typeof (sourceEntry as { model?: unknown }).model === "string"
                ? (sourceEntry as { model: string }).model
                : undefined
        const sourceModel = rawSourceModel?.trim() ? rawSourceModel : undefined
        const defaultModel = DEFAULT_MANIFEST.agents[id].model?.trim()
            ? DEFAULT_MANIFEST.agents[id].model
            : undefined
        const sourceVariant =
            source.version === 2 &&
            sourceEntry &&
            typeof sourceEntry === "object" &&
            !Array.isArray(sourceEntry) &&
            typeof (sourceEntry as { variant?: unknown }).variant === "string"
                ? (sourceEntry as { variant: string }).variant
                : undefined

        const model =
            source.version === 2
                ? (sourceModel ?? defaultModel)
                : sourceModel && available.has(sourceModel)
                  ? sourceModel
                  : defaultModel

        agents[id] = {
            ...(model ? { model } : {}),
            ...(sourceVariant ? { variant: sourceVariant } : {}),
        }

        if (model && !available.has(model)) {
            unresolved.push(id)
        }
    }

    return { manifest: { version: 2, agents }, unresolved }
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
    }
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
    return entry.variant ? { variant: entry.variant } : {}
}

/** Return the functional section used by the agent mapping screen. */
export function agentSettingsCategory(id: AgentId): string {
    if (CONTROLLER_SETTINGS_IDS.has(id)) return "Controllers"
    if (CORE_SETTINGS_IDS.has(id)) return "Core workflow"
    if (REVIEW_SETTINGS_IDS.has(id)) return "Review, judgment and repair"
    if (FRONTIER_SETTINGS_IDS.has(id)) return "Frontier escalation"
    return "Specialists"
}

/** Validate a complete staged mapping against the current OpenCode catalogue. */
export function validateManifestSelections(
    manifest: SpecOpsManifest,
    models: readonly ConfiguredModel[],
): readonly string[] {
    const available = new Map(models.map(model => [model.id, model]))
    const issues: string[] = []
    for (const id of ALL_AGENT_IDS) {
        const entry = manifest.agents[id]
        const modelId = entry.model?.trim()
        // A blank model means "use OpenCode's global default"; it is always valid.
        if (!modelId) {
            if (entry.variant?.trim()) {
                issues.push(`${id}: variant ${entry.variant} requires a model`)
            }
            continue
        }
        const model = available.get(modelId)
        if (!model) {
            issues.push(`${id}: model ${modelId} is not currently configured`)
        } else if (entry.variant && !model.variants.includes(entry.variant)) {
            issues.push(`${id}: variant ${entry.variant} is unavailable for ${modelId}`)
        }
    }
    return issues
}

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { resolveGlobalConfigPath } from "./installation.js"
import type { EscalationBudget, RiskFacet, ScopeTier } from "./types.js"

/**
 * Strict, clean-install configuration for the final SpecOps architecture.
 *
 * Every field is parsed and validated by {@link validateConfig}; unknown fields
 * are rejected rather than silently carried forward so configuration drift is
 * surfaced at load time.
 */
export type SpecOpsConfig = {
    /** Schema version; currently always `2`. */
    version: 2
    /** OpenSpec integration: `command` is the argv used to invoke the OpenSpec CLI, or `null` to disable. */
    openspec: { command: string[] | null }
    /** Workflow routing and scope-tier configuration. */
    workflow: {
        /** Default tier selected when no assessment-level suggestion overrides it. */
        defaultTier: "auto" | ScopeTier
        /** File/module counts at which the lean and full tiers are selected. */
        scopeThresholds: {
            leanMaxFiles: number
            leanMaxModules: number
            fullMinFiles: number
            fullMinModules: number
        }
    }
    /** Routing overrides that force the full tier for changes touching certain risk facets. */
    routing: { forceFullForFacets: RiskFacet[] }
    /** Automation gate configuration (e.g. clean-worktree requirement). */
    automation: { requireCleanWorktree: boolean }
    /** Escalation budget limits consumed by the controller. */
    escalation: { budgets: EscalationBudget }
    /** Optional adaptive low/high frontier escalation policy. */
    frontier: {
        mode: "disabled" | "adaptive"
        maxEscalationsPerRun: number
        maxDispatchesPerRun: number
        maxHighDispatchesPerRun: number
    }
    /** Reviewer dispatch and command execution limits. */
    review: {
        /** Severity levels that block a run when raised by a reviewer. */
        blockingSeverities: Array<"BLOCKER" | "HIGH" | "MEDIUM" | "LOW">
        /** Maximum diff bytes passed to a reviewer agent. */
        maxDiffBytes: number
        /** Maximum context bytes passed to a reviewer agent. */
        maxContextBytes: number
        /** Number of transient reviewer failures tolerated before escalation. */
        transientRetries: number
        /** Hard timeout for a review command execution, in seconds. */
        commandTimeoutSeconds: number
        /** Maximum bytes of command output retained as evidence. */
        commandOutputBytes: number
    }
    /** Integration toggles; `mcp` controls MCP tool access for SpecOps subagents. */
    integrations: { mcp: "allow" | "disabled" }
}

/**
 * Defaults chosen to favour bounded execution in a clean final installation.
 *
 * Each nested value is the canonical baseline that {@link validateConfig}
 * accepts; user configuration overrides these without being merged.
 */
export const DEFAULT_CONFIG: SpecOpsConfig = {
    version: 2,
    /** OpenSpec CLI disabled by default; users opt in by setting `openspec.command`. */
    openspec: { command: null },
    workflow: {
        /** Routing selects the tier from the assessment unless overridden. */
        defaultTier: "auto",
        scopeThresholds: {
            leanMaxFiles: 2,
            leanMaxModules: 1,
            fullMinFiles: 9,
            fullMinModules: 4,
        },
    },
    /** No facets force the full tier unless explicitly configured. */
    routing: { forceFullForFacets: [] },
    /** Require a clean git worktree before starting a run. */
    automation: { requireCleanWorktree: true },
    escalation: {
        budgets: {
            maxScopeEscalations: 2,
            maxSpecialistDispatches: 8,
            maxRepairCycles: 3,
            maxRepeatedFailureFingerprints: 2,
        },
    },
    frontier: {
        mode: "disabled",
        maxEscalationsPerRun: 2,
        maxDispatchesPerRun: 3,
        maxHighDispatchesPerRun: 1,
    },
    review: {
        /** Block on BLOCKER and HIGH findings only. */
        blockingSeverities: ["BLOCKER", "HIGH"],
        maxDiffBytes: 1_000_000,
        maxContextBytes: 50_000,
        transientRetries: 1,
        commandTimeoutSeconds: 300,
        commandOutputBytes: 32_000,
    },
    /** Allow SpecOps subagents to use configured OpenCode MCP server tools. */
    integrations: { mcp: "allow" },
}

/** Published JSON Schema used by the global configuration editor. */
export const SPECOPS_CONFIG_SCHEMA_URL = "https://specops.dev/schemas/specops.schema.json"

/** Result of creating or finding the global user configuration. */
export type GlobalConfigMaterialisation = {
    path: string
    created: boolean
}

/**
 * Record of a configuration file that was repaired during load.
 *
 * The strict validator salvages every top-level section that still parses and
 * rewrites the offending file with defaults deep-merged onto the salvaged
 * partial, so a single bad field no longer prevents the plugin from loading.
 * One {@link ConfigRepair} is produced per repaired file and held in module
 * state for the next `doctor` run to surface as a `WARN` diagnostic.
 */
export type ConfigRepair = {
    /** Absolute path of the file that was rewritten. */
    path: string
    /** First validation error that triggered the repair. */
    reason: string
    /** Top-level section keys salvaged from the original (e.g. `["review"]`). */
    recoveredSections: readonly string[]
}

/**
 * Repairs performed during the most recent {@link resolveConfig} call.
 *
 * Held in module state so `doctor` can surface "this file was repaired at load
 * time" without re-running the lenient validator. Consumed (cleared) by
 * {@link consumeConfigRepairs} so each repair is reported exactly once.
 */
let lastRepairs: ConfigRepair[] = []

/**
 * Return and clear the repairs recorded by the most recent {@link resolveConfig}.
 *
 * @returns Repairs performed during the last resolution; subsequent calls
 *   return an empty array until the next resolution repairs another file.
 */
export function consumeConfigRepairs(): ConfigRepair[] {
    const repairs = lastRepairs
    lastRepairs = []
    return repairs
}

/** Reset recorded repairs; used by tests to isolate resolution behaviour. */
export function resetConfigRepairs(): void {
    lastRepairs = []
}

/**
 * Create the complete global configuration when it does not exist.
 *
 * The exclusive file creation preserves user-owned partial or invalid files,
 * while the generated document exposes every current configuration field.
 * @param destination - Optional global configuration path, primarily for tests.
 * @returns The resolved path and whether this call created the file.
 */
export async function materializeGlobalConfig(
    destination: string = resolveGlobalConfigPath(),
): Promise<GlobalConfigMaterialisation> {
    await mkdir(path.dirname(destination), { recursive: true })
    const document = {
        $schema: SPECOPS_CONFIG_SCHEMA_URL,
        ...structuredClone(DEFAULT_CONFIG),
    }
    try {
        await writeFile(destination, `${JSON.stringify(document, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
        })
        return { path: destination, created: true }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return { path: destination, created: false }
        }
        throw error
    }
}

/** Check whether a value is a plain object (not null and not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * Merge plain objects recursively.
 *
 * Arrays, primitives, and explicit `null` replace earlier values. Plain
 * objects are combined key-by-key. Later sources win over earlier ones.
 */
function deepMerge(base: unknown, ...sources: unknown[]): unknown {
    if (sources.length === 0) {
        return structuredClone(base)
    }
    if (!isObject(base)) {
        return structuredClone(sources.at(-1) ?? base)
    }
    const result = structuredClone(base) as Record<string, unknown>
    for (const source of sources) {
        if (!isObject(source)) {
            return structuredClone(source)
        }
        for (const key of Object.keys(source)) {
            const sourceValue = source[key]
            const targetValue = result[key]
            if (key === "$schema") {
                // $schema is a metadata annotation; keep the most specific source.
                result[key] = structuredClone(sourceValue)
                continue
            }
            if (isObject(sourceValue) && isObject(targetValue)) {
                result[key] = deepMerge(targetValue, sourceValue)
            } else {
                result[key] = structuredClone(sourceValue)
            }
        }
    }
    return result
}

/** Recursive partial type used by {@link deepMergeConfig}. */
type DeepPartial<T> = { [K in keyof T]?: DeepPartial<T[K]> }

/**
 * Merge a base configuration with any number of partial overrides.
 *
 * Plain objects recurse; arrays, primitives, and explicit `null` replace.
 */
export function deepMergeConfig(
    base: SpecOpsConfig,
    ...overrides: Array<DeepPartial<SpecOpsConfig>>
): SpecOpsConfig {
    return deepMerge(base, ...overrides) as SpecOpsConfig
}

/** Set of valid {@link RiskFacet} values, used to validate routing overrides. */
const RISK_FACETS = new Set<RiskFacet>([
    "security",
    "data",
    "public-contract",
    "concurrency",
    "resilience",
    "performance",
    "infrastructure",
    "migration",
    "usability",
    "maintainability",
])

// The canonical severity set lives in the shared contracts module so the
// generate-contracts script and parser share the single source of truth.
import { SEVERITIES } from "./workflow/contracts.js"

/**
 * Parse and reject unknown configuration fields instead of silently carrying
 * them forward.
 *
 * Walks each nested section through a dedicated parser so that any unknown
 * key, wrong type, or out-of-range value raises a descriptive error before the
 * configuration reaches the workflow.
 *
 * @param value - Raw, untyped configuration (typically parsed from JSON).
 * @returns A validated {@link SpecOpsConfig}.
 * @throws {Error} If any field is unknown, mistyped, or out of range.
 */
export function validateConfig(value: unknown): SpecOpsConfig {
    const root = asObject(value, "root")
    assertKeys(
        root,
        [
            "version",
            "openspec",
            "workflow",
            "routing",
            "automation",
            "escalation",
            "frontier",
            "review",
            "integrations",
            "$schema",
        ],
        "root",
    )
    if (root.version !== 2) {
        throw new Error("invalid SpecOps configuration field: version")
    }

    const openspec = parseOpenSpec(root.openspec)
    const workflow = parseWorkflow(root.workflow)
    const routing = parseRouting(root.routing)
    const automation = parseAutomation(root.automation)
    const escalation = parseEscalation(root.escalation)
    const frontier = parseFrontier(root.frontier ?? {})
    const review = parseReview(root.review)
    const integrations = parseIntegrations(root.integrations)

    return {
        version: 2,
        openspec,
        workflow,
        routing,
        automation,
        escalation,
        frontier,
        review,
        integrations,
    }
}

/**
 * Parse the optional adaptive frontier policy.
 *
 * Missing fields inherit disabled, bounded defaults so existing project
 * configuration remains valid after the feature is installed.
 *
 * @param value - Raw `frontier` section.
 * @returns The validated frontier policy.
 */
function parseFrontier(value: unknown): SpecOpsConfig["frontier"] {
    const source = asObject(value, "frontier")
    assertKeys(
        source,
        ["mode", "maxEscalationsPerRun", "maxDispatchesPerRun", "maxHighDispatchesPerRun"],
        "frontier",
    )
    const mode = source.mode ?? DEFAULT_CONFIG.frontier.mode
    if (!isOneOf(mode, ["disabled", "adaptive"])) {
        throw new Error("invalid SpecOps configuration field: frontier.mode")
    }
    const result = {
        mode,
        maxEscalationsPerRun: positiveInteger(
            source.maxEscalationsPerRun ?? DEFAULT_CONFIG.frontier.maxEscalationsPerRun,
            "frontier.maxEscalationsPerRun",
            0,
        ),
        maxDispatchesPerRun: positiveInteger(
            source.maxDispatchesPerRun ?? DEFAULT_CONFIG.frontier.maxDispatchesPerRun,
            "frontier.maxDispatchesPerRun",
            0,
        ),
        maxHighDispatchesPerRun: positiveInteger(
            source.maxHighDispatchesPerRun ?? DEFAULT_CONFIG.frontier.maxHighDispatchesPerRun,
            "frontier.maxHighDispatchesPerRun",
            0,
        ),
    }
    if (
        result.maxHighDispatchesPerRun > result.maxDispatchesPerRun ||
        (result.mode === "adaptive" &&
            (result.maxEscalationsPerRun === 0 || result.maxDispatchesPerRun === 0))
    ) {
        throw new Error("invalid SpecOps configuration field: frontier")
    }
    return result
}

/**
 * Parse the `openspec` section: `command` must be a non-empty string array or
 * `null` (disabled).
 *
 * @param value - Raw `openspec` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["openspec"] object.
 * @throws {Error} If `command` is a non-string, empty, or empty-element array.
 */
function parseOpenSpec(value: unknown): SpecOpsConfig["openspec"] {
    const source = asObject(value, "openspec")
    assertKeys(source, ["command"], "openspec")
    if (source.command === null) {
        return { command: null }
    }
    if (
        !Array.isArray(source.command) ||
        !source.command.length ||
        source.command.some(argument => typeof argument !== "string" || !argument)
    ) {
        throw new Error("invalid SpecOps configuration field: openspec.command")
    }
    return { command: source.command as string[] }
}

/**
 * Parse the `workflow` section: validates `defaultTier` and the
 * four scope thresholds, and ensures full-tier thresholds exceed lean-tier ones.
 *
 * @param value - Raw `workflow` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["workflow"] object.
 * @throws {Error} If any field is unknown, mistyped, or thresholds are inverted.
 */
function parseWorkflow(value: unknown): SpecOpsConfig["workflow"] {
    const source = asObject(value, "workflow")
    assertKeys(source, ["defaultTier", "scopeThresholds"], "workflow")
    if (!isOneOf(source.defaultTier, ["auto", "lean", "standard", "full"])) {
        throw new Error("invalid SpecOps configuration field: workflow.defaultTier")
    }
    const thresholds = asObject(source.scopeThresholds, "workflow.scopeThresholds")
    assertKeys(
        thresholds,
        ["leanMaxFiles", "leanMaxModules", "fullMinFiles", "fullMinModules"],
        "workflow.scopeThresholds",
    )
    const scopeThresholds = {
        leanMaxFiles: positiveInteger(
            thresholds.leanMaxFiles,
            "workflow.scopeThresholds.leanMaxFiles",
        ),
        leanMaxModules: positiveInteger(
            thresholds.leanMaxModules,
            "workflow.scopeThresholds.leanMaxModules",
        ),
        fullMinFiles: positiveInteger(
            thresholds.fullMinFiles,
            "workflow.scopeThresholds.fullMinFiles",
        ),
        fullMinModules: positiveInteger(
            thresholds.fullMinModules,
            "workflow.scopeThresholds.fullMinModules",
        ),
    }
    if (
        scopeThresholds.fullMinFiles <= scopeThresholds.leanMaxFiles ||
        scopeThresholds.fullMinModules <= scopeThresholds.leanMaxModules
    ) {
        throw new Error("invalid SpecOps configuration field: workflow.scopeThresholds")
    }

    return {
        defaultTier: source.defaultTier,
        scopeThresholds,
    }
}

/**
 * Parse the `routing` section: `forceFullForFacets` must be an array of valid
 * {@link RiskFacet} values.
 *
 * @param value - Raw `routing` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["routing"] object.
 * @throws {Error} If `forceFullForFacets` is not an array of known risk facets.
 */
function parseRouting(value: unknown): SpecOpsConfig["routing"] {
    const source = asObject(value, "routing")
    assertKeys(source, ["forceFullForFacets"], "routing")
    if (
        !Array.isArray(source.forceFullForFacets) ||
        source.forceFullForFacets.some(facet => !RISK_FACETS.has(String(facet) as RiskFacet))
    ) {
        throw new Error("invalid SpecOps configuration field: routing.forceFullForFacets")
    }
    return { forceFullForFacets: source.forceFullForFacets as RiskFacet[] }
}

/**
 * Parse the `automation` section: `requireCleanWorktree` must be a boolean.
 *
 * @param value - Raw `automation` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["automation"] object.
 * @throws {Error} If `requireCleanWorktree` is not a boolean.
 */
function parseAutomation(value: unknown): SpecOpsConfig["automation"] {
    const source = asObject(value, "automation")
    assertKeys(source, ["requireCleanWorktree"], "automation")
    if (typeof source.requireCleanWorktree !== "boolean") {
        throw new Error("invalid SpecOps configuration field: automation.requireCleanWorktree")
    }
    return { requireCleanWorktree: source.requireCleanWorktree }
}

/**
 * Parse the `escalation` section: verifies `budgets` and each of the four
 * budget fields is a non-negative integer.
 *
 * @param value - Raw `escalation` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["escalation"] object.
 * @throws {Error} If any budget field is missing, non-integer, or negative.
 */
function parseEscalation(value: unknown): SpecOpsConfig["escalation"] {
    const source = asObject(value, "escalation")
    assertKeys(source, ["budgets"], "escalation")
    const budget = asObject(source.budgets, "escalation.budgets")
    assertKeys(
        budget,
        [
            "maxScopeEscalations",
            "maxSpecialistDispatches",
            "maxRepairCycles",
            "maxRepeatedFailureFingerprints",
        ],
        "escalation.budgets",
    )
    return {
        budgets: {
            maxScopeEscalations: positiveInteger(
                budget.maxScopeEscalations,
                "escalation.budgets.maxScopeEscalations",
                0,
            ),
            maxSpecialistDispatches: positiveInteger(
                budget.maxSpecialistDispatches,
                "escalation.budgets.maxSpecialistDispatches",
                0,
            ),
            maxRepairCycles: positiveInteger(
                budget.maxRepairCycles,
                "escalation.budgets.maxRepairCycles",
                0,
            ),
            maxRepeatedFailureFingerprints: positiveInteger(
                budget.maxRepeatedFailureFingerprints,
                "escalation.budgets.maxRepeatedFailureFingerprints",
                0,
            ),
        },
    }
}

/**
 * Parse the `review` section: validates all review-related fields including
 * `blockingSeverities`, byte limits, timeouts, and retry count.
 *
 * @param value - Raw `review` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["review"] object.
 * @throws {Error} If any field is missing, mistyped, or out of range.
 */
function parseReview(value: unknown): SpecOpsConfig["review"] {
    const source = asObject(value, "review")
    assertKeys(
        source,
        [
            "blockingSeverities",
            "maxDiffBytes",
            "maxContextBytes",
            "transientRetries",
            "commandTimeoutSeconds",
            "commandOutputBytes",
        ],
        "review",
    )
    if (
        !Array.isArray(source.blockingSeverities) ||
        source.blockingSeverities.some(severity => !SEVERITIES.has(String(severity)))
    ) {
        throw new Error("invalid SpecOps configuration field: review.blockingSeverities")
    }
    return {
        blockingSeverities:
            source.blockingSeverities as SpecOpsConfig["review"]["blockingSeverities"],
        maxDiffBytes: positiveInteger(source.maxDiffBytes, "review.maxDiffBytes", 1_000),
        maxContextBytes: positiveInteger(source.maxContextBytes, "review.maxContextBytes", 1_000),
        transientRetries: positiveInteger(source.transientRetries, "review.transientRetries", 0),
        commandTimeoutSeconds: positiveInteger(
            source.commandTimeoutSeconds,
            "review.commandTimeoutSeconds",
            1,
        ),
        commandOutputBytes: positiveInteger(
            source.commandOutputBytes,
            "review.commandOutputBytes",
            1_024,
        ),
    }
}

/**
 * Parse the `integrations` section: `mcp` must be either `"allow"` or
 * `"disabled"`.
 *
 * @param value - Raw `integrations` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["integrations"] object.
 * @throws {Error} If `mcp` is not one of the allowed values.
 */
function parseIntegrations(value: unknown): SpecOpsConfig["integrations"] {
    const source = asObject(value, "integrations")
    assertKeys(source, ["mcp"], "integrations")
    if (!isOneOf(source.mcp, ["allow", "disabled"])) {
        throw new Error("invalid SpecOps configuration field: integrations.mcp")
    }
    return { mcp: source.mcp }
}

/**
 * Validate a partial configuration file.
 *
 * Allows any section to be omitted, but rejects unknown keys and validates the
 * type and range of every key that is present. Missing fields are filled from
 * {@link DEFAULT_CONFIG} only for the purpose of strict validation; the returned
 * object contains only the keys supplied by the caller.
 *
 * @param value - Raw, untyped partial configuration (typically parsed from JSON).
 * @param sourcePath - Optional absolute path used to make error messages name
 *   the offending file.
 * @returns The validated partial configuration.
 * @throws {Error} If any present field is unknown, mistyped, or out of range.
 */
export function validatePartialConfig(value: unknown, sourcePath?: string): Partial<SpecOpsConfig> {
    const prefix = sourcePath ? `in ${sourcePath}: ` : ""
    const fail = (error: unknown): never => {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${prefix}${message}`)
    }

    try {
        const root = asObject(value, "root")
        assertKeys(
            root,
            [
                "version",
                "openspec",
                "workflow",
                "routing",
                "automation",
                "escalation",
                "frontier",
                "review",
                "integrations",
                "$schema",
            ],
            "root",
        )

        const partial: Record<string, unknown> = {}
        if ("version" in root) {
            if (root.version !== 2) {
                throw new Error("invalid SpecOps configuration field: version")
            }
            partial.version = 2
        }
        if (root.openspec !== undefined) {
            partial.openspec = validateSectionPartial(
                root.openspec,
                "openspec",
                DEFAULT_CONFIG.openspec,
                parseOpenSpec,
            )
        }
        if (root.workflow !== undefined) {
            partial.workflow = validateSectionPartial(
                root.workflow,
                "workflow",
                DEFAULT_CONFIG.workflow,
                parseWorkflow,
            )
        }
        if (root.routing !== undefined) {
            partial.routing = validateSectionPartial(
                root.routing,
                "routing",
                DEFAULT_CONFIG.routing,
                parseRouting,
            )
        }
        if (root.automation !== undefined) {
            partial.automation = validateSectionPartial(
                root.automation,
                "automation",
                DEFAULT_CONFIG.automation,
                parseAutomation,
            )
        }
        if (root.escalation !== undefined) {
            partial.escalation = validateSectionPartial(
                root.escalation,
                "escalation",
                DEFAULT_CONFIG.escalation,
                parseEscalation,
            )
        }
        if (root.frontier !== undefined) {
            partial.frontier = validateSectionPartial(
                root.frontier,
                "frontier",
                DEFAULT_CONFIG.frontier,
                parseFrontier,
            )
        }
        if (root.review !== undefined) {
            partial.review = validateSectionPartial(
                root.review,
                "review",
                DEFAULT_CONFIG.review,
                parseReview,
            )
        }
        if (root.integrations !== undefined) {
            partial.integrations = validateSectionPartial(
                root.integrations,
                "integrations",
                DEFAULT_CONFIG.integrations,
                parseIntegrations,
            )
        }
        return partial as Partial<SpecOpsConfig>
    } catch (error) {
        return fail(error)
    }
}

/**
 * Validate one supplied section against its strict parser while allowing the
 * section itself to omit fields.
 *
 * Contract: `parseStrict` validates (throwing on unknown or mistyped keys) but
 * does not normalize values, so the original partial is returned unchanged. The
 * runtime parsers are pure validators; if any ever begin coercing values, this
 * function must return the parsed section rather than the raw input.
 */
function validateSectionPartial<T>(
    value: unknown,
    name: string,
    defaultSection: T,
    parseStrict: (merged: unknown) => T,
): Partial<T> {
    const partial = asObject(value, name)
    parseStrict(deepMerge(defaultSection, partial) as T)
    return partial as Partial<T>
}

/**
 * Ordered list of top-level configuration sections recognised by the strict
 * validator. Used by {@link validateConfigLenient} to iterate the same sections
 * in a stable order so salvaged-key reporting is deterministic.
 */
const CONFIG_SECTIONS = [
    "openspec",
    "workflow",
    "routing",
    "automation",
    "escalation",
    "frontier",
    "review",
    "integrations",
] as const

/**
 * Best-effort salvage of a configuration file that has failed strict validation.
 *
 * Unlike {@link validatePartialConfig}, this validator never throws: it skips
 * any unknown top-level key, drops any section whose strict parser rejects, and
 * returns only the partial that survived. The strict parsers are pure
 * validators, so the surviving sections are returned unchanged from the input.
 *
 * @param value - Raw, untyped configuration (typically parsed from JSON, or
 *   `{}` when the file failed JSON parsing entirely).
 * @returns The salvaged partial and the list of top-level sections kept.
 */
export function validateConfigLenient(value: unknown): {
    partial: Partial<SpecOpsConfig>
    recoveredSections: string[]
} {
    const recoveredSections: string[] = []
    if (!isObject(value)) {
        return { partial: {}, recoveredSections }
    }
    const root = value as Record<string, unknown>
    const partial: Record<string, unknown> = {}
    if (root.version === 2) {
        partial.version = 2
    }
    for (const name of CONFIG_SECTIONS) {
        const sectionValue = root[name]
        if (sectionValue === undefined) continue
        const parser = SECTION_PARSERS[name]
        try {
            const sectionPartial = asObject(sectionValue, name)
            parser(deepMerge(DEFAULT_CONFIG[name], sectionPartial))
            partial[name] = structuredClone(sectionPartial)
            recoveredSections.push(name)
        } catch {
            // Drop the entire section; its default is filled by deep-merge.
        }
    }
    return { partial: partial as Partial<SpecOpsConfig>, recoveredSections }
}

/** Strict section parsers keyed by top-level section name. */
const SECTION_PARSERS: Record<(typeof CONFIG_SECTIONS)[number], (merged: unknown) => unknown> = {
    openspec: parseOpenSpec,
    workflow: parseWorkflow,
    routing: parseRouting,
    automation: parseAutomation,
    escalation: parseEscalation,
    frontier: parseFrontier,
    review: parseReview,
    integrations: parseIntegrations,
}

/**
 * Resolve configuration from defaults, the global user file, and the project
 * file, applying deep-merge precedence.
 *
 * Each file is read and validated with the strict partial validator. When a
 * file fails JSON parsing or strict validation, the lenient validator salvages
 * every top-level section that still parses, the file is rewritten in place
 * with the salvaged partial deep-merged onto defaults (preserving the
 * `$schema` header), and a {@link ConfigRepair} is recorded in module state
 * for the next `doctor` run. The merged result is then validated with the
 * strict complete validator; if even the salvage merge fails to validate,
 * pure {@link DEFAULT_CONFIG} is returned and both files are flagged.
 *
 * This mirrors the repair-on-load behaviour of `materializeAgentManifest` so a
 * single bad field never prevents the plugin from loading.
 *
 * @param directory - Project root directory (`.opencode/specops.json` is read
 *   from here).
 * @returns A validated {@link SpecOpsConfig}.
 */
export async function resolveConfig(directory: string): Promise<SpecOpsConfig> {
    resetConfigRepairs()
    const globalPath = resolveGlobalConfigPath()
    const projectPath = path.join(directory, ".opencode", "specops.json")
    const [globalResult, projectResult] = await Promise.all([
        readPartialConfigWithRepair(globalPath),
        readPartialConfigWithRepair(projectPath),
    ])
    const repairs: ConfigRepair[] = []
    if (globalResult.repair) repairs.push(globalResult.repair)
    if (projectResult.repair) repairs.push(projectResult.repair)

    let merged: SpecOpsConfig
    try {
        merged = validateConfig(
            deepMergeConfig(DEFAULT_CONFIG, globalResult.partial, projectResult.partial),
        )
    } catch (error) {
        // The merge of valid partials onto defaults must always validate; if it
        // somehow does not, fall back to pure defaults. The repairs collected
        // from the read step already describe the offending files.
        const message = error instanceof Error ? error.message : String(error)
        void message
        merged = structuredClone(DEFAULT_CONFIG)
    }

    for (const repair of repairs) {
        const salvaged = repair.path === globalPath ? globalResult.partial : projectResult.partial
        await writeRepairedConfig(repair.path, repair.recoveredSections, salvaged)
    }
    lastRepairs = repairs
    return merged
}

/**
 * Read and partially validate a single configuration file, tolerating absence
 * and self-healing on any other failure.
 *
 * On `ENOENT` returns an empty partial with no repair. On JSON parse failure or
 * strict validation failure, runs the lenient validator against the raw value
 * (or `{}` when the file did not parse as JSON) to salvage surviving sections,
 * and returns both the salvaged partial and a {@link ConfigRepair} for the
 * caller to persist and surface.
 */
async function readPartialConfigWithRepair(
    filePath: string,
): Promise<{ partial: Partial<SpecOpsConfig>; repair?: ConfigRepair }> {
    let raw: unknown
    try {
        raw = JSON.parse(await readFile(filePath, "utf8"))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { partial: {} }
        }
        const reason = error instanceof Error ? error.message : String(error)
        const { partial, recoveredSections } = validateConfigLenient({})
        return {
            partial,
            repair: { path: filePath, reason, recoveredSections },
        }
    }
    try {
        const partial = validatePartialConfig(raw, filePath)
        return { partial }
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const { partial, recoveredSections } = validateConfigLenient(raw)
        return {
            partial,
            repair: { path: filePath, reason, recoveredSections },
        }
    }
}

/**
 * Rewrite a repaired configuration file with defaults deep-merged onto the
 * salvaged partial, preserving the `$schema` header.
 *
 * Only the sections this file salvaged are carried forward; their values come
 * from the lenient-validated partial so the user's surviving settings are
 * preserved rather than reset. The output mirrors the shape produced by
 * {@link materializeGlobalConfig}.
 */
async function writeRepairedConfig(
    destination: string,
    recoveredSections: readonly string[],
    salvagedPartial: Partial<SpecOpsConfig>,
): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true })
    const salvaged: Record<string, unknown> = { version: 2 }
    const salvagedRecord = salvagedPartial as Record<string, unknown>
    for (const name of recoveredSections) {
        const value = salvagedRecord[name]
        if (value !== undefined) salvaged[name] = structuredClone(value)
    }
    const document = {
        $schema: SPECOPS_CONFIG_SCHEMA_URL,
        ...structuredClone(DEFAULT_CONFIG),
        ...salvaged,
    }
    await writeFile(destination, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
    })
}

/**
 * Assert that a value is a non-null, non-array object and return it as a
 * `Record<string, unknown>`.
 *
 * @param value - Value to check.
 * @param name - Human-readable field path used in the error message.
 * @returns `value` cast to `Record<string, unknown>`.
 * @throws {Error} If `value` is null, not an object, or an array.
 */
function asObject(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`invalid SpecOps configuration: ${name}`)
    }
    return value as Record<string, unknown>
}

/**
 * Assert that a record's keys are a subset of the allowed set, rejecting
 * unknown keys.
 *
 * @param value - The record to validate.
 * @param allowed - Array of permitted key names.
 * @param name - Human-readable field path used in the error message.
 * @throws {Error} If any key in `value` is not present in `allowed`.
 */
function assertKeys(value: Record<string, unknown>, allowed: string[], name: string): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            throw new Error(`invalid SpecOps configuration field: ${name}.${key}`)
        }
    }
}

/**
 * Assert that a value is an integer at or above `minimum`.
 *
 * @param value - Value to check.
 * @param name - Human-readable field path used in the error message.
 * @param minimum - Inclusive lower bound; defaults to `1`.
 * @returns The validated integer.
 * @throws {Error} If `value` is not an integer or is below `minimum`.
 */
function positiveInteger(value: unknown, name: string, minimum = 1): number {
    if (!Number.isInteger(value) || Number(value) < minimum) {
        throw new Error(`invalid SpecOps configuration field: ${name}`)
    }
    return Number(value)
}

/**
 * Type guard: returns whether `value` is one of the supplied string choices.
 *
 * @param value - Value to test.
 * @param choices - Allowed string literals.
 * @returns `true` when `value` is a string contained in `choices`.
 */
function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
    return typeof value === "string" && choices.includes(value as T)
}

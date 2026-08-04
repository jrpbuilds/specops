import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveGlobalConfigPath } from "./installation.js"
import type { EscalationBudget, RiskFacet, ScopeTier } from "./types.js"
import { isObject, asObject, assertKeys } from "./config/fields.js"
import {
    parseAutomation,
    parseEscalation,
    parseFrontier,
    parseIntegrations,
    parseOpenSpec,
    parseReview,
    parseRouting,
    parseWorkflow,
} from "./config/sections.js"

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
    /**
     * OpenSpec integration.
     *
     * `command` is the argv used to invoke the OpenSpec CLI, or `null` to use the
     * bundled executable. `autoArchive` controls whether a successful workflow
     * finalization archives the change automatically (default `true`).
     */
    openspec: { command: string[] | null; autoArchive: boolean }
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
    /** OpenSpec CLI disabled by default; users opt in by setting `openspec.command`. Auto-archive defaults to enabled. */
    openspec: { command: null, autoArchive: true },
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

/**
 * Bound frontier parser: supplies `DEFAULT_CONFIG.frontier` as the defaults
 * so the exported `parseFrontier` (which takes defaults explicitly) can be
 * used everywhere `config.ts` used to call the unbound parser.
 */
const parseFrontierConfig = (value: unknown): SpecOpsConfig["frontier"] =>
    parseFrontier(value, DEFAULT_CONFIG.frontier)

/**
 * Relative schema reference shared by the generated global and project
 * configuration files.
 *
 * SpecOps materialises a sibling `specops.schema.json` next to each generated
 * config file so editor validation works without network access.
 */
const SPECOPS_CONFIG_SCHEMA_REFERENCE = "./specops.schema.json"

// `config.ts` is emitted directly into `dist`, so one parent reaches the
// package root in both source and packed layouts. Keeping this package-relative
// avoids source-checkout path leakage.
const PACKAGED_CONFIG_SCHEMA_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "examples",
    "specops.schema.json",
)

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
 * Materialise the package-bundled JSON Schema next to a configuration file.
 *
 * The schema is plugin-owned, so it is overwritten unconditionally to keep it
 * current after plugin updates. The adjacent config file remains user-owned and
 * is never modified by this helper.
 *
 * @param destination - Path of the adjacent user configuration file.
 */
async function materializeConfigSchema(destination: string): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true })
    const schema = await readFile(PACKAGED_CONFIG_SCHEMA_PATH, "utf8")
    const schemaDestination = path.join(path.dirname(destination), "specops.schema.json")
    await writeFile(schemaDestination, schema, { encoding: "utf8" })
}

/**
 * Create the complete global configuration when it does not exist.
 *
 * The exclusive file creation preserves user-owned partial or invalid files,
 * while the generated document exposes every current configuration field. A
 * sibling `specops.schema.json` is always materialised or refreshed so editor
 * validation works locally and offline.
 * @param destination - Optional global configuration path, primarily for tests.
 * @returns The resolved path and whether this call created the file.
 */
export async function materializeGlobalConfig(
    destination: string = resolveGlobalConfigPath(),
): Promise<GlobalConfigMaterialisation> {
    await materializeConfigSchema(destination)
    const document = {
        $schema: SPECOPS_CONFIG_SCHEMA_REFERENCE,
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
    const frontier = parseFrontierConfig(root.frontier ?? {})
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
                parseFrontierConfig,
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
    frontier: parseFrontierConfig,
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
    await materializeConfigSchema(destination)
    const salvaged: Record<string, unknown> = { version: 2 }
    const salvagedRecord = salvagedPartial as Record<string, unknown>
    for (const name of recoveredSections) {
        const value = salvagedRecord[name]
        if (value !== undefined) salvaged[name] = structuredClone(value)
    }
    const document = {
        $schema: SPECOPS_CONFIG_SCHEMA_REFERENCE,
        ...structuredClone(DEFAULT_CONFIG),
        ...salvaged,
    }
    await writeFile(destination, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
    })
}

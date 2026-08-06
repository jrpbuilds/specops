import { asObject, assertKeys, isOneOf, positiveInteger } from "./fields.js"
import type { RiskFacet } from "../types.js"
import type { SpecOpsConfig } from "../config.js"
// The legacy parser uses the canonical severity set from contracts.
import { SEVERITIES } from "../workflow/contracts.js"

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

/**
 * Run the common section spine: narrow `value` to a plain object, reject
 * unknown section keys, then invoke explicit section-specific validation.
 *
 * `build` receives the raw source object and the section name and returns
 * the fully-assembled section. It MUST throw
 * `Error("invalid SpecOps configuration field: ${name}.X")` on any bad field
 * so that `validateConfigLenient`'s `catch {}` drops the whole section
 * uniformly.
 *
 * `build` is responsible for all bespoke validation: unions, nested objects,
 * cross-field checks, and any per-field defaults the caller supplies.
 */
function parseSection<T>(
    value: unknown,
    name: string,
    allowedKeys: readonly string[],
    build: (source: Record<string, unknown>, name: string) => T,
): T {
    const source = asObject(value, name)
    assertKeys(source, allowedKeys, name)
    return build(source, name)
}

/**
 * Parse the `routing` section: `forceFullForFacets` must be an array of valid
 * {@link RiskFacet} values.
 *
 * @param value - Raw `routing` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["routing"] object.
 * @throws {Error} If `forceFullForFacets` is not an array of known risk facets.
 */
export function parseRouting(value: unknown): SpecOpsConfig["routing"] {
    return parseSection(value, "routing", ["forceFullForFacets"], source => {
        if (
            !Array.isArray(source.forceFullForFacets) ||
            source.forceFullForFacets.some(facet => !RISK_FACETS.has(String(facet) as RiskFacet))
        ) {
            throw new Error("invalid SpecOps configuration field: routing.forceFullForFacets")
        }
        return { forceFullForFacets: source.forceFullForFacets as RiskFacet[] }
    })
}

/**
 * Parse the `automation` section: `requireCleanWorktree` must be a boolean.
 *
 * @param value - Raw `automation` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["automation"] object.
 * @throws {Error} If `requireCleanWorktree` is not a boolean.
 */
export function parseAutomation(value: unknown): SpecOpsConfig["automation"] {
    return parseSection(value, "automation", ["requireCleanWorktree"], source => {
        if (typeof source.requireCleanWorktree !== "boolean") {
            throw new Error("invalid SpecOps configuration field: automation.requireCleanWorktree")
        }
        return { requireCleanWorktree: source.requireCleanWorktree }
    })
}

/**
 * Parse the `integrations` section: `mcp` must be either `"allow"` or
 * `"disabled"`.
 *
 * @param value - Raw `integrations` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["integrations"] object.
 * @throws {Error} If `mcp` is not one of the allowed values.
 */
export function parseIntegrations(value: unknown): SpecOpsConfig["integrations"] {
    return parseSection(value, "integrations", ["mcp"], source => {
        if (!isOneOf(source.mcp, ["allow", "disabled"])) {
            throw new Error("invalid SpecOps configuration field: integrations.mcp")
        }
        return { mcp: source.mcp }
    })
}

/**
 * Parse the `escalation` section: verifies `budgets` and each of the four
 * budget fields is a non-negative integer.
 *
 * @param value - Raw `escalation` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["escalation"] object.
 * @throws {Error} If any budget field is missing, non-integer, or negative.
 */
export function parseEscalation(value: unknown): SpecOpsConfig["escalation"] {
    return parseSection(value, "escalation", ["budgets"], source => {
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
    })
}

/**
 * Parse the `review` section: validates all review-related fields including
 * `blockingSeverities`, byte limits, timeouts, and retry count.
 *
 * @param value - Raw `review` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["review"] object.
 * @throws {Error} If any field is missing, mistyped, or out of range.
 */
export function parseReview(value: unknown): SpecOpsConfig["review"] {
    return parseSection(
        value,
        "review",
        [
            "blockingSeverities",
            "maxDiffBytes",
            "maxContextBytes",
            "transientRetries",
            "commandTimeoutSeconds",
            "commandOutputBytes",
        ],
        source => {
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
                maxContextBytes: positiveInteger(
                    source.maxContextBytes,
                    "review.maxContextBytes",
                    1_000,
                ),
                transientRetries: positiveInteger(
                    source.transientRetries,
                    "review.transientRetries",
                    0,
                ),
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
        },
    )
}

/**
 * Parse the `openspec` section: `command` must be a non-empty string array or
 * `null` (disabled), and `autoArchive` must be a boolean.
 *
 * @param value - Raw `openspec` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["openspec"] object.
 * @throws {Error} If `command` is invalid or `autoArchive` is not a boolean.
 */
export function parseOpenSpec(value: unknown): SpecOpsConfig["openspec"] {
    return parseSection(value, "openspec", ["command", "autoArchive"], source => {
        if (typeof source.autoArchive !== "boolean") {
            throw new Error("invalid SpecOps configuration field: openspec.autoArchive")
        }
        if (source.command === null) {
            return { command: null, autoArchive: source.autoArchive }
        }
        if (
            !Array.isArray(source.command) ||
            !source.command.length ||
            source.command.some(argument => typeof argument !== "string" || !argument)
        ) {
            throw new Error("invalid SpecOps configuration field: openspec.command")
        }
        return { command: source.command as string[], autoArchive: source.autoArchive }
    })
}

/**
 * Parse the `workflow` section: validates `defaultTier` and the
 * four scope thresholds, and ensures full-tier thresholds exceed lean-tier ones.
 *
 * @param value - Raw `workflow` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["workflow"] object.
 * @throws {Error} If any field is unknown, mistyped, or thresholds are inverted.
 */
export function parseWorkflow(value: unknown): SpecOpsConfig["workflow"] {
    return parseSection(value, "workflow", ["defaultTier", "scopeThresholds"], source => {
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
    })
}

/**
 * Parse the optional adaptive frontier policy.
 *
 * Missing fields inherit the supplied `defaults` (the caller passes
 * `DEFAULT_CONFIG.frontier`) so existing project configuration remains valid
 * after the feature is installed. All `??` semantics, mode validation,
 * numeric minimums, and cross-field limits are preserved exactly.
 *
 * `defaults` is supplied by the caller so this module does not import
 * `DEFAULT_CONFIG` (a runtime value) from `../config.js`.
 *
 * @param value - Raw `frontier` section.
 * @param defaults - Frontier defaults to use for any omitted field.
 * @returns The validated frontier policy.
 */
export function parseFrontier(
    value: unknown,
    defaults: SpecOpsConfig["frontier"],
): SpecOpsConfig["frontier"] {
    return parseSection(
        value,
        "frontier",
        ["mode", "maxEscalationsPerRun", "maxDispatchesPerRun", "maxHighDispatchesPerRun"],
        source => {
            const mode = source.mode ?? defaults.mode
            if (!isOneOf(mode, ["disabled", "adaptive"])) {
                throw new Error("invalid SpecOps configuration field: frontier.mode")
            }
            const result = {
                mode,
                maxEscalationsPerRun: positiveInteger(
                    source.maxEscalationsPerRun ?? defaults.maxEscalationsPerRun,
                    "frontier.maxEscalationsPerRun",
                    0,
                ),
                maxDispatchesPerRun: positiveInteger(
                    source.maxDispatchesPerRun ?? defaults.maxDispatchesPerRun,
                    "frontier.maxDispatchesPerRun",
                    0,
                ),
                maxHighDispatchesPerRun: positiveInteger(
                    source.maxHighDispatchesPerRun ?? defaults.maxHighDispatchesPerRun,
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
        },
    )
}

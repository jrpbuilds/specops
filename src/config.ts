import type { EscalationBudget, QuestionBudgets, RiskFacet, ScopeTier } from "./types.js"

/**
 * Strict, clean-install configuration for the final SpecOps architecture.
 *
 * Every field is parsed and validated by {@link validateConfig}; unknown fields
 * are rejected rather than silently carried forward so configuration drift is
 * surfaced at load time.
 */
export type SpecOpsConfig = {
    /** Schema version; currently always `1`. */
    version: 1
    /** OpenSpec integration: `command` is the argv used to invoke the OpenSpec CLI, or `null` to disable. */
    openspec: { command: string[] | null }
    /** Workflow routing and scope-tier configuration. */
    workflow: {
        /** Default tier selected when no assessment-level suggestion overrides it. */
        defaultTier: "auto" | ScopeTier
        /** When to run onboarding: `if-missing` only when absent, `always` on every run. */
        onboarding: "if-missing" | "always"
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
    /** Worker-raised question loop limits and field-size bounds. */
    questions: {
        budgets: QuestionBudgets
        maxPromptLength: number
        maxOptionIdLength: number
        maxOptionLabelLength: number
        maxOtherTextLength: number
        maxMarkerBytes: number
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
        /** Hard timeout for a reviewer agent dispatch, in seconds. */
        agentTimeoutSeconds: number
        /** Hard timeout for a review command execution, in seconds. */
        commandTimeoutSeconds: number
        /** Maximum bytes of command output retained as evidence. */
        commandOutputBytes: number
    }
    /** Integration toggles; `mcp` controls whether MCP servers are inherited. */
    integrations: { mcp: "inherit" | "disabled" }
}

/**
 * Defaults chosen to favour bounded execution in a clean final installation.
 *
 * Each nested value is the canonical baseline that {@link validateConfig}
 * accepts; user configuration overrides these without being merged.
 */
export const DEFAULT_CONFIG: SpecOpsConfig = {
    version: 1,
    /** OpenSpec CLI disabled by default; users opt in by setting `openspec.command`. */
    openspec: { command: null },
    workflow: {
        /** Routing selects the tier from the assessment unless overridden. */
        defaultTier: "auto",
        /** Onboard only when the manifest is absent. */
        onboarding: "if-missing",
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
    questions: {
        budgets: {
            maxQuestionsPerRun: 4,
            maxQuestionsPerDispatch: 1,
            maxRepeatedQuestionFingerprints: 1,
        },
        maxPromptLength: 500,
        maxOptionIdLength: 40,
        maxOptionLabelLength: 120,
        maxOtherTextLength: 1000,
        maxMarkerBytes: 8000,
    },
    review: {
        /** Block on BLOCKER and HIGH findings only. */
        blockingSeverities: ["BLOCKER", "HIGH"],
        maxDiffBytes: 200_000,
        maxContextBytes: 50_000,
        transientRetries: 1,
        agentTimeoutSeconds: 300,
        commandTimeoutSeconds: 300,
        commandOutputBytes: 32_000,
    },
    /** Inherit MCP servers from the host OpenCode installation. */
    integrations: { mcp: "inherit" },
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

/** Set of valid review severity strings, used to validate `review.blockingSeverities`. */
const SEVERITIES = new Set(["BLOCKER", "HIGH", "MEDIUM", "LOW"])

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
            "questions",
            "review",
            "integrations",
            "$schema",
        ],
        "root",
    )
    if (root.version !== 1) {
        throw new Error("invalid SpecOps configuration field: version")
    }

    const openspec = parseOpenSpec(root.openspec)
    const workflow = parseWorkflow(root.workflow)
    const routing = parseRouting(root.routing)
    const automation = parseAutomation(root.automation)
    const escalation = parseEscalation(root.escalation)
    const frontier = parseFrontier(root.frontier ?? {})
    const questions = parseQuestions(root.questions ?? {})
    const review = parseReview(root.review)
    const integrations = parseIntegrations(root.integrations)

    return {
        version: 1,
        openspec,
        workflow,
        routing,
        automation,
        escalation,
        frontier,
        questions,
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
 * Parse the `workflow` section: validates `defaultTier`, `onboarding`, and the
 * four scope thresholds, and ensures full-tier thresholds exceed lean-tier ones.
 *
 * @param value - Raw `workflow` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["workflow"] object.
 * @throws {Error} If any field is unknown, mistyped, or thresholds are inverted.
 */
function parseWorkflow(value: unknown): SpecOpsConfig["workflow"] {
    const source = asObject(value, "workflow")
    assertKeys(source, ["defaultTier", "onboarding", "scopeThresholds"], "workflow")
    if (!isOneOf(source.defaultTier, ["auto", "lean", "standard", "full"])) {
        throw new Error("invalid SpecOps configuration field: workflow.defaultTier")
    }
    if (!isOneOf(source.onboarding, ["if-missing", "always"])) {
        throw new Error("invalid SpecOps configuration field: workflow.onboarding")
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
        onboarding: source.onboarding,
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
 * Parse the `questions` section: validates loop budgets and field-size bounds
 * for worker-raised questions.
 *
 * @param value - Raw `questions` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["questions"] object.
 * @throws {Error} If any field is missing, mistyped, or out of range.
 */
function parseQuestions(value: unknown): SpecOpsConfig["questions"] {
    const source = asObject(value, "questions")
    assertKeys(
        source,
        [
            "budgets",
            "maxPromptLength",
            "maxOptionIdLength",
            "maxOptionLabelLength",
            "maxOtherTextLength",
            "maxMarkerBytes",
        ],
        "questions",
    )

    const budgets =
        source.budgets !== undefined ? asObject(source.budgets, "questions.budgets") : {}
    assertKeys(
        budgets,
        ["maxQuestionsPerRun", "maxQuestionsPerDispatch", "maxRepeatedQuestionFingerprints"],
        "questions.budgets",
    )

    return {
        budgets: {
            maxQuestionsPerRun: positiveInteger(
                budgets.maxQuestionsPerRun ?? DEFAULT_CONFIG.questions.budgets.maxQuestionsPerRun,
                "questions.budgets.maxQuestionsPerRun",
                0,
            ),
            maxQuestionsPerDispatch: positiveInteger(
                budgets.maxQuestionsPerDispatch ??
                    DEFAULT_CONFIG.questions.budgets.maxQuestionsPerDispatch,
                "questions.budgets.maxQuestionsPerDispatch",
                0,
            ),
            maxRepeatedQuestionFingerprints: positiveInteger(
                budgets.maxRepeatedQuestionFingerprints ??
                    DEFAULT_CONFIG.questions.budgets.maxRepeatedQuestionFingerprints,
                "questions.budgets.maxRepeatedQuestionFingerprints",
                0,
            ),
        },
        maxPromptLength: positiveInteger(
            source.maxPromptLength ?? DEFAULT_CONFIG.questions.maxPromptLength,
            "questions.maxPromptLength",
            1,
        ),
        maxOptionIdLength: positiveInteger(
            source.maxOptionIdLength ?? DEFAULT_CONFIG.questions.maxOptionIdLength,
            "questions.maxOptionIdLength",
            1,
        ),
        maxOptionLabelLength: positiveInteger(
            source.maxOptionLabelLength ?? DEFAULT_CONFIG.questions.maxOptionLabelLength,
            "questions.maxOptionLabelLength",
            1,
        ),
        maxOtherTextLength: positiveInteger(
            source.maxOtherTextLength ?? DEFAULT_CONFIG.questions.maxOtherTextLength,
            "questions.maxOtherTextLength",
            1,
        ),
        maxMarkerBytes: positiveInteger(
            source.maxMarkerBytes ?? DEFAULT_CONFIG.questions.maxMarkerBytes,
            "questions.maxMarkerBytes",
            1,
        ),
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
            "agentTimeoutSeconds",
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
        agentTimeoutSeconds: positiveInteger(
            source.agentTimeoutSeconds,
            "review.agentTimeoutSeconds",
            30,
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
}

/**
 * Parse the `integrations` section: `mcp` must be either `"inherit"` or
 * `"disabled"`.
 *
 * @param value - Raw `integrations` value from the configuration.
 * @returns The parsed {@link SpecOpsConfig}["integrations"] object.
 * @throws {Error} If `mcp` is not one of the allowed values.
 */
function parseIntegrations(value: unknown): SpecOpsConfig["integrations"] {
    const source = asObject(value, "integrations")
    assertKeys(source, ["mcp"], "integrations")
    if (!isOneOf(source.mcp, ["inherit", "disabled"])) {
        throw new Error("invalid SpecOps configuration field: integrations.mcp")
    }
    return { mcp: source.mcp }
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

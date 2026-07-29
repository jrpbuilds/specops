/**
 * Canonical runtime identifiers for every SpecOps agent.
 *
 * Commands, capability routing, prompts, manifests, diagnostics, and tests
 * consume these constants. No consumer should independently spell an agent ID.
 */
export const AGENT_IDS = {
    controller: {
        automatic: "specops-auto-controller",
        interactive: "specops-interactive-controller",
    },
    core: {
        assessor: "specops-assessor",
        explorer: "specops-explorer",
        planner: "specops-planner",
        designer: "specops-designer",
        implementer: "specops-implementer",
        verifier: "specops-verifier",
        repairer: "specops-repairer",
    },
    review: {
        risk: "specops-risk-reviewer",
        correctnessJudge: "specops-correctness-judge",
        complianceJudge: "specops-compliance-judge",
        refuter: "specops-review-refuter",
        frontierLow: "specops-frontier-low",
        frontierHigh: "specops-frontier-high",
    },
    specialist: {
        security: "specops-security-specialist",
        dataMigration: "specops-data-migration-specialist",
        contract: "specops-contract-specialist",
        concurrency: "specops-concurrency-specialist",
        resilience: "specops-resilience-specialist",
        performance: "specops-performance-specialist",
        infrastructure: "specops-infrastructure-specialist",
        usability: "specops-usability-specialist",
        maintainability: "specops-maintainability-specialist",
    },
} as const

/** Extract the value types of a record type. */
type Values<T> = T[keyof T]

/** Union of all values in {@link AGENT_IDS}. */
export type AgentId =
    | Values<(typeof AGENT_IDS)["controller"]>
    | Values<(typeof AGENT_IDS)["core"]>
    | Values<(typeof AGENT_IDS)["review"]>
    | Values<(typeof AGENT_IDS)["specialist"]>

/**
 * Ordered final catalogue used for exact-set validation and generation.
 *
 * Flattens every group from {@link AGENT_IDS} into a single ordered array so
 * consumers like the registry guard can assert that every ID has a
 * corresponding policy entry.
 */
export const ALL_AGENT_IDS: readonly AgentId[] = [
    ...Object.values(AGENT_IDS.controller),
    ...Object.values(AGENT_IDS.core),
    ...Object.values(AGENT_IDS.review),
    ...Object.values(AGENT_IDS.specialist),
]

/**
 * Controller IDs that public commands are allowed to select directly.
 *
 * Excludes sub-agent IDs so external callers cannot bypass capability routing
 * by naming a non-controller agent.
 */
export const CONTROLLER_AGENT_IDS = [
    AGENT_IDS.controller.interactive,
    AGENT_IDS.controller.automatic,
] as const

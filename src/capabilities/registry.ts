import type { CapabilityId, DispatchPurpose, RiskFacet } from "../types.js"
import { AGENT_IDS, ALL_AGENT_IDS, type AgentId } from "./ids.js"

export type { AgentId } from "./ids.js"

/** Access control flags for a single agent. */
type AgentPermission = {
    bash: "allow" | "deny"
    edit: "allow" | "deny"
}

/**
 * Canonical capabilities, model defaults, and non-overridable permissions.
 *
 * Every agent in the system has exactly one policy that fixes its id, role,
 * model, step budget, execution mode (primary or subagent), tool availability,
 * and permissions. Manifests may tune provider options but cannot change the
 * fields defined here.
 */
export type AgentPolicy = {
    id: AgentId
    role: string
    model: string
    steps: number
    mode: "primary" | "subagent"
    tools: { question?: boolean; todowrite?: boolean; task?: boolean }
    permission: AgentPermission
}

/** Permission preset: no bash or edit access. */
const READ_ONLY: AgentPermission = { bash: "deny", edit: "deny" }

/** Permission preset: full bash and edit access. */
const WRITER: AgentPermission = { bash: "allow", edit: "allow" }

/** Permission preset: bash access but no edit access. */
const VERIFIER: AgentPermission = { bash: "allow", edit: "deny" }

/**
 * Human-readable role catalogue generated alongside the runtime policies.
 *
 * Each entry is a short description of the agent's purpose in the workflow.
 */
const AGENT_ROLES: Record<AgentId, string> = {
    [AGENT_IDS.controller.automatic]:
        "Automatic OpenCode controller shared by visible TUI and non-interactive run adapters.",
    [AGENT_IDS.controller.interactive]: "Primary controller with user checkpoints.",
    [AGENT_IDS.core.assessor]: "Produces the strict initial scope and risk assessment.",
    [AGENT_IDS.core.explorer]: "Collects repository-grounded planning evidence.",
    [AGENT_IDS.core.planner]: "Produces requirements bundles and refined tasks.",
    [AGENT_IDS.core.designer]: "Produces an independent Full-tier technical design.",
    [AGENT_IDS.core.implementer]: "Mutates repository code from approved artifacts.",
    [AGENT_IDS.core.verifier]: "Builds traceability from registered command evidence.",
    [AGENT_IDS.core.repairer]: "Mutates code during bounded remediation cycles.",
    [AGENT_IDS.review.risk]: "Detects cross-cutting risk facets without replacing specialists.",
    [AGENT_IDS.review.correctnessJudge]: "Independently judges implementation correctness.",
    [AGENT_IDS.review.complianceJudge]: "Independently judges specification compliance.",
    [AGENT_IDS.review.refuter]: "Deduplicates and challenges unsupported review findings.",
    [AGENT_IDS.specialist.security]:
        "Reviews authentication, authorization, secrecy, and abuse risk.",
    [AGENT_IDS.specialist.dataMigration]: "Reviews persistent data and migration safety.",
    [AGENT_IDS.specialist.contract]: "Reviews public API and compatibility contracts.",
    [AGENT_IDS.specialist.concurrency]: "Reviews ordering, races, locking, and atomicity.",
    [AGENT_IDS.specialist.resilience]: "Reviews failure handling, recovery, and degradation.",
    [AGENT_IDS.specialist.performance]: "Reviews resource and latency regressions.",
    [AGENT_IDS.specialist.infrastructure]: "Reviews deployment and operational changes.",
    [AGENT_IDS.specialist.usability]: "Reviews user-facing interaction quality.",
    [AGENT_IDS.specialist.maintainability]:
        "Reviews clarity, structure, and long-term change cost.",
}

/**
 * The only source of agent identity and authority. Manifests may tune provider
 * options, but cannot grant permissions or introduce an unregistered agent.
 *
 * Every entry in {@link ALL_AGENT_IDS} must have a corresponding policy here;
 * a module-load guard asserts the counts match.
 */
export const AGENT_REGISTRY: Record<AgentId, AgentPolicy> = {
    [AGENT_IDS.controller.automatic]: primary(AGENT_IDS.controller.automatic, false),
    [AGENT_IDS.controller.interactive]: primary(AGENT_IDS.controller.interactive, true),
    [AGENT_IDS.core.assessor]: readOnly(
        AGENT_IDS.core.assessor,
        "opencode/deepseek-v4-flash-free",
        32,
    ),
    [AGENT_IDS.core.explorer]: readOnly(
        AGENT_IDS.core.explorer,
        "opencode/ling-3.0-flash-free",
        32,
    ),
    [AGENT_IDS.core.planner]: readOnly(
        AGENT_IDS.core.planner,
        "opencode/nemotron-3-ultra-free",
        48,
    ),
    [AGENT_IDS.core.designer]: readOnly(
        AGENT_IDS.core.designer,
        "opencode/nemotron-3-ultra-free",
        48,
    ),
    [AGENT_IDS.core.implementer]: writer(AGENT_IDS.core.implementer, 96),
    [AGENT_IDS.core.verifier]: verifier(AGENT_IDS.core.verifier, "opencode/mimo-v2.5-free", 64),
    [AGENT_IDS.review.risk]: readOnly(AGENT_IDS.review.risk, "opencode/mimo-v2.5-free", 32),
    [AGENT_IDS.specialist.security]: readOnly(
        AGENT_IDS.specialist.security,
        "opencode/mimo-v2.5-free",
        40,
    ),
    [AGENT_IDS.specialist.dataMigration]: readOnly(
        AGENT_IDS.specialist.dataMigration,
        "opencode/nemotron-3-ultra-free",
        40,
    ),
    [AGENT_IDS.specialist.contract]: readOnly(
        AGENT_IDS.specialist.contract,
        "opencode/mimo-v2.5-free",
        40,
    ),
    [AGENT_IDS.specialist.concurrency]: readOnly(
        AGENT_IDS.specialist.concurrency,
        "opencode/mimo-v2.5-free",
        40,
    ),
    [AGENT_IDS.specialist.resilience]: readOnly(
        AGENT_IDS.specialist.resilience,
        "opencode/ling-3.0-flash-free",
        40,
    ),
    [AGENT_IDS.specialist.performance]: readOnly(
        AGENT_IDS.specialist.performance,
        "opencode/laguna-s-2.1-free",
        40,
    ),
    [AGENT_IDS.specialist.infrastructure]: readOnly(
        AGENT_IDS.specialist.infrastructure,
        "opencode/nemotron-3-ultra-free",
        40,
    ),
    [AGENT_IDS.specialist.usability]: readOnly(
        AGENT_IDS.specialist.usability,
        "opencode/laguna-s-2.1-free",
        40,
    ),
    [AGENT_IDS.specialist.maintainability]: readOnly(
        AGENT_IDS.specialist.maintainability,
        "opencode/laguna-s-2.1-free",
        40,
    ),
    [AGENT_IDS.review.correctnessJudge]: readOnly(
        AGENT_IDS.review.correctnessJudge,
        "opencode/nemotron-3-ultra-free",
        40,
    ),
    [AGENT_IDS.review.complianceJudge]: readOnly(
        AGENT_IDS.review.complianceJudge,
        "opencode/mimo-v2.5-free",
        40,
    ),
    [AGENT_IDS.review.refuter]: readOnly(
        AGENT_IDS.review.refuter,
        "opencode/nemotron-3-ultra-free",
        32,
    ),
    [AGENT_IDS.core.repairer]: writer(AGENT_IDS.core.repairer, 64),
}

/** Map every {@link RiskFacet} to its assigned specialist agent. */
const SPECIALIST_BY_FACET: Record<RiskFacet, AgentId> = {
    security: AGENT_IDS.specialist.security,
    data: AGENT_IDS.specialist.dataMigration,
    migration: AGENT_IDS.specialist.dataMigration,
    "public-contract": AGENT_IDS.specialist.contract,
    concurrency: AGENT_IDS.specialist.concurrency,
    resilience: AGENT_IDS.specialist.resilience,
    performance: AGENT_IDS.specialist.performance,
    infrastructure: AGENT_IDS.specialist.infrastructure,
    usability: AGENT_IDS.specialist.usability,
    maintainability: AGENT_IDS.specialist.maintainability,
}

/**
 * Capabilities that may be selected by the deterministic scheduler.
 *
 * The scheduler uses this list to enumerate which capabilities it can
 * dispatch; every entry maps to exactly one agent via
 * {@link agentForCapability}.
 */
export const SCHEDULER_CAPABILITIES: readonly CapabilityId[] = [
    "assessment",
    "exploration",
    "planning",
    "design",
    "implementation",
    "verification",
    "repair",
    "general-risk",
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
    "correctness-judgment",
    "compliance-judgment",
    "refutation",
]

/**
 * Resolve a scheduler capability to its sole authorized agent identity.
 *
 * Judgment-purpose dispatches are routed to the correctness or compliance
 * judge depending on the capability. All other purposes use the core or
 * specialist agent via the switch or the facet-to-specialist map.
 *
 * @param capability - The capability to resolve.
 * @param purpose - The dispatch purpose; defaults to `"workflow"`. When
 * `"judgment"`, the correctness or compliance judge is returned.
 * @returns The single {@link AgentId} authorized for the given capability
 * and purpose.
 */
export function agentForCapability(
    capability: CapabilityId,
    purpose: DispatchPurpose = "workflow",
): AgentId {
    if (purpose === "judgment") {
        return capability === "compliance-judgment"
            ? AGENT_IDS.review.complianceJudge
            : AGENT_IDS.review.correctnessJudge
    }

    switch (capability) {
        case "assessment":
            return AGENT_IDS.core.assessor
        case "exploration":
            return AGENT_IDS.core.explorer
        case "planning":
            return AGENT_IDS.core.planner
        case "design":
            return AGENT_IDS.core.designer
        case "implementation":
            return AGENT_IDS.core.implementer
        case "verification":
            return AGENT_IDS.core.verifier
        case "correctness-judgment":
            return AGENT_IDS.review.correctnessJudge
        case "compliance-judgment":
            return AGENT_IDS.review.complianceJudge
        case "repair":
            return AGENT_IDS.core.repairer
        case "general-risk":
            return AGENT_IDS.review.risk
        case "refutation":
            return AGENT_IDS.review.refuter
        default:
            return SPECIALIST_BY_FACET[capability]
    }
}

/**
 * Build a primary (non-subagent) controller policy.
 *
 * @param id - The controller agent id.
 * @param interactive - Whether the controller should have the `question` tool
 * enabled for user checkpoints.
 * @returns A fully populated primary {@link AgentPolicy} with 1 000 steps,
 * no bash or edit permissions, and the `task` tool enabled.
 */
function primary(id: AgentId, interactive: boolean): AgentPolicy {
    return {
        id,
        role: AGENT_ROLES[id],
        model: "opencode/deepseek-v4-flash-free",
        steps: 1_000,
        mode: "primary",
        tools: { question: interactive, todowrite: false, task: true },
        permission: { bash: "deny", edit: "deny" },
    }
}

/**
 * Build a read-only sub-agent policy (no bash, no edit).
 *
 * @param id - The sub-agent id.
 * @param model - The model identifier string.
 * @param steps - Max agent steps before forced termination.
 * @returns A fully populated read-only {@link AgentPolicy} with `task`
 * tool disabled.
 */
function readOnly(id: AgentId, model: string, steps: number): AgentPolicy {
    return {
        id,
        role: AGENT_ROLES[id],
        model,
        steps,
        mode: "subagent",
        tools: { task: false },
        permission: READ_ONLY,
    }
}

/**
 * Build a writer sub-agent policy (bash and edit allowed).
 *
 * @param id - The sub-agent id.
 * @param steps - Max agent steps before forced termination.
 * @returns A fully populated writer {@link AgentPolicy} with the default
 * code-writing model and `task` tool disabled.
 */
function writer(id: AgentId, steps: number): AgentPolicy {
    return {
        id,
        role: AGENT_ROLES[id],
        model: "opencode/north-mini-code-free",
        steps,
        mode: "subagent",
        tools: { task: false },
        permission: WRITER,
    }
}

/**
 * Build a verifier sub-agent policy (bash allowed, edit denied).
 *
 * @param id - The sub-agent id.
 * @param model - The model identifier string.
 * @param steps - Max agent steps before forced termination.
 * @returns A fully populated verifier {@link AgentPolicy} with `task` tool
 * disabled.
 */
function verifier(id: AgentId, model: string, steps: number): AgentPolicy {
    return {
        id,
        role: AGENT_ROLES[id],
        model,
        steps,
        mode: "subagent",
        tools: { task: false },
        permission: VERIFIER,
    }
}

// Fail immediately during module loading if a registry edit drifts from IDs.
if (Object.keys(AGENT_REGISTRY).length !== ALL_AGENT_IDS.length) {
    throw new Error("SpecOps agent registry does not cover the canonical agent IDs")
}

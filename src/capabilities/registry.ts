import type { CapabilityId, DispatchPurpose, FrontierTier, RiskFacet } from "../types.js"
import { AGENT_IDS, ALL_AGENT_IDS, type AgentId } from "./ids.js"

export type { AgentId } from "./ids.js"

/** Access control flags for a single agent. */
type AgentPermission = {
    bash: "allow" | "deny"
    edit: "allow" | "deny"
    read?: "allow" | "deny"
    glob?: "allow" | "deny"
    grep?: "allow" | "deny"
    todowrite?: "allow" | "deny"
    /** Subagent dispatch via the `task` tool. */
    task?: "allow" | "deny"
    /** Native user `question` tool for interactive checkpoints. */
    question?: "allow" | "deny"
}

/**
 * Canonical capabilities, model defaults, and non-overridable permissions.
 *
 * Every agent in the system has exactly one policy that fixes its id, role,
 * model, step budget, execution mode (primary or subagent), and permissions
 * (including the `task` subagent-dispatch and `question` checkpoint tools).
 * Manifests may select a model and variant but cannot change the
 * workflow-policy fields defined here.
 */
export type AgentPolicy = {
    id: AgentId
    role: string
    model: string
    steps: number
    mode: "primary" | "subagent"
    permission: AgentPermission
}

/** Permission preset: no bash or edit access, no dispatch or checkpoints. */
const READ_ONLY: AgentPermission = { bash: "deny", edit: "deny", task: "deny", question: "deny" }

/** Permission preset: full bash and edit access, no dispatch or checkpoints. */
const WRITER: AgentPermission = { bash: "allow", edit: "allow", task: "deny", question: "deny" }

/** Permission preset: bash access but no edit access, no dispatch or checkpoints. */
const VERIFIER: AgentPermission = { bash: "allow", edit: "deny", task: "deny", question: "deny" }

/** Permission preset: controllers may only dispatch and present checkpoints. */
const CONTROLLER_PERMISSION: AgentPermission = {
    bash: "deny",
    edit: "deny",
    read: "deny",
    glob: "deny",
    grep: "deny",
    todowrite: "deny",
}

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
    [AGENT_IDS.review.risk]:
        "Detects cross-cutting risk facets without replacing specialists; may run verification commands.",
    [AGENT_IDS.review.correctnessJudge]:
        "Independently judges implementation correctness; may run verification commands against the repository.",
    [AGENT_IDS.review.complianceJudge]:
        "Independently judges specification compliance; may run verification commands against the repository.",
    [AGENT_IDS.review.refuter]: "Deduplicates and challenges unsupported review findings.",
    [AGENT_IDS.review.frontierLow]:
        "Provides bounded low-tier frontier advice for evidence-backed workflow blockers.",
    [AGENT_IDS.review.frontierHigh]:
        "Provides bounded high-tier frontier adjudication for critical workflow blockers.",
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
    [AGENT_IDS.core.assessor]: readOnly(AGENT_IDS.core.assessor, "", 32),
    [AGENT_IDS.core.explorer]: readOnly(AGENT_IDS.core.explorer, "", 32),
    [AGENT_IDS.core.planner]: readOnly(AGENT_IDS.core.planner, "", 48),
    [AGENT_IDS.core.designer]: readOnly(AGENT_IDS.core.designer, "", 48),
    [AGENT_IDS.core.implementer]: writer(AGENT_IDS.core.implementer, "", 96),
    [AGENT_IDS.core.verifier]: verifier(AGENT_IDS.core.verifier, "", 64),
    [AGENT_IDS.review.risk]: verifier(AGENT_IDS.review.risk, "", 32),
    [AGENT_IDS.specialist.security]: readOnly(AGENT_IDS.specialist.security, "", 40),
    [AGENT_IDS.specialist.dataMigration]: readOnly(AGENT_IDS.specialist.dataMigration, "", 40),
    [AGENT_IDS.specialist.contract]: readOnly(AGENT_IDS.specialist.contract, "", 40),
    [AGENT_IDS.specialist.concurrency]: readOnly(AGENT_IDS.specialist.concurrency, "", 40),
    [AGENT_IDS.specialist.resilience]: readOnly(AGENT_IDS.specialist.resilience, "", 40),
    [AGENT_IDS.specialist.performance]: readOnly(AGENT_IDS.specialist.performance, "", 40),
    [AGENT_IDS.specialist.infrastructure]: readOnly(AGENT_IDS.specialist.infrastructure, "", 40),
    [AGENT_IDS.specialist.usability]: readOnly(AGENT_IDS.specialist.usability, "", 40),
    [AGENT_IDS.specialist.maintainability]: readOnly(AGENT_IDS.specialist.maintainability, "", 40),
    [AGENT_IDS.review.correctnessJudge]: verifier(AGENT_IDS.review.correctnessJudge, "", 40),
    [AGENT_IDS.review.complianceJudge]: verifier(AGENT_IDS.review.complianceJudge, "", 40),
    [AGENT_IDS.review.refuter]: readOnly(AGENT_IDS.review.refuter, "", 32),
    [AGENT_IDS.review.frontierLow]: readOnly(AGENT_IDS.review.frontierLow, "", 8),
    [AGENT_IDS.review.frontierHigh]: readOnly(AGENT_IDS.review.frontierHigh, "", 12),
    [AGENT_IDS.core.repairer]: writer(AGENT_IDS.core.repairer, "", 64),
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
    "frontier",
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
    frontierTier: FrontierTier = "low",
): AgentId {
    if (capability === "frontier") {
        return frontierTier === "high"
            ? AGENT_IDS.review.frontierHigh
            : AGENT_IDS.review.frontierLow
    }
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
 * @param interactive - Whether the controller is the interactive variant that
 * presents user checkpoints via the native `question` tool.
 * @returns A fully populated primary {@link AgentPolicy} with 1 000 steps,
 * a blank default model (so OpenCode uses its global default), no direct
 * exploration or edit permissions, subagent dispatch (`task`) allowed, and the
 * `question` tool allowed only for the interactive variant.
 */
function primary(id: AgentId, interactive: boolean): AgentPolicy {
    return {
        id,
        role: AGENT_ROLES[id],
        model: "",
        steps: 1_000,
        mode: "primary",
        permission: {
            ...CONTROLLER_PERMISSION,
            task: "allow",
            question: interactive ? "allow" : "deny",
        },
    }
}

/**
 * Build a read-only sub-agent policy (no bash, no edit).
 *
 * @param id - The sub-agent id.
 * @param model - The model identifier string.
 * @param steps - Max agent steps before forced termination.
 * @returns A fully populated read-only {@link AgentPolicy} with subagent
 * dispatch and the question tool denied via permission.
 */
function readOnly(id: AgentId, model: string, steps: number): AgentPolicy {
    return {
        id,
        role: AGENT_ROLES[id],
        model,
        steps,
        mode: "subagent",
        permission: READ_ONLY,
    }
}

/**
 * Build a writer sub-agent policy (bash and edit allowed).
 *
 * @param id - The sub-agent id.
 * @param steps - Max agent steps before forced termination.
 * @returns A fully populated writer {@link AgentPolicy} with the default
 * code-writing model and subagent dispatch and the question tool denied.
 */
function writer(id: AgentId, model: string, steps: number): AgentPolicy {
    return {
        id,
        role: AGENT_ROLES[id],
        model,
        steps,
        mode: "subagent",
        permission: WRITER,
    }
}

/**
 * Build a verifier sub-agent policy (bash allowed, edit denied).
 *
 * @param id - The sub-agent id.
 * @param model - The model identifier string.
 * @param steps - Max agent steps before forced termination.
 * @returns A fully populated verifier {@link AgentPolicy} with subagent
 * dispatch and the question tool denied via permission.
 */
function verifier(id: AgentId, model: string, steps: number): AgentPolicy {
    return {
        id,
        role: AGENT_ROLES[id],
        model,
        steps,
        mode: "subagent",
        permission: VERIFIER,
    }
}

// Reviewer and verifier agents share the same read-only shell policy.
// Fail immediately during module loading if a registry edit drifts from IDs.
if (Object.keys(AGENT_REGISTRY).length !== ALL_AGENT_IDS.length) {
    throw new Error("SpecOps agent registry does not cover the canonical agent IDs")
}

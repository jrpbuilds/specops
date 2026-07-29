/**
 * Routing policy: derive {@link WorkflowRequirements} from an
 * {@link Assessment} using deterministic safety floors.
 *
 * Requested and configured tiers may raise scope but never reduce the computed
 * floor, so the workflow can never be silently downgraded below the change's
 * risk profile.
 */
import { createHash } from "node:crypto"
import type { Assessment, CapabilityId, ScopeTier, WorkflowRequirements } from "../types.js"
import type { SpecOpsConfig } from "../config.js"

/** Numeric rank of each tier used to compare and select the higher tier. */
const TIER_RANK: Record<ScopeTier, number> = { lean: 0, standard: 1, full: 2 }

/**
 * Return the higher of two scope tiers without ever lowering the safety floor.
 *
 * @param left - One candidate tier.
 * @param right - The other candidate tier.
 * @returns The tier with the greater {@link TIER_RANK} rank.
 */
const higherTier = (left: ScopeTier, right: ScopeTier): ScopeTier =>
    TIER_RANK[left] >= TIER_RANK[right] ? left : right

/**
 * Build the final artifact requirements list for the selected tier.
 *
 * Lean omits proposal/specs/design/tasks and compliance judgment; standard
 * adds those except design; full adds design and compliance judgment.
 *
 * @param tier - The resolved scope tier.
 * @returns The ordered list of {@link ArtifactId} artifacts the run must produce.
 */
function artifactsFor(tier: ScopeTier): WorkflowRequirements["requiredArtifacts"] {
    if (tier === "lean") {
        return [
            "routing",
            "exploration",
            "implementation",
            "verification",
            "correctness-judgment",
            "review-ledger",
            "receipt",
        ]
    }
    if (tier === "standard") {
        return [
            "routing",
            "exploration",
            "proposal",
            "specs",
            "tasks",
            "implementation",
            "verification",
            "correctness-judgment",
            "compliance-judgment",
            "review-ledger",
            "receipt",
        ]
    }
    return [
        "routing",
        "exploration",
        "proposal",
        "specs",
        "design",
        "tasks",
        "implementation",
        "verification",
        "correctness-judgment",
        "compliance-judgment",
        "review-ledger",
        "receipt",
    ]
}

/**
 * Derive a full {@link WorkflowRequirements} from an assessment using
 * deterministic safety floors.
 *
 * Computes the scope floor from assessment fields (change kind, file/module
 * counts, risk facets, uncertainty), then applies requested and configured
 * tier overrides — each can only raise scope, never lower it.
 *
 * @param assessment - The canonical assessor output for the change.
 * @param requested - Tier the caller requested (`"auto"` means no preference).
 * @param config - SpecOps configuration with thresholds and force-full rules.
 * @returns The resolved requirements and the deduplicated reasoning trail.
 */
export function requirementsFor(
    assessment: Assessment,
    requested: "auto" | ScopeTier,
    config: SpecOpsConfig,
): { requirements: WorkflowRequirements; reasons: string[] } {
    const thresholds = config.workflow.scopeThresholds
    const reasons = [...assessment.facts]
    const requiresFull =
        assessment.publicContract === "breaking" ||
        assessment.changeKind === "migration" ||
        assessment.changeKind === "infrastructure" ||
        assessment.expectedFiles >= thresholds.fullMinFiles ||
        assessment.expectedModules >= thresholds.fullMinModules ||
        assessment.riskFacets.some(
            facet =>
                facet === "migration" ||
                facet === "infrastructure" ||
                config.routing.forceFullForFacets.includes(facet),
        ) ||
        assessment.uncertainty.requirements === "low" ||
        assessment.uncertainty.design === "low"
    const requiresStandard =
        assessment.changesRequirements ||
        assessment.publicContract !== "none" ||
        assessment.changeKind === "feature" ||
        assessment.changeKind === "refactor" ||
        assessment.expectedFiles > thresholds.leanMaxFiles ||
        assessment.expectedModules > thresholds.leanMaxModules ||
        assessment.riskFacets.length > 0

    const floor: ScopeTier = requiresFull ? "full" : requiresStandard ? "standard" : "lean"
    if (requiresFull) {
        reasons.push("A deterministic Full safety, scope, or uncertainty floor applies.")
    } else if (requiresStandard) {
        reasons.push("The change exceeds Lean behavioral or risk limits.")
    }

    const requestedFloor = requested === "auto" ? "lean" : requested
    const configuredFloor =
        config.workflow.defaultTier === "auto" ? "lean" : config.workflow.defaultTier
    const scopeTier = higherTier(higherTier(floor, requestedFloor), configuredFloor)
    const specialists = [...new Set<CapabilityId>(assessment.riskFacets)]
    const requiredCapabilities: CapabilityId[] = [
        "assessment",
        "exploration",
        "planning",
        "implementation",
        "verification",
        "general-risk",
        "correctness-judgment",
        ...specialists,
    ]
    if (scopeTier === "full") {
        requiredCapabilities.push("design")
    }
    if (scopeTier !== "lean") {
        requiredCapabilities.push("compliance-judgment")
    }

    const requirements: WorkflowRequirements = {
        scopeTier,
        requiredArtifacts: artifactsFor(scopeTier),
        requiredCapabilities: [...new Set(requiredCapabilities)],
        requiredReviewFacets: [...assessment.riskFacets],
        requiredValidations: [
            { id: "openspec-strict", kind: "openspec-strict" },
            { id: "traceability", kind: "traceability" },
            ...assessment.likelyValidations.map((validation, index) => ({
                id: `assessment-command-${index + 1}`,
                kind: "command" as const,
                executable: validation.executable,
                args: validation.args,
                cwd: validation.cwd,
                purpose: validation.purpose,
                requirements: [],
            })),
        ],
        judgePolicy: {
            required: scopeTier === "lean" ? ["correctness"] : ["correctness", "compliance"],
        },
        refuterPolicy: {
            mode: "conditional",
            triggers: ["findings", "disagreement", "critical-risk"],
        },
        budgets: config.escalation.budgets,
        policyHash: "",
    }
    requirements.policyHash = createHash("sha256")
        .update(JSON.stringify(requirements))
        .digest("hex")

    return { requirements, reasons: [...new Set(reasons)] }
}

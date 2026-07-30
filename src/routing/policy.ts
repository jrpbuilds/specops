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
 * Raise a scope tier when actual changed paths exceed configured size limits.
 *
 * Modules are unique top-level directories; repository-root files share the
 * synthetic module `"."`. Full thresholds take precedence over Standard.
 *
 * @param current - Current routed scope tier.
 * @param paths - Changed non-OpenSpec paths.
 * @param thresholds - Configured file and module limits.
 * @returns The current or mechanically raised scope tier.
 */
export function scopeForActualDiff(
    current: ScopeTier,
    paths: string[],
    thresholds: SpecOpsConfig["workflow"]["scopeThresholds"],
): ScopeTier {
    if (current === "full" || paths.length === 0) return current
    const modules = new Set(
        paths.map(changedPath => {
            const segments = changedPath.split("/").filter(Boolean)
            return segments.length > 1 ? segments[0] : "."
        }),
    ).size
    if (paths.length >= thresholds.fullMinFiles || modules >= thresholds.fullMinModules) {
        return "full"
    }
    if (
        current === "lean" &&
        (paths.length > thresholds.leanMaxFiles || modules > thresholds.leanMaxModules)
    ) {
        return "standard"
    }
    return current
}

/**
 * Build the final artifact requirements list for the selected tier.
 *
 * Lean keeps a compact task plan but omits proposal/specs/design and compliance
 * judgment; Standard adds proposal/specs and compliance; Full adds design.
 *
 * @param tier - The resolved scope tier.
 * @returns The ordered list of {@link ArtifactId} artifacts the run must produce.
 */
export function artifactsFor(tier: ScopeTier): WorkflowRequirements["requiredArtifacts"] {
    if (tier === "lean") {
        return [
            "routing",
            "exploration",
            "tasks",
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
 * Return the base capability set required by a scope tier.
 *
 * Lean consolidates inspection into assessment and assurance into verification.
 * Standard and Full retain independent exploration, judgment, and review.
 *
 * @param tier - Resolved scope tier.
 * @param specialists - Risk-facet capabilities required by assessment.
 * @returns Ordered, deduplicated base capabilities.
 */
export function capabilitiesFor(tier: ScopeTier, specialists: CapabilityId[] = []): CapabilityId[] {
    if (tier === "lean") {
        return ["assessment", "planning", "implementation", "verification"]
    }
    const capabilities: CapabilityId[] = [
        "assessment",
        "exploration",
        "planning",
        "implementation",
        "verification",
        "general-risk",
        "correctness-judgment",
        "compliance-judgment",
        ...specialists,
    ]
    if (tier === "full") capabilities.push("design")
    return [...new Set(capabilities)]
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

    const requirements: WorkflowRequirements = {
        scopeTier,
        requiredArtifacts: artifactsFor(scopeTier),
        requiredCapabilities: capabilitiesFor(scopeTier, specialists),
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
        // Runs own their budget snapshot; callers and tests may consume or
        // adjust it without mutating the shared project configuration object.
        budgets: { ...config.escalation.budgets },
        policyHash: "",
    }
    requirements.policyHash = createHash("sha256")
        .update(JSON.stringify(requirements))
        .digest("hex")

    return { requirements, reasons: [...new Set(reasons)] }
}

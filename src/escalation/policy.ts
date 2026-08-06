/**
 * Escalation policy: verify claims, enforce budgets, narrow patches, and
 * record controller decisions on worker-raised escalations.
 */
import { createHash } from "node:crypto";
import type { SpecOpsConfig } from "../config.js";
import { artifactsFor, capabilitiesFor } from "../routing/policy.js";
import type {
    ArtifactId,
    CapabilityId,
    EscalationClaim,
    EscalationDecision,
    EscalationPatch,
    RiskFacet,
    RunState,
    ScopeTier,
} from "../types.js";

/** Numeric rank of each tier; used to refuse scope downgrades from a patch. */
const TIER_RANK = { lean: 0, standard: 1, full: 2 } as const;
/** The complete set of valid {@link RiskFacet} values; used to identify specialist capabilities. */
const REVIEW_FACETS = new Set<RiskFacet>([
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
]);

/**
 * Apply a finite escalation patch after controller-side structural checks.
 *
 * Computes a stable fingerprint for repeated-failure deduplication, refuses
 * claims that exceed the repeated-fingerprint, scope-escalation, or
 * specialist-dispatch budgets, narrows the requested patch to only the
 * requirements not already present in the run state, and returns a decision
 * recording the verified evidence and applied patch.
 *
 * @param state - The current run state, used for budget tracking and current requirements.
 * @param claim - The worker-raised escalation claim to evaluate.
 * @returns The controller's {@link EscalationDecision} — accepted, narrowed, or rejected.
 */
export function decideEscalation(
    state: RunState,
    claim: EscalationClaim,
    routing: Pick<SpecOpsConfig, "routing"> = { routing: { forceFullForFacets: [] } },
): EscalationDecision {
    const fingerprint = createHash("sha256")
        .update(
            JSON.stringify({
                category: claim.category,
                summary: claim.summary,
                patch: claim.requestedPatch,
            }),
        )
        .digest("hex");
    const priorMatches = state.decisions.filter(
        decision => decision.fingerprint === fingerprint,
    ).length;

    if (priorMatches >= state.requirements.budgets.maxRepeatedFailureFingerprints) {
        return rejected(
            claim.requestedPatch,
            fingerprint,
            "Repeated escalation fingerprint exceeded its budget.",
        );
    }

    const normalizedRequest = normalizeRiskTier(claim.requestedPatch, routing.routing);
    const patch = narrowPatch(state, normalizedRequest);
    if (!hasPatch(patch)) {
        return rejected(
            claim.requestedPatch,
            fingerprint,
            "The claim did not add a new bounded requirement.",
        );
    }

    if (
        patch.raiseScopeTier &&
        (state.budgetUsage.maxScopeEscalations ?? 0) >=
            state.requirements.budgets.maxScopeEscalations
    ) {
        return rejected(claim.requestedPatch, fingerprint, "Scope-escalation budget is exhausted.");
    }

    const specialistCount = (patch.addCapabilities ?? []).filter(capability =>
        REVIEW_FACETS.has(capability as RiskFacet),
    ).length;
    if (
        specialistCount > 0 &&
        (state.budgetUsage.maxSpecialistDispatches ?? 0) + specialistCount >
            state.requirements.budgets.maxSpecialistDispatches
    ) {
        return rejected(
            claim.requestedPatch,
            fingerprint,
            "Specialist-dispatch budget is exhausted.",
        );
    }

    return {
        disposition: samePatch(patch, claim.requestedPatch) ? "accepted" : "narrowed",
        requestedPatch: claim.requestedPatch,
        appliedPatch: patch,
        verifiedEvidence: claim.evidence.map(evidence => ({
            evidence,
            status: "interpretive",
            detail: "The controller retained the worker-provided evidence for the decision trail.",
        })),
        rejectedEvidence: [],
        fingerprint,
        reason: "The bounded patch adds requirements not already represented in the run state.",
    };
}

/**
 * Mutate only controller-owned requirements after an accepted decision.
 *
 * Applies an {@link EscalationPatch} to the live {@link RunState}: raises the
 * scope tier and adds the corresponding artifacts/capabilities when escalating
 * to `full`, appends capabilities, review facets, and validations, and
 * increments the relevant budget counters. Finally recomputes the
 * `policyHash` so downstream artifacts can detect the requirements change.
 *
 * @param state - The run state to mutate in place.
 * @param patch - The bounded patch to apply.
 */
export function applyEscalation(state: RunState, patch: EscalationPatch): void {
    if (patch.raiseScopeTier) {
        state.scopeTier = patch.raiseScopeTier;
        state.requirements.scopeTier = patch.raiseScopeTier;
        state.requirements.requiredArtifacts = unique<ArtifactId>([
            ...artifactsFor(patch.raiseScopeTier),
            ...state.requirements.requiredArtifacts,
        ]);
        state.requirements.requiredCapabilities = unique<CapabilityId>([
            ...capabilitiesFor(
                patch.raiseScopeTier,
                state.requirements.requiredReviewFacets as CapabilityId[],
            ),
            ...state.requirements.requiredCapabilities,
        ]);
        state.requirements.judgePolicy.required =
            patch.raiseScopeTier === "lean" ? ["correctness"] : ["correctness", "compliance"];
        state.budgetUsage.maxScopeEscalations = (state.budgetUsage.maxScopeEscalations ?? 0) + 1;
    }

    if (patch.addCapabilities) {
        state.requirements.requiredCapabilities = unique([
            ...state.requirements.requiredCapabilities,
            ...patch.addCapabilities,
        ]);
        const count = patch.addCapabilities.filter(capability =>
            REVIEW_FACETS.has(capability as RiskFacet),
        ).length;
        if (count) {
            state.budgetUsage.maxSpecialistDispatches =
                (state.budgetUsage.maxSpecialistDispatches ?? 0) + count;
        }
    }

    if (patch.addReviewFacets) {
        state.riskFacets = unique([...state.riskFacets, ...patch.addReviewFacets]) as RiskFacet[];
        state.requirements.requiredReviewFacets = unique([
            ...state.requirements.requiredReviewFacets,
            ...patch.addReviewFacets,
        ]) as RiskFacet[];
    }

    if (patch.addValidations) {
        state.requirements.requiredValidations = [
            ...state.requirements.requiredValidations,
            ...patch.addValidations,
        ];
    }

    state.requirements.policyHash = createHash("sha256")
        .update(JSON.stringify(state.requirements))
        .digest("hex");
}

/**
 * Infer the minimum safe scope tier implied by newly discovered risk facets.
 *
 * @param patch - Worker-requested additive patch.
 * @param routing - Project routing safety floors.
 * @returns A patch whose scope raise includes the inferred facet floor.
 */
function normalizeRiskTier(
    patch: EscalationPatch,
    routing: SpecOpsConfig["routing"],
): EscalationPatch {
    const facets = unique<RiskFacet>([
        ...(patch.addReviewFacets ?? []),
        ...((patch.addCapabilities ?? []).filter(capability =>
            REVIEW_FACETS.has(capability as RiskFacet),
        ) as RiskFacet[]),
    ]);
    const inferred: ScopeTier | undefined = facets.some(
        facet =>
            facet === "migration" ||
            facet === "infrastructure" ||
            routing.forceFullForFacets.includes(facet),
    )
        ? "full"
        : facets.length
          ? "standard"
          : undefined;
    const requested = patch.raiseScopeTier;
    const raiseScopeTier =
        requested && inferred
            ? TIER_RANK[requested] >= TIER_RANK[inferred]
                ? requested
                : inferred
            : (requested ?? inferred);
    return {
        ...patch,
        raiseScopeTier,
        addCapabilities: facets.length
            ? unique<CapabilityId>([...(patch.addCapabilities ?? []), ...facets])
            : patch.addCapabilities,
        addReviewFacets: facets.length ? facets : patch.addReviewFacets,
    };
}

/**
 * Narrow a requested patch to only the additive requirements not already
 * represented in the run state.
 *
 * Drops a scope-tier raise if it would not actually raise the current tier,
 * filters capabilities and review facets already required, and keeps
 * validations and invalidations as-is. Always-mutating additive patch fields
 * are omitted from the result when nothing new would be added.
 *
 * @param state - The current run state, used to detect already-satisfied requirements.
 * @param requested - The patch requested by the claimant.
 * @returns A new patch containing only the net-new requirements, possibly empty.
 */
function narrowPatch(state: RunState, requested: EscalationPatch): EscalationPatch {
    const patch: EscalationPatch = {};
    if (
        requested.raiseScopeTier &&
        TIER_RANK[requested.raiseScopeTier] > TIER_RANK[state.scopeTier]
    ) {
        patch.raiseScopeTier = requested.raiseScopeTier;
    }

    const capabilities = (requested.addCapabilities ?? []).filter(
        capability => !state.requirements.requiredCapabilities.includes(capability),
    );
    if (capabilities.length) {
        patch.addCapabilities = unique(capabilities) as CapabilityId[];
    }

    const facets = (requested.addReviewFacets ?? []).filter(
        facet =>
            REVIEW_FACETS.has(facet) && !state.requirements.requiredReviewFacets.includes(facet),
    );
    if (facets.length) {
        patch.addReviewFacets = unique(facets) as RiskFacet[];
    }

    if (requested.addValidations?.length) {
        patch.addValidations = requested.addValidations;
    }

    if (requested.invalidate?.length) {
        patch.invalidate = unique(requested.invalidate);
    }

    return patch;
}

/**
 * Build a `rejected` {@link EscalationDecision} with no applied patch and no
 * verified evidence.
 *
 * @param requestedPatch - The patch the claimant requested.
 * @param fingerprint - The stable fingerprint of the claim.
 * @param reason - Human-readable rejection rationale.
 * @returns A fully-populated rejected decision record.
 */
function rejected(
    requestedPatch: EscalationPatch,
    fingerprint: string,
    reason: string,
): EscalationDecision {
    return {
        disposition: "rejected",
        requestedPatch,
        appliedPatch: {},
        verifiedEvidence: [],
        rejectedEvidence: [],
        fingerprint,
        reason,
    };
}

/**
 * Whether a narrowed patch carries any net-new requirement.
 *
 * @param patch - The narrowed patch to test.
 * @returns `true` if any patch field is set with at least one value.
 */
function hasPatch(patch: EscalationPatch): boolean {
    return Boolean(
        patch.raiseScopeTier ||
        patch.addCapabilities?.length ||
        patch.addReviewFacets?.length ||
        patch.addValidations?.length ||
        patch.invalidate?.length,
    );
}

/**
 * Structural equality check for two patches via JSON serialisation.
 *
 * Used to decide whether the narrowed patch differs from what was requested,
 * which determines the `"accepted"` vs `"narrowed"` disposition.
 *
 * @param left - One patch.
 * @param right - The other patch.
 * @returns `true` when the serialised forms are identical.
 */
function samePatch(left: EscalationPatch, right: EscalationPatch): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Deduplicate an array in place using `Set`.
 *
 * @typeParam T - Any value type (uses `Set` reference equality).
 * @param values - The array to deduplicate.
 * @returns A new array with duplicates removed, preserving insertion order.
 */
function unique<T>(values: T[]): T[] {
    return [...new Set(values)];
}

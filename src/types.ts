/**
 * Final, framework-independent SpecOps domain model.
 *
 * These types describe the persisted workflow state, requirements,
 * assessments, escalations, and dispatch/evidence records consumed by both
 * the controller agents and downstream CI consumers. They are deliberately
 * framework-agnostic so the same shapes flow across the JSON event stream and
 * the persisted run state.
 */

/** Workflow effort tier selected by routing from a {@link ScopeTier} suggestion. */
export type ScopeTier = "lean" | "standard" | "full"

/** Three-level confidence used by assessments, escalations, and judgments. */
export type ConfidenceLevel = "low" | "medium" | "high"

/**
 * Taxonomy of risk facets used by routing, review scheduling, and judgments.
 *
 * Each facet maps to a dedicated specialist capability when present in an
 * assessment's `riskFacets` or a run's `requiredReviewFacets`.
 */
export type RiskFacet =
    | "security"
    | "data"
    | "public-contract"
    | "concurrency"
    | "resilience"
    | "performance"
    | "infrastructure"
    | "migration"
    | "usability"
    | "maintainability"

/**
 * Surfaces a change may touch; drives routing, validations, and reviewer
 * specialisation.
 */
export type TouchedSurface =
    | "api"
    | "auth"
    | "database"
    | "filesystem"
    | "network"
    | "queue"
    | "cli"
    | "ui"
    | "configuration"
    | "build"
    | "deployment"

/**
 * Per-concern uncertainty profile recorded by the assessor and reused by
 * routing and refuter policies.
 */
type UncertaintyProfile = Record<
    "requirements" | "repository" | "design" | "implementation" | "verification",
    ConfidenceLevel
>

/**
 * A persisted, controller-owned artifact.
 *
 * Artifact ids are stable across versions so invalidation and provenance can
 * reference them by name.
 */
export type ArtifactId =
    | "routing"
    | "exploration"
    | "proposal"
    | "specs"
    | "design"
    | "tasks"
    | "implementation"
    | "verification"
    | "correctness-judgment"
    | "compliance-judgment"
    | "review-ledger"
    | "receipt"

/**
 * Catalogue of capabilities the workflow may require and dispatch.
 *
 * Includes assessor/planner capabilities, the repair capability, every
 * {@link RiskFacet} specialist, and the judgment/refutation capabilities.
 */
export type CapabilityId =
    | "assessment"
    | "exploration"
    | "planning"
    | "design"
    | "implementation"
    | "verification"
    | "repair"
    | "general-risk"
    | RiskFacet
    | "correctness-judgment"
    | "compliance-judgment"
    | "refutation"

/**
 * Explains why an agent was dispatched. This provenance prevents a planning
 * consultation from being counted as an independent post-change review.
 */
export type DispatchPurpose =
    "consultation" | "independent-review" | "judgment" | "repair" | "workflow"

/**
 * A registered validation requirement. Discriminated by `kind`:
 * - `openspec-strict` — enforced by the OpenSpec schema validator.
 * - `command` — an arbitrary shell-free command with declared purpose and
 *   success criteria.
 * - `traceability` — a spec→implementation traceability check.
 */
type ValidationRequirement =
    | { id: string; kind: "openspec-strict" }
    | {
          id: string
          kind: "command"
          executable: string
          args: string[]
          cwd?: string
          purpose: string
          requirements: string[]
      }
    | { id: string; kind: "traceability" }

/** Policy describing which judgment capabilities a run must execute. */
type JudgePolicy = { required: Array<"correctness" | "compliance"> }

/**
 * Policy describing when the refuter capability runs.
 * - `conditional` runs only when `triggers` fire.
 * - `required` always runs.
 */
type RefuterPolicy = {
    mode: "conditional" | "required"
    triggers: Array<"findings" | "disagreement" | "critical-risk">
}

/**
 * Per-run escalation budget limits. Exceeding any field escalates the run to a
 * terminal blocked state rather than looping indefinitely.
 */
export type EscalationBudget = {
    maxScopeEscalations: number
    maxSpecialistDispatches: number
    maxRepairCycles: number
    maxRepeatedFailureFingerprints: number
}

/**
 * Full requirements envelope for a run, derived from the assessment by
 * routing and modified by accepted escalations.
 *
 * `policyHash` lets the workflow detect that requirements changed out from
 * under a run (e.g. external edits) and invalidate derived artifacts.
 */
export type WorkflowRequirements = {
    scopeTier: ScopeTier
    requiredArtifacts: ArtifactId[]
    requiredCapabilities: CapabilityId[]
    requiredReviewFacets: RiskFacet[]
    requiredValidations: ValidationRequirement[]
    judgePolicy: JudgePolicy
    refuterPolicy: RefuterPolicy
    budgets: EscalationBudget
    policyHash: string
}

/**
 * Assessor output for a change: the canonical, repository-grounded input to
 * routing.
 *
 * `facts` are verifiable observations; `inferences` are assessor conclusions
 * with stated reasoning. Routing consumes both but only facts survive into
 * evidence verification.
 */
export type Assessment = {
    changeKind:
        | "documentation"
        | "configuration"
        | "test"
        | "bugfix"
        | "refactor"
        | "feature"
        | "migration"
        | "infrastructure"
    expectedFiles: number
    expectedModules: number
    restoresExistingBehavior: boolean
    changesRequirements: boolean
    publicContract: "none" | "compatible" | "breaking"
    riskFacets: RiskFacet[]
    touchedSurfaces: TouchedSurface[]
    uncertainty: UncertaintyProfile
    suggestedTier: ScopeTier
    inspectedPaths: string[]
    unresolvedQuestions: string[]
    likelyValidations: Array<{ executable: string; args: string[]; cwd?: string; purpose: string }>
    facts: string[]
    inferences: string[]
}

/**
 * Reference to a piece of evidence backing an escalation claim or judgment.
 *
 * Discriminated by `kind`; each variant pins the evidence to a verifiable
 * repository location, command, dependency, contract, or an explicitly
 * unresolved unknown.
 */
type EvidenceRef =
    | { kind: "changed-path"; path: string }
    | { kind: "repository-path"; path: string }
    | { kind: "symbol"; path: string; symbol: string }
    | { kind: "command"; commandId: string; exitCode: number }
    | { kind: "test-failure"; commandId: string; test: string }
    | { kind: "dependency"; package: string; change: "added" | "updated" | "removed" }
    | { kind: "contract"; path: string; surface: string }
    | { kind: "unresolved-unknown"; question: string; inspectionsPerformed: string[] }

/**
 * Evidence that survived mechanical verification by the controller.
 *
 * `status` records the verification tier: `mechanical` (parsed from a
 * command), `repository-grounded` (resolved to a repo path), or
 * `interpretive` (accepted on assessor reasoning alone).
 */
type VerifiedEvidenceRef = {
    evidence: EvidenceRef
    status: "mechanical" | "repository-grounded" | "interpretive"
    detail: string
}

/** Evidence rejected by the controller along with the rejection reason. */
type RejectedEvidenceRef = { evidence: EvidenceRef; reason: string }

/**
 * Patch requested by an escalation or applied by the controller to widen a
 * run's requirements. All fields are optional and additive.
 */
export type EscalationPatch = {
    raiseScopeTier?: ScopeTier
    addCapabilities?: CapabilityId[]
    addReviewFacets?: RiskFacet[]
    addValidations?: ValidationRequirement[]
    invalidate?: ArtifactId[]
}

/**
 * Escalation claim raised by a worker that believes the current requirements
 * are insufficient for the change it is performing.
 *
 * `category` drives controller verification and `requestedPatch` is what the
 * claimant believes must change; the controller may accept, narrow, or
 * reject it (see {@link EscalationDecision}).
 */
export type EscalationClaim = {
    category:
        | "scope-overflow"
        | "requirements-changed"
        | "architecture-discovery"
        | "risk-discovery"
        | "validation-gap"
        | "verification-uncertainty"
        | "blocked"
    confidence: ConfidenceLevel
    summary: string
    evidence: EvidenceRef[]
    boundaryCrossed: string
    whyCurrentRequirementsAreInsufficient: string
    requestedPatch: EscalationPatch
}

/**
 * Controller decision on an {@link EscalationClaim}, including the verified
 * and rejected evidence, a stable `fingerprint` for repeated-failure
 * deduplication, and the patch actually applied.
 */
export type EscalationDecision = {
    disposition: "accepted" | "rejected" | "narrowed"
    requestedPatch: EscalationPatch
    appliedPatch: EscalationPatch
    verifiedEvidence: VerifiedEvidenceRef[]
    rejectedEvidence: RejectedEvidenceRef[]
    fingerprint: string
    reason: string
}

/**
 * Provenance record for a single artifact produced within a run.
 *
 * Tracks the producing agent, dispatch purpose, input/output hashes, scope
 * tier, capabilities used, and current validity so invalidation can mark
 * downstream artifacts stale.
 */
type ArtifactProvenance = {
    artifact: ArtifactId
    producer: string
    purpose: DispatchPurpose
    generatedAt: string
    inputHashes: Record<string, string>
    outputHash: string
    scopeTier: ScopeTier
    capabilities: CapabilityId[]
    validity: "valid" | "stale" | "missing"
    invalidationReason?: string
}

/** Reason a repair cycle was entered; drives the repair agent's instructions. */
export type RepairMode =
    | "implementation-defect"
    | "spec-mismatch"
    | "test-deficiency"
    | "review-finding"
    | "design-revision"

export type PauseReason = "pending-question" | "question-dismissed"

/** Detailed reason for a non-resumable blocked outcome. */
export type BlockReason = "budget-exhausted" | "policy-rejected" | "validation-failed"

/**
 * Stable workflow-level result consumed from JSON events or persisted state
 * by CI.
 *
 * `category` is the machine-readable outcome; `message` and `at` provide the
 * human-readable summary and timestamp.
 */
export type WorkflowOutcome = {
    category:
        | "completed"
        | "policy-blocked"
        | "validation-failed"
        | "review-failed"
        | "internal-error"
        | "cancelled"
    message: string
    at: string
}

/** Record of a single agent dispatch within a run. */
export type DispatchRecord = {
    id: string
    action: string
    agent: string
    capability: CapabilityId
    purpose: DispatchPurpose
    independent: boolean
    inputHash: string
    outputHash?: string
    status: "issued" | "completed" | "failed"
    at: string
    /** Resume metadata when this dispatch re-issues a paused phase after an answer. */
    resume?: {
        questionId: string
        originalDispatchId: string
        answerHash: string
        phase: ArtifactId
        capability: CapabilityId
    }
}

/** Persisted evidence for a single executed validation command. */
export type CommandEvidence = {
    id: string
    executable: string
    args: string[]
    cwd: string
    startedAt: string
    finishedAt: string
    exitCode: number
    stdoutHash: string
    stderrHash: string
    stdoutExcerpt: string
    stderrExcerpt: string
    validationId: string
    dispatchId: string
}

/** Constrained impact category a worker question may request. */
export type QuestionImpact = "requirements" | "design" | "implementation" | "validation"

/** A single validated choice presented to the user. */
export type WorkerQuestionOption = {
    id: string
    label: string
}

/**
 * Parsed, validated worker-raised question payload.
 *
 * This is only the raw suggestion from the worker. The controller resolves the
 * final `impact`, generates the `id`, and stores authoritative hashes.
 */
export type WorkerQuestion = {
    prompt: string
    options: WorkerQuestionOption[]
    allowOther?: boolean
    impact?: QuestionImpact
}

/**
 * A live, unanswered question persisted in run state.
 *
 * Contains every field required to resume the same question without replaying
 * the worker that raised it. No `status` field is stored here; the question is
 * implicitly pending while it appears on `RunState.pendingQuestion`.
 */
export type PendingQuestion = {
    id: string
    dispatchId: string
    phase: ArtifactId
    capability: CapabilityId
    prompt: string
    options: WorkerQuestionOption[]
    allowOther: boolean
    impact: QuestionImpact
    policyHash: string
    bindingHash: string
    fingerprint: string
    raisedAt: string
    /** Number of times this question has been dismissed (not cleared). */
    dismissalCount: number
    /** When the question was last dismissed, if ever. */
    lastDismissedAt?: string
}

/**
 * Immutable record of a question once it has been answered or cancelled.
 *
 * Retains the complete original prompt, options, phase, capability, dispatch
 * provenance, selected answer/Other text, outcome, all relevant hashes, and
 * the artifacts the answer invalidated.
 */
export type QuestionRecord = {
    id: string
    dispatchId: string
    phase: ArtifactId
    capability: CapabilityId
    prompt: string
    options: WorkerQuestionOption[]
    allowOther: boolean
    impact: QuestionImpact
    policyHash: string
    bindingHash: string
    fingerprint: string
    raisedAt: string
    resolvedAt: string
    outcome: "answered" | "cancelled" | "dismissed"
    selectedOptionId?: string
    selectedOptionLabel?: string
    otherText?: string
    answerHash: string
    invalidatedArtifacts: ArtifactId[]
}

/** Budget limits controlling worker-raised question loops. */
export type QuestionBudgets = {
    maxQuestionsPerRun: number
    maxQuestionsPerDispatch: number
    maxRepeatedQuestionFingerprints: number
}

/**
 * Explicit counters for question budget accounting.
 *
 * Stored names are usage-counter names rather than limit names to keep
 * accounting unambiguous.
 */
export type QuestionBudgetUsage = {
    questionsRaised: number
    questionsByDispatch: Record<string, number>
    fingerprintCounts: Record<string, number>
}

/** Stable target describing the phase that must be redispatched after an answer. */
export type ResumeTarget = {
    questionId: string
    originalDispatchId: string
    phase: ArtifactId
    capability: CapabilityId
    answerHash: string
    consumed?: boolean
}

/**
 * Final-format deterministic run state, persisted per change directory and
 * consumed by the controller agents and CI.
 *
 * `version` is the schema version; `status` is the workflow state;
 * `outcome` is present only for terminal states; `pauseReason` and
 * `resumable` describe the paused state.
 */
export type RunState = {
    version: 2
    mode: "automatic" | "interactive"
    goal: string
    baseline: string
    requestedTier: "auto" | ScopeTier
    scopeTier: ScopeTier
    assessment: Assessment
    requirements: WorkflowRequirements
    riskFacets: RiskFacet[]
    uncertainty: UncertaintyProfile
    routingReasons: string[]
    decisions: EscalationDecision[]
    budgetUsage: Partial<Record<keyof EscalationBudget, number>>
    dispatches: DispatchRecord[]
    artifacts: Partial<Record<ArtifactId, ArtifactProvenance>>
    invalidations: Array<{ artifacts: ArtifactId[]; reason: string; at: string }>
    repairs: Array<{ mode: RepairMode; at: string; summary: string }>
    /** A repair selected by the controller from a validated review ledger. */
    pendingRepair?: { mode: RepairMode; summary: string }
    /** A live, unanswered worker-raised question. */
    pendingQuestion?: PendingQuestion
    /** Immutable history of answered, cancelled, or dismissed questions. */
    questionHistory: QuestionRecord[]
    /** Question budget accounting. */
    questionBudgetUsage?: QuestionBudgetUsage
    /** Explicit target for the fresh dispatch issued after an answer. */
    resumeTarget?: ResumeTarget
    implementationDiffHash?: string
    createdAt: string
    updatedAt: string
    status: "running" | "paused" | "passed" | "blocked" | "failed" | "cancelled"
    /** Reason a paused run is waiting; required only when `status === "paused"`. */
    pauseReason?: PauseReason
    /** True only when the run is paused and can be resumed interactively. */
    resumable?: boolean
    /** Terminal outcome; required for non-running statuses except paused. */
    outcome?: WorkflowOutcome
    blockReason?: BlockReason
}

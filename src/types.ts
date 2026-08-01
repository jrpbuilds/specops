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
    | "documentation"

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
    | "frontier"

/**
 * Explains why an agent was dispatched. This provenance prevents a planning
 * consultation from being counted as an independent post-change review.
 */
export type DispatchPurpose =
    | "consultation"
    | "independent-review"
    | "judgment"
    | "repair"
    | "workflow"
    | "frontier-escalation"

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
export type EvidenceRef =
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

/** Severity assigned to an assurance finding. */
type ReviewSeverity = "BLOCKER" | "HIGH" | "MEDIUM" | "LOW"

/**
 * Evidence-backed finding emitted by a judgment, reviewer, or Lean assurance bundle.
 *
 * Blocking findings are admitted to repair only after the controller verifies
 * their evidence. `acceptanceCriteria` describes the observable condition that
 * later assurance must establish.
 */
export type AssuranceFinding = {
    severity: ReviewSeverity
    mode?: RepairMode
    summary: string
    evidence: EvidenceRef[]
    acceptanceCriteria: string[]
}

/** Controller-normalized review output bound to one exact assurance dispatch. */
export type ReviewSubmission = {
    id: string
    dispatchId: string
    capability: CapabilityId
    inputHash: string
    implementationDiffHash?: string
    policyHash: string
    findings: Array<AssuranceFinding & { id: string }>
    at: string
}

/** Sustained finding retained in the controller-owned OpenSpec review ledger. */
export type SustainedReviewFinding = AssuranceFinding & {
    id: string
    sourceFindingIds: string[]
}

/** Refuted or duplicate source findings retained for audit. */
export type DismissedReviewFinding = {
    sourceFindingIds: string[]
    reason: string
}

/** Final refuted review ledger persisted as an OpenSpec assurance artifact. */
export type ReviewLedger = {
    findings: SustainedReviewFinding[]
    dismissed: DismissedReviewFinding[]
}

/** Repository or OpenSpec target selected deterministically for a repair task. */
type RepairTarget = "planning" | "design" | "implementation"

/** Immutable repair assignment plus its controller-observed outcome. */
export type RepairTask = {
    id: string
    target: RepairTarget
    modes: RepairMode[]
    findingIds: string[]
    /** Semantic identities used to reconcile the task against fresh reviews. */
    findingFingerprints?: string[]
    summary: string
    evidence: EvidenceRef[]
    acceptanceCriteria: string[]
    sourceLedgerHash: string
    sourceDiffHash?: string
    fingerprint: string
    attempt: number
    status: "queued" | "completed" | "verified" | "failed" | "superseded" | "cancelled"
    beforeDiffHash?: string
    afterDiffHash?: string
    at: string
}

/** Cost/quality tier selected for an adaptive frontier escalation. */
export type FrontierTier = "low" | "high"

/** Persisted, per-run frontier policy copied from project configuration. */
type FrontierPolicy = {
    mode: "disabled" | "adaptive"
    maxEscalationsPerRun: number
    maxDispatchesPerRun: number
    maxHighDispatchesPerRun: number
}

/** Evidence-backed request raised by a worker for frontier assistance. */
export type FrontierRequest = {
    tier: FrontierTier
    task: string
    whyNormalPathIsInsufficient: string
    impact: QuestionImpact
    evidence: EvidenceRef[]
    attempts: string[]
}

/** Strict response returned by a low- or high-tier frontier worker. */
export type FrontierResponse = {
    disposition:
        "ADVISE" | "UPHOLD_BLOCKER" | "DISMISS_BLOCKER" | "INSUFFICIENT_EVIDENCE" | "PROMOTE"
    summary: string
    instruction?: string
    repairMode?: RepairMode
    evidence: EvidenceRef[]
}

/** Compact audit record for one logical frontier escalation episode. */
export type FrontierEpisode = {
    id: string
    trigger: "worker-request" | "review-blocker" | "repeated-blocker"
    fingerprint: string
    phase: ArtifactId
    capability: CapabilityId
    requestedTier: FrontierTier
    selectedTier: FrontierTier
    dispatches: number
    status: "pending" | "advised" | "promoted" | "upheld" | "dismissed" | "insufficient"
    requestHash: string
    responseHash?: string
    at: string
}

/** Explicit frontier budget counters. */
type FrontierUsage = {
    escalations: number
    dispatches: number
    highDispatches: number
}

/** Controller-owned frontier work waiting for a low/high worker response. */
export type PendingFrontier = {
    episodeId: string
    request: FrontierRequest
    trigger: FrontierEpisode["trigger"]
    fingerprint: string
    phase: ArtifactId
    capability: CapabilityId
    purpose: DispatchPurpose
    action: string
    originalDispatchId: string
    selectedTier: FrontierTier
    reviewFailure?: { mode: RepairMode; summary: string }
}

/** Stable target used to replay the originating phase with frontier advice. */
type FrontierResumeTarget = {
    episodeId: string
    originalDispatchId: string
    phase: ArtifactId
    capability: CapabilityId
    purpose: DispatchPurpose
    action: string
    advice: string
    adviceHash: string
    consumed?: boolean
}

export type PauseReason = "pending-question" | "question-dismissed" | "checkpoint"

/** Explicit action selected when resolving an interactive checkpoint. */
export type CheckpointResolution = "rerun-phase" | "apply-implementation-fixes"

/** Detailed reason for a non-resumable blocked outcome. */
export type BlockReason =
    "budget-exhausted" | "policy-rejected" | "validation-failed" | "workflow-stalled"

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
    /** Bounded validation failure retained for deterministic retry accounting. */
    failureReason?: string
    /** One-based attempt number for this capability/input binding. */
    attempt?: number
    /** Controller-issued integrity guard for repository-mutating work. */
    writerGuard?: {
        baseline: string
        artifacts: Record<string, string>
        stashFingerprint?: string
    }
    status: "issued" | "completed" | "failed"
    at: string
    /** Controller completion timestamp, present after the dispatch leaves issued state. */
    finishedAt?: string
    /** Assurance binding epoch used to decide whether a result is still current. */
    assuranceEpoch?: string
    /** Recovery metadata when an issued dispatch was explicitly interrupted. */
    recovery?: { reason: string; at: string; fingerprint: string; attempt: number }
    /** Resume metadata when this dispatch re-issues a paused phase after an answer. */
    resume?: {
        sourceId: string
        originalDispatchId: string
        answerHash: string
        phase: ArtifactId
        capability: CapabilityId
        purpose: DispatchPurpose
        action: string
        origin: "question" | "checkpoint"
    }
    /** Resume metadata when frontier advice replays the originating phase. */
    frontierResume?: {
        episodeId: string
        originalDispatchId: string
        adviceHash: string
        phase: ArtifactId
        capability: CapabilityId
        purpose: DispatchPurpose
        action: string
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
    /** Implementation diff and policy against which the command executed. */
    implementationDiffHash?: string
    policyHash?: string
}

/** Constrained impact category a worker question may request. */
export type QuestionImpact = "requirements" | "design" | "implementation" | "validation"

/** Payload shaped exactly like OpenCode's QuestionInfo for the native question tool. */
export type QuestionToolPayload = {
    /** The complete question text presented to the user. */
    question: string
    /** Very short label displayed in the question header (max 30 chars). */
    header: string
    /** Available choices presented to the user. */
    options: Array<{
        /** Display text (1-5 words, concise). */
        label: string
        /** Explanation of the choice. */
        description: string
    }>
    /** Whether the user can select multiple options. Always false for SpecOps. */
    multiple?: boolean
    /** Whether the user can provide free-form text as an alternative to options. */
    custom?: boolean
}

/** A single validated choice presented to the user. */
export type WorkerQuestionOption = {
    id: string
    label: string
    /** Whether this option is the worker's recommendation. */
    recommended?: boolean
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
 * implicitly pending while they appear on `RunState.pendingQuestions`.
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
    raisedAt: string
    resolvedAt: string
    outcome: "answered" | "cancelled" | "dismissed"
    selectedOptionId?: string
    selectedOptionLabel?: string
    otherText?: string
    answerHash: string
    invalidatedArtifacts: ArtifactId[]
}

/** A live, unanswered checkpoint paused between dispatch phases. */
export type PendingCheckpoint = {
    dispatchId: string
    /** Capability of the producing dispatch; replay targets must match exactly. */
    capability: CapabilityId
    /** Purpose of the producing dispatch; replay targets must match exactly. */
    purpose: DispatchPurpose
    /** Action mode (or capability) of the producing dispatch; replay must match. */
    action: string
    /** Immutable snapshot of the checkpoint artifacts and their output hashes. */
    artifacts: CheckpointArtifactSnapshot[]
    /** Policy hash at the moment the checkpoint was queued. */
    policyHash: string
    /** Implementation diff hash at the moment the checkpoint was queued. */
    implementationDiffHash?: string
    /** Stable binding hash over the snapshot, dispatch, policy, and diff hashes. */
    bindingHash: string
    raisedAt: string
}

/** Immutable snapshot of one artifact and its output hash at checkpoint time. */
export type CheckpointArtifactSnapshot = {
    artifact: ArtifactId
    outputHash: string
}

/** Immutable record of a resolved checkpoint. */
export type CheckpointRecord = {
    dispatchId: string
    capability: CapabilityId
    purpose: DispatchPurpose
    action: string
    /** Immutable snapshot of the checkpoint artifacts at the time the checkpoint was raised. */
    artifacts: CheckpointArtifactSnapshot[]
    policyHash: string
    implementationDiffHash?: string
    bindingHash: string
    raisedAt: string
    resolvedAt: string
    outcome: "continued" | "feedback" | "cancelled" | "stale"
    /** Explicit replay intent when feedback was supplied. */
    resolution?: CheckpointResolution
    feedback?: string
    feedbackHash?: string
    invalidatedArtifacts: ArtifactId[]
}

/** Stable target describing the phase that must be redispatched after an answer. */
export type ResumeTarget = {
    /** Source record id (worker question or checkpoint) being replayed. */
    sourceId: string
    originalDispatchId: string
    phase: ArtifactId
    capability: CapabilityId
    /** Purpose of the originating dispatch; the replay must match exactly. */
    purpose: DispatchPurpose
    /** Action (mode or capability) of the originating dispatch; the replay must match exactly. */
    action: string
    /** Hash of the answer/feedback that drives the fresh dispatch. */
    answerHash: string
    /** Whether the replay follows a worker question or a checkpoint. */
    origin: "question" | "checkpoint"
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
    version: 5
    /** Monotonic optimistic-concurrency revision of the persisted run state. */
    revision: number
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
    /** Immutable normalized assurance responses used as refuter input. */
    reviewSubmissions: ReviewSubmission[]
    /** Bounded repair assignments and their observed outcomes. */
    repairTasks: RepairTask[]
    /** A repair selected by the controller from a validated review ledger. */
    pendingRepair?: {
        mode: RepairMode
        summary: string
        instruction?: string
        taskId?: string
        findingIds?: string[]
        evidence?: EvidenceRef[]
        acceptanceCriteria?: string[]
        sourceLedgerHash?: string
    }
    /** Frontier policy snapshotted when the run starts. */
    frontierPolicy: FrontierPolicy
    /** Frontier call accounting. */
    frontierUsage: FrontierUsage
    /** Immutable compact frontier escalation history. */
    frontierHistory: FrontierEpisode[]
    /** Frontier dispatch currently awaiting completion. */
    pendingFrontier?: PendingFrontier
    /** Originating phase to replay with validated frontier advice. */
    frontierResume?: FrontierResumeTarget
    /** A live, unanswered worker-raised question batch (1+ questions). */
    pendingQuestions?: PendingQuestion[]
    /** Immutable history of answered, cancelled, or dismissed questions. */
    questionHistory: QuestionRecord[]
    /** A live, unresolved interactive checkpoint between dispatch phases. */
    pendingCheckpoint?: PendingCheckpoint
    /** Immutable history of resolved interactive checkpoints. */
    checkpointHistory: CheckpointRecord[]
    /** Explicit target for the fresh dispatch issued after an answer. */
    resumeTarget?: ResumeTarget
    implementationDiffHash?: string
    /** Bounded scheduler decisions retained for loop diagnosis. */
    schedulerHistory?: Array<{
        sequence: number
        revision: number
        snapshotHash: string
        action?: string
        capability?: CapabilityId
        purpose?: DispatchPurpose
        bindingHash?: string
        reason?: string
        at: string
    }>
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

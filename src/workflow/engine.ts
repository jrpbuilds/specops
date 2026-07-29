import type { SpecOpsConfig } from "../config.js"
import { applyEscalation, decideEscalation } from "../escalation/policy.js"
import { assertCleanWorktree, baseCommit, collectDiff } from "../git.js"
import { createChange, openSpecOrThrow, uniqueChangeName, writeArtifact } from "../openspec.js"
import { parseAssessment } from "../routing/assessment.js"
import { requirementsFor } from "../routing/policy.js"
import { readMachine, readRun, writeMachine, writeRun } from "../state/store.js"
import type {
    ArtifactId,
    BlockReason,
    CommandEvidence,
    DispatchRecord,
    EscalationClaim,
    RepairMode,
    RunState,
    WorkflowOutcome,
} from "../types.js"
import { hash, invalidate } from "../artifacts/lifecycle.js"
import { dispatchHash, nextAction, nextDirective, type ControllerDirective } from "./scheduler.js"
import type { WorkflowAction } from "./actions.js"
import {
    answerQuestion,
    consumeResumeTarget,
    dismissQuestion,
    flushPendingQuestionOnCancel,
    registerPendingQuestion,
} from "./questions.js"
import { parseWorkerOutput } from "../worker_output.js"

/**
 * Final-format deterministic workflow engine.
 *
 * Drives a change from clean start to terminal outcome via a strict sequence
 * of scheduler-selected dispatches, controller-owned artifact persistence,
 * escalation adjudication, and completion gates. The controller is the only
 * component allowed to mutate planning, design, and review artifacts.
 */

/**
 * Maps persisted text artifacts to their on-disk file names under a change.
 *
 * Non-text artifacts (judgments, dispatches, receipt) are written by their own
 * code paths and are intentionally absent from this index.
 */
const ARTIFACT_FILES: Partial<Record<ArtifactId, string>> = {
    routing: "routing.md",
    exploration: "exploration.md",
    proposal: "proposal.md",
    design: "design.md",
    tasks: "tasks.md",
    verification: "verification.md",
    "review-ledger": "review-ledger.json",
}

/**
 * Refuter review ledger: a deduplicated list of findings with severity, an
 * optional {@link RepairMode} (set only for blocking findings), and a summary.
 */
type ReviewLedger = {
    findings: Array<{
        severity: "BLOCKER" | "HIGH" | "MEDIUM" | "LOW"
        mode?: RepairMode
        summary: string
    }>
}

/**
 * Parsed independent judgment: a PASS/FAIL verdict with a human summary and a
 * findings list. A FAIL verdict schedules a bounded repair or terminal outcome.
 */
type Judgment = {
    verdict: "PASS" | "FAIL"
    summary: string
    findings: unknown[]
}

/**
 * Start a clean, final-format run and persist controller-owned machine state.
 *
 * Assesses the change, routes it to a scope tier, creates the OpenSpec change,
 * writes the initial run state, and persists the routing artifact, context
 * machine, evidence machine, and artifact index.
 *
 * @param directory - Repository root directory.
 * @param config - Full SpecOps configuration.
 * @param input - Goal string, assessment JSON output, requested tier, and
 *   execution mode (automatic or interactive).
 * @returns The change name and the newly created {@link RunState}.
 */
export async function startRun(
    directory: string,
    config: SpecOpsConfig,
    input: {
        goal: string
        assessmentOutput: string
        requestedTier: "auto" | RunState["scopeTier"]
        mode: RunState["mode"]
    },
): Promise<{ change: string; state: RunState }> {
    const assessment = parseAssessment(input.assessmentOutput)
    const routed = requirementsFor(assessment, input.requestedTier, config)
    const change = await uniqueChangeName(directory, input.goal)

    if (config.automation.requireCleanWorktree) {
        await assertCleanWorktree(directory)
    }
    await createChange(directory, config, change, input.goal, routed.requirements.scopeTier)

    const now = new Date().toISOString()
    const state: RunState = {
        version: 2,
        mode: input.mode,
        goal: input.goal,
        baseline: "",
        requestedTier: input.requestedTier,
        scopeTier: routed.requirements.scopeTier,
        assessment,
        requirements: routed.requirements,
        riskFacets: assessment.riskFacets,
        uncertainty: assessment.uncertainty,
        routingReasons: routed.reasons,
        decisions: [],
        budgetUsage: {},
        dispatches: [],
        artifacts: {},
        invalidations: [],
        repairs: [],
        questionHistory: [],
        questionBudgetUsage: {
            questionsRaised: 0,
            questionsByDispatch: {},
            fingerprintCounts: {},
        },
        createdAt: now,
        updatedAt: now,
        status: "running",
    }

    state.baseline = await baseCommit(directory)

    await persistArtifact(
        directory,
        change,
        state,
        "routing",
        "specops-engine",
        routingMarkdown(state),
        "workflow",
    )
    await writeRun(directory, change, state)
    await writeMachine(directory, change, "specops-context.json", {
        version: 1,
        goal: input.goal,
        baseline: state.baseline,
        riskFacets: state.riskFacets,
        touchedSurfaces: assessment.touchedSurfaces,
        openQuestions: assessment.unresolvedQuestions,
        relevantPaths: assessment.inspectedPaths,
        decisions: [],
    })
    await writeMachine(directory, change, "specops-evidence.json", { version: 1, commands: [] })
    await writeArtifactIndex(directory, change, state)

    return { change, state }
}

/**
 * Compute and persist the next controller directive.
 *
 * This is the canonical progression entry point used by `specops_next_action`.
 * When the directive is `dispatch`, an issued {@link DispatchRecord} is
 * persisted so {@link completeAction} can later match the worker output. For
 * `ask-question`, `block`, and `finalize` directives no dispatch is recorded;
 * the run state is persisted only when a resume target was consumed.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param config - Configuration subset needed for diff collection limits.
 * @returns The next {@link ControllerDirective}.
 */
export async function issueDirective(
    directory: string,
    change: string,
    config: Pick<SpecOpsConfig, "review">,
): Promise<ControllerDirective> {
    const state = await readRun(directory, change)

    if (state.artifacts.implementation?.validity === "valid" && state.status === "running") {
        state.implementationDiffHash = hash(
            await collectDiff(directory, config.review.maxDiffBytes),
        )
    }

    const directive = nextDirective(state)

    if (directive.type === "dispatch") {
        const record: DispatchRecord = {
            id: directive.action.id,
            action: directive.action.mode ?? directive.action.capability,
            agent: directive.action.agent,
            capability: directive.action.capability,
            purpose: directive.action.purpose,
            independent: directive.action.independent,
            inputHash: dispatchHash(directive.action, state),
            status: "issued",
            at: new Date().toISOString(),
        }

        // Persist resume target metadata on the dispatch before consuming it.
        const resume = consumeResumeTarget(state)
        if (resume) {
            record.resume = {
                questionId: resume.questionId,
                originalDispatchId: resume.originalDispatchId,
                answerHash: resume.answerHash,
                phase: resume.phase,
                capability: resume.capability,
            }
        }
        state.dispatches.push(record)
    }

    await writeRun(directory, change, state)
    return directive
}

/**
 * Validate and persist an issued worker result. The controller is the only
 * component allowed to write planning, design, and review artifacts.
 *
 * Parses the worker output once, applying any escalation claim and detecting
 * any worker-raised question. If a question is present, the dispatch is
 * completed but no phase artefact is marked valid; instead a pending question
 * is registered. If no question is present, the appropriate phase artefact is
 * persisted. On failure the dispatch is marked `failed` and the error is
 * re-thrown.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param dispatchId - The id of the dispatch to complete (must be `issued`).
 * @param output - The raw text output from the worker.
 * @param config - Configuration subset carrying marker bounds and review limits.
 * @returns The updated {@link RunState}.
 * @throws When the dispatch is unknown or already completed, or when parsing
 *   fails, or when both an escalation and a question marker are present.
 */
export async function completeAction(
    directory: string,
    change: string,
    dispatchId: string,
    output: string,
    config: Pick<SpecOpsConfig, "questions" | "review">,
): Promise<RunState> {
    const state = await readRun(directory, change)
    const dispatch = state.dispatches.find(record => record.id === dispatchId)
    if (!dispatch || dispatch.status !== "issued") {
        throw new Error("unknown or completed SpecOps dispatch")
    }

    const action = actionFromDispatch(dispatch)
    const phase = phaseForAction(action)

    try {
        const parsed = parseWorkerOutput(output, config, phase, dispatch.capability)

        applyClaim(state, parsed.escalation)

        if (parsed.question) {
            // A required question takes precedence over phase completion.
            // The cleaned prose is retained only as dispatch evidence via the
            // output hash; the phase artefact is intentionally not published.
            dispatch.outputHash = hash(parsed.prose)
            registerPendingQuestion(state, dispatch, parsed.question, config)
            dispatch.status = "completed"
        } else {
            await persistActionResult(directory, change, state, action, parsed.prose, config)
            dispatch.outputHash = hash(parsed.prose)
            dispatch.status = "completed"
        }
    } catch (error) {
        dispatch.status = "failed"
        await writeRun(directory, change, state)
        throw error
    }

    await writeArtifactIndex(directory, change, state)
    await writeRun(directory, change, state)
    return state
}

/**
 * Record an answer to the run's pending question and resume scheduling.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param questionId - ID of the pending question to answer.
 * @param selectedOptionId - Selected option id, if answering with a normal option.
 * @param otherText - User-supplied Other text, if answering with Other.
 * @param config - Configuration carrying Other-text bounds.
 * @returns The updated {@link RunState}.
 * @throws When validation fails or no matching pending question exists.
 */
export async function answerQuestionAction(
    directory: string,
    change: string,
    questionId: string,
    selectedOptionId: string | undefined,
    otherText: string | undefined,
    config: Pick<SpecOpsConfig, "questions">,
): Promise<RunState> {
    const state = await readRun(directory, change)
    answerQuestion(state, questionId, selectedOptionId, otherText, config)
    await writeArtifactIndex(directory, change, state)
    await writeRun(directory, change, state)
    return state
}

/**
 * Record that the user dismissed the native question UI.
 *
 * The run is paused with the pending question retained for re-presentation.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param questionId - ID of the pending question being dismissed.
 * @returns The updated {@link RunState}.
 * @throws When no matching pending question exists.
 */
export async function dismissQuestionAction(
    directory: string,
    change: string,
    questionId: string,
): Promise<RunState> {
    const state = await readRun(directory, change)
    dismissQuestion(state, questionId)
    await writeRun(directory, change, state)
    return state
}

/**
 * Record cancellation only while a run is active and leave issued work retryable as failed.
 *
 * Marks any in-flight dispatches as `failed` (so they may be re-issued), flushes
 * any pending question into history with outcome `cancelled`, and assigns a
 * terminal `cancelled` outcome. No-op for already-terminal runs.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param reason - Human-readable cancellation reason (defaults to a user message).
 * @returns The updated {@link RunState}.
 */
export async function cancelRun(
    directory: string,
    change: string,
    reason = "Cancelled by user.",
): Promise<RunState> {
    const state = await readRun(directory, change)
    if (!isActive(state.status)) {
        return state
    }
    for (const dispatch of state.dispatches) {
        if (dispatch.status === "issued") {
            dispatch.status = "failed"
        }
    }
    flushPendingQuestionOnCancel(state)
    setOutcome(state, "cancelled", "cancelled", reason)
    await writeRun(directory, change, state)
    return state
}

/**
 * Finalize only after every deterministic scheduling and artifact gate passes.
 *
 * For runs with a pending question, persist the paused state and return it
 * so the caller can render the stable CLI DTO. For running runs, asserts
 * no pending scheduler action, validates required artifacts and evidence, runs
 * OpenSpec validation, and assigns a terminal `passed` outcome on success.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param config - Full SpecOps configuration.
 * @returns The finalized {@link RunState}.
 * @throws When the completion gates are not yet satisfied.
 */
export async function finalizeRun(
    directory: string,
    change: string,
    config: SpecOpsConfig,
): Promise<RunState> {
    const state = await readRun(directory, change)

    if (state.status === "paused" && state.pendingQuestion) {
        await writeRun(directory, change, state)
        return state
    }

    if (state.status !== "running") {
        return state
    }

    if (nextAction(state)) {
        throw new Error("SpecOps completion gates are not satisfied")
    }

    const missing = state.requirements.requiredArtifacts.filter(
        artifact => artifact !== "receipt" && state.artifacts[artifact]?.validity !== "valid",
    )
    if (missing.length) {
        setOutcome(
            state,
            "failed",
            "internal-error",
            `Completion artifacts are missing or stale: ${missing.join(", ")}`,
        )
        await writeRun(directory, change, state)
        return state
    }

    const missingEvidence = await missingEvidenceGates(directory, change, state)
    if (missingEvidence.length) {
        setOutcome(
            state,
            "failed",
            "validation-failed",
            `Registered validation evidence is missing or unsuccessful: ${missingEvidence.join(", ")}`,
        )
        await writeRun(directory, change, state)
        return state
    }

    try {
        await openSpecOrThrow(directory, config, ["validate", "--type", "change", change])
    } catch (error) {
        setOutcome(state, "failed", "validation-failed", String(error))
        await writeRun(directory, change, state)
        return state
    }

    state.status = "passed"
    state.outcome = {
        category: "completed",
        message: "All deterministic workflow, evidence, review, and archive gates passed.",
        at: new Date().toISOString(),
    }
    const receipt = {
        version: 2,
        outcome: state.outcome,
        baseline: state.baseline,
        diffHash: state.implementationDiffHash,
        requirementsHash: state.requirements.policyHash,
        dispatches: state.dispatches,
        artifacts: state.artifacts,
        invalidations: state.invalidations,
        repairs: state.repairs,
        decisions: state.decisions,
        questionHistory: state.questionHistory,
    }
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`
    await writeArtifact(directory, change, "specops-receipt.json", serialized)
    recordArtifact(state, "receipt", "specops-engine", serialized, "workflow")
    await writeArtifactIndex(directory, change, state)
    await writeRun(directory, change, state)
    return state
}

/**
 * Return a stable public DTO for a paused pending-question block.
 *
 * @param state - Current run state.
 * @param change - Change identifier.
 * @returns A machine-readable pending-question view, or `undefined` when the
 *   run is not paused or has no pending question.
 */
// pendingQuestionBlockView is exported from src/workflow/questions.js; the
// orchestrator and tests import it directly.

/**
 * Return registered command validations that cannot satisfy the completion receipt.
 *
 * Cross-references `requiredValidations` of kind `command` against the
 * persisted `specops-evidence.json` registry and reports any requirement for
 * which no evidence row with matching id, executable, args, and exit code 0
 * exists.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param state - The current run state.
 * @returns The ids of required command validations lacking successful evidence.
 */
async function missingEvidenceGates(
    directory: string,
    change: string,
    state: RunState,
): Promise<string[]> {
    const registry = await readMachine<{ version: 1; commands: CommandEvidence[] }>(
        directory,
        change,
        "specops-evidence.json",
        { version: 1, commands: [] },
    )
    const missingCommands = state.requirements.requiredValidations
        .filter(requirement => requirement.kind === "command")
        .filter(
            requirement =>
                !registry.commands.some(
                    evidence =>
                        evidence.validationId === requirement.id &&
                        evidence.executable === requirement.executable &&
                        JSON.stringify(evidence.args) === JSON.stringify(requirement.args) &&
                        evidence.exitCode === 0,
                ),
        )
        .map(requirement => requirement.id)
    return missingCommands
}

/**
 * Persist a worker's output as the appropriate controller-owned artifact(s).
 *
 * Routes by capability: exploration, planning (bundle or task refinement),
 * design (with optional repair invalidation), implementation/repair (records
 * the diff hash and invalidates stale downstream), verification, judgment
 * (schedules repair on FAIL), and refutation (review ledger). Consultation and
 * independent-review prose is captured in dispatch provenance only.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param state - The current run state (mutated in place).
 * @param action - The action being completed.
 * @param output - The cleaned worker prose to persist.
 * @param config - Configuration subset needed for diff collection limits.
 * @returns Resolves when the artifact(s) and provenance are persisted.
 * @throws When a persisted artifact is structurally invalid.
 */
async function persistActionResult(
    directory: string,
    change: string,
    state: RunState,
    action: WorkflowAction,
    output: string,
    config: Pick<SpecOpsConfig, "review">,
): Promise<void> {
    switch (action.capability) {
        case "exploration":
            await persistArtifact(
                directory,
                change,
                state,
                "exploration",
                action.agent,
                output,
                action.purpose,
            )
            return
        case "planning":
            if (action.mode === "task-refinement") {
                await persistArtifact(
                    directory,
                    change,
                    state,
                    "tasks",
                    action.agent,
                    output,
                    action.purpose,
                )
            } else {
                await savePlanningBundle(directory, change, state, action, output)
            }
            return
        case "design":
            if (action.mode === "artifact-repair") {
                invalidate(state, ["design"], "validated design replacement")
            }
            await persistArtifact(
                directory,
                change,
                state,
                "design",
                action.agent,
                output,
                action.purpose,
            )
            state.pendingRepair = undefined
            return
        case "implementation":
        case "repair":
            state.implementationDiffHash = hash(
                await collectDiff(directory, config.review.maxDiffBytes),
            )
            recordArtifact(
                state,
                "implementation",
                action.agent,
                state.implementationDiffHash,
                action.purpose,
            )
            invalidate(state, ["implementation"], "implementation changed")
            recordArtifact(
                state,
                "implementation",
                action.agent,
                state.implementationDiffHash,
                action.purpose,
            )
            state.pendingRepair = undefined
            return
        case "verification":
            await persistArtifact(
                directory,
                change,
                state,
                "verification",
                action.agent,
                output,
                action.purpose,
            )
            return
        case "correctness-judgment":
        case "compliance-judgment": {
            const artifact = action.capability
            const judgment = parseJudgment(output)
            const file =
                artifact === "correctness-judgment"
                    ? "judgment-correctness.json"
                    : "judgment-compliance.json"
            await writeArtifact(directory, change, file, output)
            recordArtifact(state, artifact, action.agent, output, action.purpose)
            if (judgment.verdict === "FAIL") {
                scheduleRepairOrOutcome(
                    state,
                    artifact === "correctness-judgment" ? "implementation-defect" : "spec-mismatch",
                    judgment.summary,
                )
            }
            return
        }
        case "refutation":
            await saveReviewLedger(directory, change, state, action, output)
            return
        default:
            // Consultation and independent-review prose is captured in dispatch
            // provenance. Only the refuter is allowed to turn it into a repair.
            return
    }
}

/**
 * Validate and persist a planning bundle (proposal, specs, optional tasks).
 *
 * Parses the bundle JSON, requires a proposal, parses specs (and tasks when in
 * `standard-bundle` mode), optionally invalidates a prior proposal on repair,
 * then writes each member atomically before recording provenance. Clears the
 * pending repair on success.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param state - The current run state (mutated in place).
 * @param action - The planning action (mode selects bundle shape).
 * @param output - The raw planning bundle JSON.
 * @returns Resolves when the bundle is validated and persisted.
 * @throws When the bundle, proposal, specs, or tasks are missing or invalid.
 */
async function savePlanningBundle(
    directory: string,
    change: string,
    state: RunState,
    action: WorkflowAction,
    output: string,
): Promise<void> {
    const bundle = parseObject(output, "planning bundle")
    const requiresTasks = action.mode === "standard-bundle"
    const proposal = requireString(bundle.proposal, "planning bundle proposal")
    const specs = parseSpecs(bundle.specs)
    const tasks = requiresTasks ? requireString(bundle.tasks, "planning bundle tasks") : undefined

    // Validate the complete bundle before writing any member. Atomic individual
    // writes ensure readers never see a partially written file.
    if (action.mode === "artifact-repair") {
        invalidate(state, ["proposal"], "validated planning replacement")
    }
    await persistArtifact(
        directory,
        change,
        state,
        "proposal",
        action.agent,
        proposal,
        action.purpose,
    )
    for (const [name, content] of Object.entries(specs)) {
        await writeArtifact(directory, change, `specs/${name}/spec.md`, content)
    }
    recordArtifact(state, "specs", action.agent, JSON.stringify(specs), action.purpose)
    if (tasks) {
        await persistArtifact(
            directory,
            change,
            state,
            "tasks",
            action.agent,
            tasks,
            action.purpose,
        )
    }
    state.pendingRepair = undefined
}

/**
 * Persist a refuter review ledger and schedule a repair or terminal outcome.
 *
 * Parses the ledger, writes it as a review-ledger artifact, then inspects
 * findings for a BLOCKER or HIGH severity entry. If a repair mode is attached
 * the finding schedules a bounded repair; otherwise the run is terminated with
 * a `review-failed` outcome.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param state - The current run state (mutated in place).
 * @param action - The refutation action.
 * @param output - The raw review ledger JSON.
 * @returns Resolves when the ledger is persisted and the outcome scheduled.
 */
async function saveReviewLedger(
    directory: string,
    change: string,
    state: RunState,
    action: WorkflowAction,
    output: string,
): Promise<void> {
    const ledger = parseReviewLedger(output)
    await persistArtifact(
        directory,
        change,
        state,
        "review-ledger",
        action.agent,
        output,
        action.purpose,
    )
    const finding = ledger.findings.find(item => ["BLOCKER", "HIGH"].includes(item.severity))
    if (!finding) {
        return
    }
    if (!finding.mode) {
        setOutcome(state, "failed", "review-failed", finding.summary)
        return
    }
    scheduleRepairOrOutcome(state, finding.mode, finding.summary)
}

/**
 * Schedule one bounded repair or stop safely when policy disallows another cycle.
 *
 * @param state - The current run state (mutated in place).
 * @param mode - The repair mode.
 * @param summary - Human-readable summary of the finding that triggered the repair.
 */
function scheduleRepairOrOutcome(state: RunState, mode: RepairMode, summary: string): void {
    const used = state.budgetUsage.maxRepairCycles ?? 0
    if (used >= state.requirements.budgets.maxRepairCycles) {
        setOutcome(
            state,
            "blocked",
            "policy-blocked",
            `Repair budget exhausted with unresolved finding: ${summary}`,
            "budget-exhausted",
        )
        return
    }

    state.pendingRepair = { mode, summary }
    state.repairs.push({ mode, summary, at: new Date().toISOString() })
    state.budgetUsage.maxRepairCycles = used + 1
    invalidate(state, ["implementation"], `blocking review finding: ${summary}`)
}

/**
 * Assign the machine-readable terminal or paused outcome representation.
 *
 * @param state - The run state (mutated in place).
 * @param status - The terminal status to assign.
 * @param category - The machine-readable outcome category.
 * @param message - The human-readable outcome message.
 * @param blockReason - Optional detailed reason for a blocked outcome.
 */
function setOutcome(
    state: RunState,
    status: "blocked" | "failed" | "cancelled",
    category: WorkflowOutcome["category"],
    message: string,
    blockReason?: BlockReason,
): void {
    state.status = status
    if (blockReason) {
        state.blockReason = blockReason
    }
    if (status !== "cancelled") {
        state.outcome = { category, message, at: new Date().toISOString() }
    } else {
        state.outcome = { category, message, at: new Date().toISOString() }
    }
}

/**
 * Apply an escalation claim to the run state.
 *
 * @param state - The current run state (mutated in place).
 * @param claim - The parsed escalation claim, if any.
 */
function applyClaim(state: RunState, claim: EscalationClaim | undefined): void {
    if (!claim) {
        return
    }

    const decision = decideEscalation(state, claim)
    state.decisions.push(decision)
    if (decision.disposition === "accepted" || decision.disposition === "narrowed") {
        applyEscalation(state, decision.appliedPatch)
        if (decision.appliedPatch.invalidate?.length) {
            invalidate(
                state,
                decision.appliedPatch.invalidate,
                `accepted escalation: ${claim.summary}`,
            )
        }
    } else if (decision.reason.toLowerCase().includes("budget")) {
        setOutcome(
            state,
            "blocked",
            "policy-blocked",
            `Escalation could not proceed safely: ${decision.reason}`,
            "budget-exhausted",
        )
    }
}

/**
 * Reconstruct a lightweight {@link WorkflowAction} from a persisted dispatch record.
 *
 * @param dispatch - The persisted dispatch record.
 * @returns A {@link WorkflowAction} matching the dispatch's recorded fields.
 */
function actionFromDispatch(dispatch: DispatchRecord): WorkflowAction {
    return {
        id: dispatch.id,
        capability: dispatch.capability,
        agent: dispatch.agent as WorkflowAction["agent"],
        purpose: dispatch.purpose,
        independent: dispatch.independent,
        mode: dispatch.action,
        prompt: "",
    }
}

/**
 * Resolve the workflow phase an action contributes to.
 *
 * @param action - The action being completed.
 * @returns The artifact id the action targets.
 */
function phaseForAction(action: WorkflowAction): ArtifactId {
    if (action.purpose === "judgment") {
        return action.capability === "compliance-judgment"
            ? "compliance-judgment"
            : "correctness-judgment"
    }
    if (action.purpose === "consultation") {
        return "proposal"
    }
    if (action.purpose === "independent-review") {
        return "review-ledger"
    }
    if (action.purpose === "repair") {
        return "implementation"
    }

    switch (action.capability) {
        case "exploration":
            return "exploration"
        case "planning":
            return action.mode === "task-refinement" ? "tasks" : "proposal"
        case "design":
            return "design"
        case "implementation":
        case "repair":
            return "implementation"
        case "verification":
            return "verification"
        case "refutation":
            return "review-ledger"
        default:
            return "proposal"
    }
}

/**
 * Write a text artifact to disk and record its provenance in state.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param state - The current run state (mutated in place).
 * @param artifact - The artifact id to persist.
 * @param producer - The agent id that produced the content.
 * @param content - The raw artifact content.
 * @param purpose - The dispatch purpose that produced this artifact.
 * @throws When the artifact id is not in {@link ARTIFACT_FILES}.
 */
async function persistArtifact(
    directory: string,
    change: string,
    state: RunState,
    artifact: ArtifactId,
    producer: string,
    content: string,
    purpose: DispatchRecord["purpose"],
): Promise<void> {
    const file = ARTIFACT_FILES[artifact]
    if (!file) {
        throw new Error(`artifact ${artifact} is not a text artifact`)
    }

    await writeArtifact(directory, change, file, content)
    recordArtifact(state, artifact, producer, content, purpose)
}

/**
 * Record artifact provenance in the run state without writing to disk.
 *
 * Provenance input hashes include the current policy hash, implementation diff
 * hash, and answer hashes from the question history, so a changed answer makes
 * dependent artifacts stale.
 *
 * @param state - The current run state (mutated in place).
 * @param artifact - The artifact id to record.
 * @param producer - The agent id that produced the content.
 * @param content - The raw artifact content (hashed for provenance).
 * @param purpose - The dispatch purpose that produced this artifact.
 */
function recordArtifact(
    state: RunState,
    artifact: ArtifactId,
    producer: string,
    content: string,
    purpose: DispatchRecord["purpose"],
): void {
    state.artifacts[artifact] = {
        artifact,
        producer,
        purpose,
        generatedAt: new Date().toISOString(),
        inputHashes: {
            policy: state.requirements.policyHash,
            diff: state.implementationDiffHash ?? "",
            ...answerHashes(state),
        },
        outputHash: hash(content),
        scopeTier: state.scopeTier,
        capabilities: state.requirements.requiredCapabilities,
        validity: "valid",
    }
}

/**
 * Persist the current artifact index to the `specops-artifacts.json` machine file.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param state - The current run state whose `artifacts` map is written.
 */
async function writeArtifactIndex(
    directory: string,
    change: string,
    state: RunState,
): Promise<void> {
    await writeMachine(directory, change, "specops-artifacts.json", {
        version: 1,
        artifacts: state.artifacts,
    })
}

/**
 * Build a stable map of answered question ids to answer hashes.
 *
 * @param state - The current run state.
 * @returns Record of question id to answer hash.
 */
function answerHashes(state: RunState): Record<string, string> {
    return Object.fromEntries(
        state.questionHistory
            .filter(record => record.outcome === "answered" && record.answerHash)
            .map(record => [record.id, record.answerHash]),
    )
}

/**
 * Return whether a status allows active worker dispatch.
 *
 * @param status - The run status.
 * @returns `true` for `running` and `paused` (resumable); `false` for terminal.
 */
function isActive(status: RunState["status"]): boolean {
    return status === "running" || status === "paused"
}

/**
 * Render the routing artifact Markdown from the run's scope tier and reasons.
 *
 * @param state - The current run state.
 * @returns A Markdown string summarizing the scope tier and routing reasons.
 */
function routingMarkdown(state: RunState): string {
    return [
        "# Routing",
        "",
        `- Scope tier: **${state.scopeTier}**`,
        "",
        ...state.routingReasons.map(reason => `- ${reason}`),
        "",
    ].join("\n")
}

/**
 * Parse a JSON object from a string, stripping an optional Markdown code fence.
 *
 * @param output - The raw string to parse.
 * @param label - A human-readable label used in error messages.
 * @returns The parsed object.
 * @throws When the value is not a JSON object or parsing fails.
 */
function parseObject(output: string, label: string): Record<string, unknown> {
    try {
        const value = JSON.parse(output.trim().replace(/^```json\s*|```$/g, ""))
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error()
        }
        return value as Record<string, unknown>
    } catch {
        throw new Error(`${label} must be a JSON object`)
    }
}

/**
 * Assert a value is a non-empty string and return it.
 *
 * @param value - The value to check.
 * @param label - A human-readable label used in error messages.
 * @returns The trimmed string.
 * @throws When the value is not a string or is empty/whitespace-only.
 */
function requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label} is invalid`)
    }
    return value
}

/**
 * Parse and validate a planning bundle's specs record.
 *
 * @param value - The raw value from the planning bundle JSON.
 * @returns A record of spec names to content strings.
 * @throws When the value is not an object, contains invalid spec names, or
 *   has empty content.
 */
function parseSpecs(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("planning bundle specs are invalid")
    }

    const specs: Record<string, string> = {}
    for (const [name, content] of Object.entries(value as Record<string, unknown>)) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || typeof content !== "string" || !content.trim()) {
            throw new Error("planning bundle contains an invalid spec")
        }
        specs[name] = content
    }
    if (!Object.keys(specs).length) {
        throw new Error("planning bundle must contain at least one spec")
    }
    return specs
}

/**
 * Parse and validate a refuter review ledger from raw output.
 *
 * @param output - The raw review ledger JSON string.
 * @returns The parsed and validated {@link ReviewLedger}.
 * @throws When the output is not valid JSON, lacks findings, or contains an
 *   invalid finding.
 */
function parseReviewLedger(output: string): ReviewLedger {
    const value = parseObject(output, "review ledger")
    if (!Array.isArray(value.findings)) {
        throw new Error("review ledger must include findings")
    }

    const modes = new Set<RepairMode>([
        "implementation-defect",
        "spec-mismatch",
        "test-deficiency",
        "review-finding",
        "design-revision",
    ])
    for (const finding of value.findings) {
        if (
            !finding ||
            typeof finding !== "object" ||
            !["BLOCKER", "HIGH", "MEDIUM", "LOW"].includes(
                (finding as ReviewLedger["findings"][number]).severity,
            ) ||
            typeof (finding as ReviewLedger["findings"][number]).summary !== "string" ||
            ((finding as ReviewLedger["findings"][number]).mode !== undefined &&
                !modes.has((finding as ReviewLedger["findings"][number]).mode as RepairMode))
        ) {
            throw new Error("review ledger contains an invalid finding")
        }
    }

    return value as ReviewLedger
}

/**
 * Parse a judgment before it can satisfy an independent-review artifact gate.
 *
 * @param output - The raw judgment JSON string.
 * @returns The parsed and validated {@link Judgment}.
 * @throws When the output is not valid JSON or lacks required fields.
 */
function parseJudgment(output: string): Judgment {
    const value = parseObject(output, "judgment")
    if (
        (value.verdict !== "PASS" && value.verdict !== "FAIL") ||
        typeof value.summary !== "string" ||
        !Array.isArray(value.findings)
    ) {
        throw new Error("judgment must include verdict, summary, and findings")
    }
    return value as Judgment
}

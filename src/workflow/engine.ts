import { readFile, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import type { SpecOpsConfig } from "../config.js"
import { AGENT_IDS } from "../capabilities/ids.js"
import { applyEscalation, decideEscalation } from "../escalation/policy.js"
import {
    assertCleanWorktree,
    baseCommit,
    collectChangedPaths,
    collectDiff,
    stashFingerprint,
} from "../git.js"
import { createChange, openSpecOrThrow, uniqueChangeName, writeArtifact } from "../openspec.js"
import { parseAssessment } from "../routing/assessment.js"
import { requirementsFor, scopeForActualDiff } from "../routing/policy.js"
import {
    changeRoot,
    readMachine,
    readRun,
    writeMachine,
    writeRun,
    writeTextAtomic,
} from "../state/store.js"
import type {
    ArtifactId,
    CheckpointResolution,
    BlockReason,
    CheckpointRecord,
    CommandEvidence,
    DispatchRecord,
    EscalationClaim,
    FrontierResponse,
    AssuranceFinding,
    PendingCheckpoint,
    RepairMode,
    RepairTask,
    ReviewLedger,
    RunState,
    WorkflowOutcome,
} from "../types.js"
import { hash, invalidate } from "../artifacts/lifecycle.js"
import {
    checkpointArtifactsFor,
    computeCheckpointBindingHash,
    dispatchHash,
    hasCheckpointFor,
    isCheckpointBindingCurrent,
    nextAction,
    nextDirective,
    snapshotCheckpointArtifacts,
    type ControllerDirective,
} from "./scheduler.js"
import type { WorkflowAction } from "./actions.js"
import {
    answerQuestion,
    consumeResumeTarget,
    dismissQuestion,
    flushPendingQuestionOnCancel,
    invalidationForCheckpoint,
    registerPendingQuestions,
} from "./questions.js"
import { parseWorkerOutput } from "../worker_output.js"
import { SPEC_NAME_REGEX, validateSpecContent } from "./contracts.js"
import {
    canPromotePending,
    completeFrontierEpisode,
    parseFrontierResponse,
    queueReviewFrontier,
    queueWorkerFrontier,
    recordFrontierDispatch,
    verifyFrontierEvidence,
} from "../frontier/policy.js"
import {
    createReviewSubmission,
    currentReviewSubmissions,
    leanLedgerFromSubmission,
    parseJudgment,
    parseLeanReviewLedger,
    parseReviewLedger,
    parseReviewSubmission,
    repairTargetForMode,
    stableId,
} from "./reviews.js"

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
        version: 4,
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
        reviewSubmissions: [],
        repairTasks: [],
        frontierPolicy: structuredClone(config.frontier),
        frontierUsage: { escalations: 0, dispatches: 0, highDispatches: 0 },
        frontierHistory: [],
        questionHistory: [],
        checkpointHistory: [],
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
    if (state.scopeTier === "lean") {
        await persistArtifact(
            directory,
            change,
            state,
            "exploration",
            AGENT_IDS.core.assessor,
            assessmentExplorationMarkdown(state),
            "workflow",
        )
    }
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
    await writeMachine(directory, change, "specops-evidence.json", { version: 2, commands: [] })
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
    config: Pick<SpecOpsConfig, "review" | "frontier">,
): Promise<ControllerDirective> {
    const state = await readRun(directory, change)

    const issued = state.dispatches.find(dispatch => dispatch.status === "issued")
    if (issued) {
        throw new Error(`SpecOps dispatch ${issued.id} is still issued and must be completed first`)
    }

    await refreshImplementationBinding(directory, state, config.review.maxDiffBytes)

    const directive = nextDirective(state)

    if (directive.type === "dispatch") {
        const inputHash = dispatchHash(directive.action, state)
        const record: DispatchRecord = {
            id: directive.action.id,
            action: directive.action.mode ?? directive.action.capability,
            agent: directive.action.agent,
            capability: directive.action.capability,
            purpose: directive.action.purpose,
            independent: directive.action.independent,
            inputHash,
            attempt:
                state.dispatches.filter(
                    item =>
                        item.capability === directive.action.capability &&
                        item.purpose === directive.action.purpose &&
                        item.inputHash === inputHash,
                ).length + 1,
            status: "issued",
            at: new Date().toISOString(),
        }
        if (
            directive.action.capability === "implementation" ||
            directive.action.capability === "repair"
        ) {
            try {
                record.writerGuard = await captureWriterGuard(directory, change, state)
            } catch (error) {
                setOutcome(state, "blocked", "policy-blocked", String(error), "policy-rejected")
                await writeRun(directory, change, state)
                return { type: "block", reason: "policy-rejected", resumable: false }
            }
        }

        // Persist resume target metadata on the dispatch before consuming it.
        const resumeTarget = state.resumeTarget
        const resume =
            resumeTarget &&
            directive.type === "dispatch" &&
            resumeTarget.capability === directive.action.capability &&
            resumeTarget.purpose === directive.action.purpose &&
            resumeTarget.action === (directive.action.mode ?? directive.action.capability)
                ? consumeResumeTarget(state)
                : undefined
        if (resume) {
            record.resume = {
                sourceId: resume.sourceId,
                originalDispatchId: resume.originalDispatchId,
                answerHash: resume.answerHash,
                phase: resume.phase,
                capability: resume.capability,
                purpose: resume.purpose,
                action: resume.action,
                origin: resume.origin,
            }
        }
        if (
            state.frontierResume &&
            !state.frontierResume.consumed &&
            directive.action.capability === state.frontierResume.capability &&
            directive.action.purpose === state.frontierResume.purpose &&
            (directive.action.mode ?? directive.action.capability) === state.frontierResume.action
        ) {
            record.frontierResume = {
                episodeId: state.frontierResume.episodeId,
                originalDispatchId: state.frontierResume.originalDispatchId,
                adviceHash: state.frontierResume.adviceHash,
                phase: state.frontierResume.phase,
                capability: state.frontierResume.capability,
                purpose: state.frontierResume.purpose,
                action: state.frontierResume.action,
            }
            state.frontierResume.consumed = true
        }
        state.dispatches.push(record)
        if (directive.action.capability === "frontier") {
            recordFrontierDispatch(state)
        }
    } else if (directive.type === "block" && directive.reason === "workflow-stalled") {
        setOutcome(
            state,
            "blocked",
            "policy-blocked",
            state.resumeTarget
                ? "SpecOps could not reconstruct the exact action targeted by the pending resume request."
                : "SpecOps detected a repeated consultation cycle without implementation progress.",
            "workflow-stalled",
        )
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
 * @throws When the dispatch is unknown, already completed, or already failed
 *   (in which case the controller must call `specops_next_action` to obtain a
 *   fresh dispatch), when parsing fails, or when both an escalation and a
 *   question marker are present.
 */
export async function completeAction(
    directory: string,
    change: string,
    dispatchId: string,
    output: string,
    config: Pick<SpecOpsConfig, "review" | "frontier" | "routing" | "workflow">,
): Promise<RunState> {
    const state = await readRun(directory, change)
    const dispatch = state.dispatches.find(record => record.id === dispatchId)
    if (!dispatch) {
        throw new Error(
            "unknown SpecOps dispatch; call specops_next_action to obtain a fresh dispatch",
        )
    }
    if (dispatch.status === "failed") {
        throw new Error(
            `SpecOps dispatch ${dispatchId} already failed and cannot be re-submitted; ` +
                "call specops_next_action to obtain a fresh dispatch for the same capability",
        )
    }
    if (dispatch.status !== "issued") {
        throw new Error(`SpecOps dispatch ${dispatchId} is already ${dispatch.status}`)
    }

    const action = actionFromDispatch(dispatch)
    const phase = phaseForAction(action)

    try {
        if (action.capability === "implementation" || action.capability === "repair") {
            await assertWriterGuards(directory, change, state, dispatch)
        }
        const parsed = parseWorkerOutput(output, phase, dispatch.capability)
        assertWorkerResult(action, parsed)

        const scopeBeforeCompletion = state.scopeTier
        applyClaim(state, parsed.escalation, config)

        if (parsed.questions && parsed.questions.length > 0) {
            // A required question batch takes precedence over phase completion.
            // The cleaned prose is retained only as dispatch evidence via the
            // output hash; the phase artefact is intentionally not published.
            dispatch.outputHash = hash(parsed.prose)
            registerPendingQuestions(state, dispatch, parsed.questions)
            dispatch.status = "completed"
        } else if (parsed.frontier) {
            if (state.frontierPolicy?.mode !== "adaptive") {
                await persistActionResult(directory, change, state, action, parsed.prose, config)
            } else {
                const evidenceRegistry = await readMachine<{
                    version: number
                    commands: CommandEvidence[]
                }>(directory, change, "specops-evidence.json", { version: 2, commands: [] })
                if (
                    !(await verifyFrontierEvidence(
                        directory,
                        parsed.frontier.evidence,
                        evidenceRegistry.commands,
                    ))
                ) {
                    setOutcome(
                        state,
                        "blocked",
                        "policy-blocked",
                        "Frontier escalation evidence could not be verified.",
                        "policy-rejected",
                    )
                } else {
                    const decision = queueWorkerFrontier(state, dispatch, phase, parsed.frontier)
                    if (decision.disposition === "continue") {
                        await persistActionResult(
                            directory,
                            change,
                            state,
                            action,
                            parsed.prose,
                            config,
                        )
                    } else if (decision.disposition === "blocked") {
                        setOutcome(
                            state,
                            "blocked",
                            "policy-blocked",
                            decision.reason,
                            "budget-exhausted",
                        )
                    }
                }
            }
            dispatch.outputHash = hash(parsed.prose)
            dispatch.status = "completed"
        } else {
            await persistActionResult(directory, change, state, action, parsed.prose, config)
            dispatch.outputHash = hash(parsed.prose)
            dispatch.status = "completed"
        }
        if (state.scopeTier !== scopeBeforeCompletion) {
            invalidate(
                state,
                ["proposal"],
                `scope raised from ${scopeBeforeCompletion} to ${state.scopeTier}`,
            )
        }

        // Queue an interactive checkpoint after a successful dispatch produces
        // checkpoint-eligible artifacts. Automatic runs never checkpoint. A
        // worker-raised question takes precedence (no artifact is published,
        // so no checkpoint is queued). The run must still be running and the
        // checkpoint artifacts must remain valid after any scope escalation.
        if (
            state.mode === "interactive" &&
            state.status === "running" &&
            !state.pendingQuestions &&
            !state.pendingFrontier
        ) {
            const checkpointArtifacts = checkpointArtifactsFor(state, action)
            if (checkpointArtifacts.length > 0) {
                const snapshot = snapshotCheckpointArtifacts(state, checkpointArtifacts)
                if (!hasCheckpointFor(state, dispatch.id, snapshot)) {
                    const bindingHash = computeCheckpointBindingHash(state, dispatch, snapshot)
                    const pending: PendingCheckpoint = {
                        dispatchId: dispatch.id,
                        capability: dispatch.capability,
                        purpose: dispatch.purpose,
                        action: dispatch.action,
                        artifacts: snapshot,
                        policyHash: state.requirements.policyHash,
                        implementationDiffHash: state.implementationDiffHash,
                        bindingHash,
                        raisedAt: new Date().toISOString(),
                    }
                    state.pendingCheckpoint = pending
                    state.status = "paused"
                    state.pauseReason = "checkpoint"
                    state.resumable = true
                }
            }
        }
    } catch (error) {
        dispatch.status = "failed"
        dispatch.failureReason = String(error).slice(0, 2_000)
        if (/writer guard/i.test(String(error))) {
            setOutcome(state, "blocked", "policy-blocked", String(error), "policy-rejected")
        }
        if (action.capability === "frontier") {
            fallbackFromFrontierFailure(state, String(error))
        }
        if (
            isAssuranceAction(action) &&
            state.dispatches.filter(
                item =>
                    item.status === "failed" &&
                    item.capability === dispatch.capability &&
                    item.purpose === dispatch.purpose &&
                    item.inputHash === dispatch.inputHash,
            ).length > config.review.transientRetries
        ) {
            setOutcome(
                state,
                "failed",
                "validation-failed",
                `Assurance output retry budget exhausted: ${dispatch.failureReason}`,
            )
        }
        await writeRun(directory, change, state)
        throw error
    }

    if (state.frontierHistory?.length) {
        await writeArtifact(
            directory,
            change,
            "specops-frontier.json",
            JSON.stringify(
                {
                    version: 1,
                    policy: state.frontierPolicy,
                    usage: state.frontierUsage,
                    episodes: state.frontierHistory,
                },
                null,
                2,
            ),
        )
    }
    await writeArtifactIndex(directory, change, state)
    await writeRun(directory, change, state)
    await writeQuestionLedger(directory, change, state)
    return state
}

/** Return whether malformed output should consume the bounded assurance retry policy. */
function isAssuranceAction(action: WorkflowAction): boolean {
    return (
        action.purpose === "judgment" ||
        action.purpose === "independent-review" ||
        action.capability === "refutation" ||
        (action.capability === "verification" && action.mode === "lean-assurance-bundle")
    )
}

/**
 * Persist the human-readable record of worker questions and their resolutions.
 *
 * The ledger is a projection of authoritative question history, so it is
 * rewritten atomically after every question state transition and replay. User
 * text is HTML-escaped before entering the markdown document.
 */
async function writeQuestionLedger(
    directory: string,
    change: string,
    state: RunState,
): Promise<void> {
    if (state.questionHistory.length === 0) return

    const sections = state.questionHistory.map(record => {
        const replay = state.dispatches.find(
            dispatch =>
                dispatch.resume?.origin === "question" && dispatch.resume.sourceId === record.id,
        )
        const artifact = state.artifacts[record.phase]
        const answer = record.otherText
            ? `<pre>${escapeLedgerText(record.otherText)}</pre>`
            : record.selectedOptionId
              ? `${escapeLedgerText(record.selectedOptionId)}${
                    record.selectedOptionLabel
                        ? ` — ${escapeLedgerText(record.selectedOptionLabel)}`
                        : ""
                }`
              : "Not answered"

        return [
            `## ${escapeLedgerText(record.phase)} — ${escapeLedgerText(record.id)}`,
            "",
            `- **Status:** ${record.outcome}`,
            `- **Dispatch:** ${escapeLedgerText(record.dispatchId)}`,
            `- **Raised:** ${record.raisedAt}`,
            `- **Resolved:** ${record.resolvedAt}`,
            `- **Impact:** ${record.impact}`,
            `- **Invalidated artifacts:** ${record.invalidatedArtifacts.join(", ") || "none"}`,
            `- **Replay dispatch:** ${replay ? escapeLedgerText(replay.id) : "pending"}`,
            `- **Regenerated artifact:** ${
                artifact ? `${record.phase} (${artifact.validity})` : `${record.phase} (missing)`
            }`,
            "",
            "### Question",
            "",
            `<pre>${escapeLedgerText(record.prompt)}</pre>`,
            "",
            "### Answer",
            "",
            answer,
        ].join("\n")
    })

    await writeTextAtomic(
        directory,
        change,
        "questions.md",
        [
            "# SpecOps Questions",
            "",
            "Controller-recorded worker questions and the user decisions used to regenerate phases.",
            "",
            ...sections,
        ].join("\n\n"),
    )
}

/** Escape untrusted text before placing it inside an HTML block in markdown. */
function escapeLedgerText(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/**
 * Record an answer to the run's pending question and resume scheduling.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param questionId - ID of the pending question to answer.
 * @param selectedOptionId - Selected option id, if answering with a normal option.
 * @param otherText - User-supplied Other text, if answering with Other.
 * @returns The updated {@link RunState}.
 * @throws When validation fails or no matching pending question exists.
 */
export async function answerQuestionAction(
    directory: string,
    change: string,
    questionId: string,
    selectedOptionId: string | undefined,
    otherText: string | undefined,
): Promise<RunState> {
    const state = await readRun(directory, change)
    answerQuestion(state, questionId, selectedOptionId, otherText)
    await writeArtifactIndex(directory, change, state)
    await writeRun(directory, change, state)
    await writeQuestionLedger(directory, change, state)
    return state
}

/**
 * Answer multiple pending questions in a single transaction.
 *
 * Preflight-validates the entire answer batch against the current pending
 * questions before applying any mutation, so a malformed or partial batch
 * leaves persisted state unchanged. The run stays paused until every
 * question in the batch is answered, at which point the resume target is
 * set and the run resumes.
 *
 * The batch must contain exactly one answer for each currently pending
 * question: no more, no fewer, no duplicates, and no answers for unknown or
 * already-answered questions. Each answer must supply exactly one of
 * `selectedOption` or `otherText`.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param answers - Array of question answers (questionId + one of option/otherText).
 * @returns The updated {@link RunState}.
 * @throws When the answer batch is empty, partial, duplicate, unknown,
 *     spans more than the active batch, or any individual answer fails
 *     validation. No state mutation is performed on failure.
 */
export async function answerQuestionsAction(
    directory: string,
    change: string,
    answers: Array<{ questionId: string; selectedOption?: string; otherText?: string }>,
): Promise<RunState> {
    const state = await readRun(directory, change)

    // Preflight: validate the whole batch against the current pending
    // questions before applying any answer so a rejected batch cannot leave
    // the run in a half-answered state.
    const pending = state.pendingQuestions
    if (!answers || answers.length === 0) {
        throw new Error("SpecOps answer batch must contain at least one answer")
    }
    if (!pending || pending.length === 0) {
        throw new Error("SpecOps answer batch received but no questions are pending")
    }
    if (answers.length !== pending.length) {
        throw new Error(
            `SpecOps answer batch must answer every pending question ` +
                `(expected ${pending.length}, received ${answers.length})`,
        )
    }
    const pendingIds = new Set(pending.map(q => q.id))
    const seenAnswerIds = new Set<string>()
    for (const answer of answers) {
        if (!answer.questionId || !answer.questionId.trim()) {
            throw new Error("SpecOps answer batch contains an empty question id")
        }
        if (!pendingIds.has(answer.questionId)) {
            throw new Error(
                `SpecOps answer batch references unknown or already-answered question: ${answer.questionId}`,
            )
        }
        if (seenAnswerIds.has(answer.questionId)) {
            throw new Error(
                `SpecOps answer batch contains a duplicate question id: ${answer.questionId}`,
            )
        }
        seenAnswerIds.add(answer.questionId)
        const hasOption = answer.selectedOption !== undefined
        const hasOther = answer.otherText !== undefined
        if (hasOption === hasOther) {
            throw new Error(
                `SpecOps answer for ${answer.questionId} must provide exactly one of selectedOption or otherText`,
            )
        }
    }
    // The batch answers every pending question exactly once; apply it.

    for (const answer of answers) {
        answerQuestion(state, answer.questionId, answer.selectedOption, answer.otherText)
    }
    await writeArtifactIndex(directory, change, state)
    await writeRun(directory, change, state)
    await writeQuestionLedger(directory, change, state)
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
    await writeQuestionLedger(directory, change, state)
    return state
}

/**
 * Resolve a pending checkpoint and resume scheduling.
 *
 * With no feedback (Continue or dismissal) the checkpoint is recorded as
 * `continued`/`dismissed`, the pause is cleared, and the run resumes. With
 * feedback text the checkpoint is recorded as `feedback`, the checkpoint
 * artifact group and its downstream closure are invalidated, and a resume
 * target is set so the next dispatch replays the phase with the feedback
 * injected as untrusted prompt content.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param feedback - User feedback text, or `undefined` for Continue/dismissal.
 * @param resolution - Explicit replay intent for feedback checkpoints.
 * @returns The updated {@link RunState}.
 * @throws When no checkpoint is pending or the feedback is invalid.
 */
export async function resumeCheckpointAction(
    directory: string,
    change: string,
    feedback: string | undefined,
    config: Pick<SpecOpsConfig, "review">,
    resolution: CheckpointResolution | undefined = undefined,
): Promise<RunState> {
    const state = await readRun(directory, change)
    const pending = state.pendingCheckpoint
    if (!pending) {
        throw new Error("SpecOps checkpoint is not pending")
    }

    // Refresh the implementation diff before validating the checkpoint binding
    // so an externally mutated worktree is detected before feedback is applied.
    await refreshImplementationBinding(directory, state, config.review.maxDiffBytes)

    const now = new Date().toISOString()
    const dispatch = state.dispatches.find(record => record.id === pending.dispatchId)
    if (!dispatch) {
        throw new Error("SpecOps checkpoint references an unknown dispatch")
    }

    // Validate the checkpoint binding before applying Continue or feedback.
    // If the authoritative inputs have changed (policy, diff, or artifact
    // hashes) the checkpoint is stale: record it and resume scheduling without
    // applying the user's feedback against invalidated outputs.
    if (!isCheckpointBindingCurrent(state, pending)) {
        state.checkpointHistory.push({
            dispatchId: pending.dispatchId,
            capability: pending.capability,
            purpose: pending.purpose,
            action: pending.action,
            artifacts: pending.artifacts,
            policyHash: pending.policyHash,
            implementationDiffHash: pending.implementationDiffHash,
            bindingHash: pending.bindingHash,
            raisedAt: pending.raisedAt,
            resolvedAt: now,
            outcome: "stale",
            feedback,
            feedbackHash: undefined,
            invalidatedArtifacts: [],
        })
        state.pendingCheckpoint = undefined
        state.status = "running"
        state.pauseReason = undefined
        state.resumable = undefined
        await writeArtifactIndex(directory, change, state)
        await writeRun(directory, change, state)
        return state
    }

    const outcome: CheckpointRecord["outcome"] = feedback === undefined ? "continued" : "feedback"
    if (resolution !== undefined && feedback === undefined) {
        throw new Error("SpecOps checkpoint resolution requires non-empty feedback")
    }
    if (resolution === "apply-implementation-fixes" && pending.capability !== "verification") {
        throw new Error(
            "SpecOps implementation fixes can only be selected from a verification checkpoint",
        )
    }
    let feedbackHash: string | undefined
    let invalidatedArtifacts: ArtifactId[] = []

    if (feedback !== undefined) {
        const trimmed = feedback.trim()
        if (!trimmed) {
            throw new Error("SpecOps checkpoint feedback must be non-empty")
        }
        feedbackHash = createHash("sha256")
            .update(
                JSON.stringify({
                    dispatchId: pending.dispatchId,
                    feedback,
                    bindingHash: pending.bindingHash,
                }),
            )
            .digest("hex")
        invalidatedArtifacts = invalidationForCheckpoint(pending.artifacts)
        invalidate(state, invalidatedArtifacts, "checkpoint feedback")
        state.resumeTarget = {
            sourceId: pending.dispatchId,
            originalDispatchId: pending.dispatchId,
            phase:
                resolution === "apply-implementation-fixes"
                    ? "implementation"
                    : (pending.artifacts[0]?.artifact ?? "proposal"),
            capability:
                resolution === "apply-implementation-fixes" ? "implementation" : pending.capability,
            purpose: "workflow",
            action: resolution === "apply-implementation-fixes" ? "implementation" : pending.action,
            answerHash: feedbackHash,
            origin: "checkpoint",
        }
    }

    const record: CheckpointRecord = {
        dispatchId: pending.dispatchId,
        capability: pending.capability,
        purpose: pending.purpose,
        action: pending.action,
        artifacts: pending.artifacts,
        policyHash: pending.policyHash,
        implementationDiffHash: pending.implementationDiffHash,
        bindingHash: pending.bindingHash,
        raisedAt: pending.raisedAt,
        resolvedAt: now,
        outcome,
        resolution: feedback === undefined ? undefined : (resolution ?? "rerun-phase"),
        feedback,
        feedbackHash,
        invalidatedArtifacts,
    }

    state.checkpointHistory.push(record)
    state.pendingCheckpoint = undefined
    state.status = "running"
    state.pauseReason = undefined
    state.resumable = undefined

    await writeArtifactIndex(directory, change, state)
    await writeRun(directory, change, state)
    await writeQuestionLedger(directory, change, state)
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
    state.pendingFrontier = undefined
    state.frontierResume = undefined
    for (const task of state.repairTasks ?? []) {
        if (task.status === "queued") task.status = "cancelled"
    }
    state.pendingRepair = undefined
    flushPendingQuestionOnCancel(state)
    // Flush any pending checkpoint into history as cancelled so the terminal
    // state is consistent and the pause reason is never left dangling.
    if (state.pendingCheckpoint) {
        const pending = state.pendingCheckpoint

        state.checkpointHistory.push({
            dispatchId: pending.dispatchId,
            capability: pending.capability,
            purpose: pending.purpose,
            action: pending.action,
            artifacts: pending.artifacts,
            policyHash: pending.policyHash,
            implementationDiffHash: pending.implementationDiffHash,
            bindingHash: pending.bindingHash,
            raisedAt: pending.raisedAt,
            resolvedAt: new Date().toISOString(),
            outcome: "cancelled",
            invalidatedArtifacts: [],
        })
        state.pendingCheckpoint = undefined
    }
    setOutcome(state, "cancelled", "cancelled", reason)
    await writeRun(directory, change, state)
    await writeQuestionLedger(directory, change, state)
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

    if (state.status === "paused" && (state.pendingQuestions || state.pendingCheckpoint)) {
        await writeRun(directory, change, state)
        return state
    }

    if (state.status !== "running") {
        return state
    }

    if (await refreshImplementationBinding(directory, state, config.review.maxDiffBytes)) {
        await writeArtifactIndex(directory, change, state)
        await writeRun(directory, change, state)
        return state
    }

    if (nextAction(state)) {
        throw new Error("SpecOps completion gates are not satisfied")
    }

    const unresolvedRepairs = (state.repairTasks ?? []).filter(
        task => task.status !== "verified" && task.status !== "superseded",
    )
    if (unresolvedRepairs.length > 0) {
        setOutcome(
            state,
            "failed",
            "validation-failed",
            `Repair tasks are not verified: ${unresolvedRepairs
                .map(task => `${task.id} (${task.status})`)
                .join(", ")}`,
        )
        await writeRun(directory, change, state)
        return state
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
        await openSpecOrThrow(directory, config, ["status", "--change", change, "--json"])
        if (state.scopeTier === "lean") {
            // Lean intentionally has no specification deltas, so the classic
            // change validator rejects a valid compact run. Validate its
            // custom artifact schema instead; controller gates above already
            // enforce the concrete change artifacts and command evidence.
            await openSpecOrThrow(directory, config, ["schema", "validate", "specops-lean"])
        } else {
            await openSpecOrThrow(directory, config, [
                "validate",
                change,
                "--type",
                "change",
                "--strict",
                "--no-interactive",
            ])
        }
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
        reviewSubmissions: state.reviewSubmissions,
        repairTasks: state.repairTasks,
        decisions: state.decisions,
        questionHistory: state.questionHistory,
        checkpointHistory: state.checkpointHistory,
        frontierUsage: state.frontierUsage,
        frontierHistory: state.frontierHistory,
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
    const registry = await readMachine<{ version: number; commands: CommandEvidence[] }>(
        directory,
        change,
        "specops-evidence.json",
        { version: 2, commands: [] },
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
                        evidence.exitCode === 0 &&
                        evidence.implementationDiffHash === state.implementationDiffHash &&
                        evidence.policyHash === state.requirements.policyHash,
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
    config: Pick<SpecOpsConfig, "review" | "frontier" | "routing" | "workflow">,
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
            if (action.mode === "task-refinement" || action.mode === "lean-plan") {
                await persistArtifact(
                    directory,
                    change,
                    state,
                    "tasks",
                    action.agent,
                    output,
                    action.purpose,
                )
                completePendingRepair(state)
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
            completePendingRepair(state)
            return
        case "implementation":
        case "repair":
            {
                const diff = await collectDiff(directory, config.review.maxDiffBytes)
                const changedPaths = await collectChangedPaths(directory)
                if (diff === "(no implementation diff)" || changedPaths.length === 0) {
                    throw new Error(
                        `${action.capability} worker completed without producing an implementation diff`,
                    )
                }
                state.implementationDiffHash = hash(diff)
            }
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
            applyActualDiffFloor(state, await collectChangedPaths(directory), config)
            completePendingRepair(state, state.implementationDiffHash)
            return
        case "verification":
            if (action.mode === "lean-assurance-bundle") {
                await saveLeanAssuranceBundle(directory, change, state, action, output, config)
                return
            }
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
            const dispatch = state.dispatches.find(item => item.id === action.id)
            if (!dispatch) throw new Error("judgment dispatch provenance is missing")
            if (judgment.verdict === "FAIL" && judgment.findings.length === 0) {
                const repairMode: RepairMode =
                    artifact === "correctness-judgment" ? "implementation-defect" : "spec-mismatch"
                await writeArtifact(directory, change, file, output)
                recordArtifact(state, artifact, action.agent, output, action.purpose)
                if (!queueReviewFrontier(state, dispatch, artifact, repairMode, judgment.summary)) {
                    scheduleRepairOrOutcome(state, repairMode, judgment.summary)
                }
                return
            }
            if (
                judgment.verdict === "FAIL" &&
                !judgment.findings.some(finding =>
                    config.review.blockingSeverities.includes(finding.severity),
                )
            ) {
                throw new Error("failed judgment requires a configured blocking finding")
            }
            await admitReviewSubmission(
                directory,
                change,
                state,
                dispatch,
                judgment.findings,
                config,
            )
            await writeArtifact(directory, change, file, output)
            recordArtifact(state, artifact, action.agent, output, action.purpose)
            return
        }
        case "refutation":
            await saveReviewLedger(directory, change, state, action, output, config)
            return
        case "frontier":
            {
                const response = parseFrontierResponse(output)
                const registry = await readMachine<{
                    version: number
                    commands: CommandEvidence[]
                }>(directory, change, "specops-evidence.json", { version: 2, commands: [] })
                if (
                    !(await verifyFrontierEvidence(directory, response.evidence, registry.commands))
                ) {
                    throw new Error("frontier response evidence could not be verified")
                }
                applyFrontierResponse(state, response, output)
            }
            return
        default:
            if (action.purpose === "independent-review") {
                const dispatch = state.dispatches.find(item => item.id === action.id)
                if (!dispatch) throw new Error("review dispatch provenance is missing")
                await admitReviewSubmission(
                    directory,
                    change,
                    state,
                    dispatch,
                    parseReviewSubmission(output),
                    config,
                )
            }
            // Consultation prose remains captured in dispatch provenance only.
            return
    }
}

/** Reject silent or status-only worker results before they become evidence. */
function assertWorkerResult(
    action: WorkflowAction,
    parsed: { prose: string; questions?: unknown[]; escalation?: unknown; frontier?: unknown },
): void {
    if (parsed.questions?.length || parsed.escalation || parsed.frontier) return
    if (parsed.prose.trim()) return
    throw new Error(
        `SpecOps ${action.capability} worker returned empty output; return the required artifact or structured result`,
    )
}

/**
 * Validate and persist the consolidated assurance response used by Lean runs.
 *
 * All three members are parsed before any file is written. A correctness
 * failure takes precedence over a ledger finding so only one bounded repair or
 * frontier adjudication is queued for a bundle.
 *
 * @param directory - Repository root directory.
 * @param change - OpenSpec change id.
 * @param state - Mutable run state.
 * @param action - Issued Lean verification action.
 * @param output - Strict assurance bundle JSON.
 * @param config - Review and frontier policy.
 */
async function saveLeanAssuranceBundle(
    directory: string,
    change: string,
    state: RunState,
    action: WorkflowAction,
    output: string,
    config: Pick<SpecOpsConfig, "review" | "frontier">,
): Promise<void> {
    const bundle = parseObject(output, "Lean assurance bundle")
    const verification = requireString(bundle.verification, "Lean assurance verification")
    const judgmentOutput = requireSerializedObject(
        bundle.correctnessJudgment,
        "Lean assurance correctnessJudgment",
    )
    const ledgerOutput = requireSerializedObject(bundle.reviewLedger, "Lean assurance reviewLedger")
    const judgment = parseJudgment(judgmentOutput)
    const leanFindings = parseLeanReviewLedger(ledgerOutput)
    const dispatch = state.dispatches.find(item => item.id === action.id)
    if (!dispatch) throw new Error("Lean assurance dispatch provenance is missing")
    const submission = createReviewSubmission(state, dispatch, [
        ...judgment.findings,
        ...leanFindings,
    ])
    const hasBlockingFinding = submission.findings.some(finding =>
        config.review.blockingSeverities.includes(finding.severity),
    )
    if (judgment.verdict === "FAIL" && submission.findings.length > 0 && !hasBlockingFinding) {
        throw new Error("failed Lean judgment requires a configured blocking finding")
    }
    await verifySubmissionEvidence(directory, change, state, submission.findings, config)

    state.reviewSubmissions.push(submission)
    const ledger = leanLedgerFromSubmission(submission)
    const normalizedLedgerOutput = JSON.stringify(ledger)
    reconcileRepairTasks(state, ledger, config)

    await persistArtifact(
        directory,
        change,
        state,
        "verification",
        action.agent,
        verification,
        action.purpose,
    )
    await writeArtifact(directory, change, "judgment-correctness.json", judgmentOutput)
    recordArtifact(state, "correctness-judgment", action.agent, judgmentOutput, action.purpose)
    await persistArtifact(
        directory,
        change,
        state,
        "review-ledger",
        action.agent,
        normalizedLedgerOutput,
        action.purpose,
    )

    const finding = ledger.findings.find(item =>
        config.review.blockingSeverities.includes(item.severity),
    )
    if (!finding) {
        if (judgment.verdict === "FAIL") {
            const mode: RepairMode = "implementation-defect"
            if (
                !queueReviewFrontier(
                    state,
                    dispatch,
                    "correctness-judgment",
                    mode,
                    judgment.summary,
                )
            ) {
                scheduleRepairOrOutcome(state, mode, judgment.summary)
            }
        }
        return
    }
    const mode = finding.mode ?? "review-finding"
    if (
        !dispatch ||
        !queueReviewFrontier(state, dispatch, "review-ledger", mode, finding.summary)
    ) {
        scheduleLedgerRepairOrOutcome(state, ledger, normalizedLedgerOutput, config)
    }
}

/**
 * Verify and retain one normalized assurance submission.
 *
 * Blocking findings require repository-grounded evidence and repairable
 * findings require acceptance criteria. The aggregate current submission
 * payload is bounded before it can become refuter input.
 */
async function admitReviewSubmission(
    directory: string,
    change: string,
    state: RunState,
    dispatch: DispatchRecord,
    findings: AssuranceFinding[],
    config: Pick<SpecOpsConfig, "review">,
): Promise<void> {
    const submission = createReviewSubmission(state, dispatch, findings)
    await verifySubmissionEvidence(directory, change, state, submission.findings, config)
    const projected = [...currentReviewSubmissions(state), submission]
    if (Buffer.byteLength(JSON.stringify(projected)) > config.review.maxContextBytes) {
        throw new Error("current review submissions exceed review.maxContextBytes")
    }

    state.reviewSubmissions.push(submission)
}

/** Verify evidence and acceptance criteria for controller-admitted findings. */
async function verifySubmissionEvidence(
    directory: string,
    change: string,
    state: RunState,
    findings: AssuranceFinding[],
    config: Pick<SpecOpsConfig, "review">,
): Promise<void> {
    const registry = await readMachine<{ version: number; commands: CommandEvidence[] }>(
        directory,
        change,
        "specops-evidence.json",
        { version: 2, commands: [] },
    )
    const changedPaths = findings.some(finding =>
        finding.evidence.some(reference => reference.kind === "changed-path"),
    )
        ? new Set(await collectChangedPaths(directory))
        : new Set<string>()
    for (const finding of findings) {
        const blocking = config.review.blockingSeverities.includes(finding.severity)
        if (blocking && finding.evidence.length === 0) {
            throw new Error("blocking assurance finding requires evidence")
        }
        if (blocking && finding.mode && finding.acceptanceCriteria.length === 0) {
            throw new Error("repairable blocking finding requires acceptance criteria")
        }
        if (
            blocking &&
            !finding.evidence.some(reference =>
                [
                    "changed-path",
                    "repository-path",
                    "symbol",
                    "command",
                    "test-failure",
                    "contract",
                ].includes(reference.kind),
            )
        ) {
            throw new Error("blocking assurance finding requires verifiable evidence")
        }
        if (
            finding.evidence.some(
                reference => reference.kind === "changed-path" && !changedPaths.has(reference.path),
            )
        ) {
            throw new Error("assurance finding changed-path evidence is not in the current diff")
        }
        if (
            !(await verifyFrontierEvidence(directory, finding.evidence, registry.commands)) ||
            finding.evidence.some(reference => {
                if (reference.kind !== "command" && reference.kind !== "test-failure") return false
                const command = registry.commands.find(item => item.id === reference.commandId)
                return (
                    !command ||
                    command.implementationDiffHash !== state.implementationDiffHash ||
                    command.policyHash !== state.requirements.policyHash
                )
            })
        ) {
            throw new Error("assurance finding evidence could not be verified for current inputs")
        }
    }
}

/**
 * Reject writer completion when Git history or controller-owned artifacts changed.
 *
 * This guard is an integrity check, not an automatic recovery mechanism. It
 * intentionally leaves the unexpected worktree state available for diagnosis.
 */
async function assertWriterGuards(
    directory: string,
    change: string,
    state: RunState,
    dispatch: DispatchRecord,
): Promise<void> {
    if (!dispatch.writerGuard) return
    if (dispatch.writerGuard.baseline !== state.baseline) {
        throw new Error("Writer guard found modified run baseline")
    }
    if (/^[0-9a-f]{40}$/i.test(dispatch.writerGuard.baseline)) {
        const head = await baseCommit(directory)
        if (head !== dispatch.writerGuard.baseline) {
            throw new Error("Writer guard rejected a changed Git HEAD")
        }
    }
    if (
        dispatch.writerGuard.stashFingerprint !== undefined &&
        (await stashFingerprint(directory)) !== dispatch.writerGuard.stashFingerprint
    ) {
        throw new Error(
            "Writer guard detected a changed Git stash list; workers must not stash changes",
        )
    }

    const currentArtifacts = await protectedControllerTree(directory, change)
    const expectedFiles = Object.keys(dispatch.writerGuard.artifacts).sort()
    const currentFiles = Object.keys(currentArtifacts).sort()
    if (JSON.stringify(currentFiles) !== JSON.stringify(expectedFiles)) {
        throw new Error("Writer guard found a changed controller artifact tree")
    }
    for (const [file, expectedHash] of Object.entries(dispatch.writerGuard.artifacts)) {
        if (currentArtifacts[file] !== expectedHash) {
            throw new Error(`Writer guard found modified controller artifact: ${file}`)
        }
    }
}

/** Capture controller-owned artifact hashes when a writer dispatch is issued. */
async function captureWriterGuard(
    directory: string,
    change: string,
    state: RunState,
): Promise<NonNullable<DispatchRecord["writerGuard"]>> {
    const artifacts = await protectedControllerTree(directory, change)
    for (const [artifact, file] of Object.entries(ARTIFACT_FILES) as Array<[ArtifactId, string]>) {
        if (artifact === "implementation" || state.artifacts[artifact]?.validity !== "valid") {
            continue
        }
        if (!(file in artifacts) && /^[0-9a-f]{40}$/i.test(state.baseline)) {
            throw new Error(`Writer guard cannot issue with missing controller artifact: ${file}`)
        }
    }
    if (state.artifacts.specs?.validity === "valid") {
        const specifications = Object.keys(artifacts).filter(
            relative => relative.startsWith("specs/") && relative.endsWith("/spec.md"),
        )
        if (specifications.length === 0 && /^[0-9a-f]{40}$/i.test(state.baseline)) {
            throw new Error("Writer guard cannot issue with missing controller specifications")
        }
    }
    return {
        baseline: state.baseline,
        artifacts,
        stashFingerprint: /^[0-9a-f]{40}$/i.test(state.baseline)
            ? await stashFingerprint(directory)
            : undefined,
    }
}

/**
 * Hash the complete immutable portion of one controller-owned change tree.
 *
 * Run, progress, and evidence records are excluded because controller tools may
 * legitimately update them while a writer dispatch is active. Every other file
 * and directory is protected, including unknown additions and symbolic links.
 */
async function protectedControllerTree(
    directory: string,
    change: string,
): Promise<Record<string, string>> {
    const root = changeRoot(directory, change)
    const excluded = new Set(["specops-run.json", "specops-progress.json", "specops-evidence.json"])
    const entries: Record<string, string> = {}

    async function visit(current: string): Promise<void> {
        for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) =>
            left.name.localeCompare(right.name),
        )) {
            const absolute = path.join(current, entry.name)
            const relative = path.relative(root, absolute).split(path.sep).join("/")
            if (excluded.has(relative)) continue
            if (entry.isSymbolicLink()) {
                throw new Error(
                    `Writer guard rejected symbolic link in controller tree: ${relative}`,
                )
            }
            if (entry.isDirectory()) {
                entries[`${relative}/`] = hash("directory")
                await visit(absolute)
                continue
            }
            if (!entry.isFile()) {
                throw new Error(
                    `Writer guard rejected special file in controller tree: ${relative}`,
                )
            }
            entries[relative] = hash((await readFile(absolute, "utf8")).trim())
        }
    }

    await visit(root)
    return entries
}

/**
 * Serialize a required JSON object field from a compound worker response.
 *
 * @param value - Candidate bundle member.
 * @param label - Human-readable validation label.
 * @returns Stable JSON text for existing artifact parsers.
 */
function requireSerializedObject(value: unknown, label: string): string {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`)
    }
    return JSON.stringify(value)
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
    completePendingRepair(state)
}

/** Mark the active repair task from controller-observed output and clear it. */
function completePendingRepair(state: RunState, afterDiffHash?: string): void {
    const pending = state.pendingRepair
    if (!pending) return
    const task = state.repairTasks?.find(item => item.id === pending.taskId)
    if (task) {
        task.afterDiffHash = afterDiffHash
        const unchanged =
            task.target === "implementation" &&
            task.beforeDiffHash !== undefined &&
            task.beforeDiffHash === afterDiffHash
        task.status = unchanged ? "failed" : "completed"
        if (unchanged) {
            setOutcome(
                state,
                "failed",
                "validation-failed",
                `Repair task ${task.id} produced no implementation diff change.`,
            )
        }
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
    config: Pick<SpecOpsConfig, "review" | "frontier">,
): Promise<void> {
    const submissions = currentReviewSubmissions(state)
    const sourceFindingIds = submissions.flatMap(submission =>
        submission.findings.map(finding => finding.id),
    )
    const ledger = parseReviewLedger(output, sourceFindingIds)
    await verifySubmissionEvidence(directory, change, state, ledger.findings, config)
    const normalizedOutput = JSON.stringify(ledger)
    reconcileRepairTasks(state, ledger, config)
    await persistArtifact(
        directory,
        change,
        state,
        "review-ledger",
        action.agent,
        normalizedOutput,
        action.purpose,
    )
    const finding = ledger.findings.find(item =>
        config.review.blockingSeverities.includes(item.severity),
    )
    if (!finding) {
        return
    }
    if (!finding.mode) {
        const dispatch = state.dispatches.find(item => item.id === action.id)
        if (
            !dispatch ||
            !queueReviewFrontier(
                state,
                dispatch,
                "review-ledger",
                "review-finding",
                finding.summary,
            )
        ) {
            setOutcome(state, "failed", "review-failed", finding.summary)
        }
        return
    }
    const dispatch = state.dispatches.find(item => item.id === action.id)
    if (
        !dispatch ||
        !queueReviewFrontier(state, dispatch, "review-ledger", finding.mode, finding.summary)
    ) {
        scheduleLedgerRepairOrOutcome(state, ledger, normalizedOutput, config)
    }
}

/**
 * Apply one validated frontier response to its pending escalation episode.
 *
 * @param state - Mutable run state.
 * @param response - Strict frontier response.
 * @param output - Raw response used for provenance hashing.
 */
function applyFrontierResponse(state: RunState, response: FrontierResponse, output: string): void {
    const pending = state.pendingFrontier
    if (!pending) {
        throw new Error("frontier response has no pending request")
    }
    const episode = completeFrontierEpisode(state, response, output)

    if (response.disposition === "PROMOTE") {
        if (!canPromotePending(state)) {
            throw new Error("frontier promotion is not permitted by policy or budget")
        }
        pending.selectedTier = "high"
        pending.request.tier = "high"
        episode.selectedTier = "high"
        return
    }

    if (response.disposition === "UPHOLD_BLOCKER" && pending.reviewFailure) {
        scheduleRepairOrOutcome(
            state,
            response.repairMode ?? pending.reviewFailure.mode,
            response.summary,
            response.instruction,
        )
        state.pendingFrontier = undefined
        return
    }

    if (pending.reviewFailure && response.disposition !== "DISMISS_BLOCKER") {
        scheduleRepairOrOutcome(
            state,
            pending.reviewFailure.mode,
            pending.reviewFailure.summary,
            response.instruction,
        )
        state.pendingFrontier = undefined
        return
    }

    if (response.disposition !== "DISMISS_BLOCKER" && !pending.reviewFailure) {
        const advice = response.instruction?.trim() || response.summary
        state.frontierResume = {
            episodeId: pending.episodeId,
            originalDispatchId: pending.originalDispatchId,
            phase: pending.phase,
            capability: pending.capability,
            purpose: pending.purpose,
            action: pending.action,
            advice,
            adviceHash: hash(advice),
        }
    }
    state.pendingFrontier = undefined
}

/**
 * Resume safely after an unavailable or malformed frontier response.
 *
 * @param state - Mutable run state.
 * @param reason - Frontier failure description.
 */
function fallbackFromFrontierFailure(state: RunState, reason: string): void {
    const pending = state.pendingFrontier
    if (!pending) return
    const episode = state.frontierHistory?.find(item => item.id === pending.episodeId)
    if (episode) episode.status = "insufficient"
    if (pending.reviewFailure) {
        scheduleRepairOrOutcome(state, pending.reviewFailure.mode, pending.reviewFailure.summary)
    } else {
        const advice =
            `Frontier escalation was unavailable (${reason}). Complete the original task using ` +
            "the safest repository-grounded approach and do not request the same escalation again."
        state.frontierResume = {
            episodeId: pending.episodeId,
            originalDispatchId: pending.originalDispatchId,
            phase: pending.phase,
            capability: pending.capability,
            purpose: pending.purpose,
            action: pending.action,
            advice,
            adviceHash: hash(advice),
        }
    }
    state.pendingFrontier = undefined
}

/**
 * Schedule one bounded repair or stop safely when policy disallows another cycle.
 *
 * @param state - The current run state (mutated in place).
 * @param mode - The repair mode.
 * @param summary - Human-readable summary of the finding that triggered the repair.
 */
function scheduleRepairOrOutcome(
    state: RunState,
    mode: RepairMode,
    summary: string,
    instruction?: string,
): void {
    const syntheticLedger: ReviewLedger = {
        findings: [
            {
                id: stableId("synthetic-finding", mode, summary),
                sourceFindingIds: [],
                severity: "HIGH",
                mode,
                summary,
                evidence: [],
                acceptanceCriteria: instruction ? [instruction] : [],
            },
        ],
        dismissed: [],
    }
    scheduleLedgerRepairOrOutcome(
        state,
        syntheticLedger,
        JSON.stringify(syntheticLedger),
        {
            review: {
                blockingSeverities: ["BLOCKER", "HIGH"],
            },
        },
        instruction,
    )
}

/**
 * Select one compatible repair target from a sustained ledger and queue it.
 *
 * Upstream specification work precedes design, which precedes code/test
 * mutation. A new ledger is required before a later target group may run.
 */
function scheduleLedgerRepairOrOutcome(
    state: RunState,
    ledger: ReviewLedger,
    serializedLedger: string,
    config: {
        review: Pick<SpecOpsConfig["review"], "blockingSeverities">
    },
    instruction?: string,
): void {
    const blocking = ledger.findings.filter(finding =>
        config.review.blockingSeverities.includes(finding.severity),
    )
    if (blocking.length === 0) return
    const unrepairable = blocking.find(finding => !finding.mode)
    if (unrepairable) {
        setOutcome(state, "failed", "review-failed", unrepairable.summary)
        return
    }

    const used = state.budgetUsage.maxRepairCycles ?? 0
    if (used >= state.requirements.budgets.maxRepairCycles) {
        setOutcome(
            state,
            "blocked",
            "policy-blocked",
            `Repair budget exhausted with unresolved finding: ${blocking[0]!.summary}`,
            "budget-exhausted",
        )
        return
    }

    const priority = ["planning", "design", "implementation"] as const
    const target = priority.find(candidate =>
        blocking.some(finding => repairTargetForMode(finding.mode!) === candidate),
    )!
    const severityRank = { BLOCKER: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const
    const selected = blocking
        .filter(finding => repairTargetForMode(finding.mode!) === target)
        .sort(
            (left, right) =>
                severityRank[left.severity] - severityRank[right.severity] ||
                left.id.localeCompare(right.id),
        )
    const modes = [...new Set(selected.map(finding => finding.mode!))]
    const summary = selected.map(finding => finding.summary).join("\n")
    const fingerprint = repairGroupFingerprint(target, selected)
    const priorAttempts = (state.repairTasks ?? []).filter(
        task => task.fingerprint === fingerprint,
    ).length
    if (priorAttempts >= state.requirements.budgets.maxRepeatedFailureFingerprints) {
        setOutcome(
            state,
            "blocked",
            "policy-blocked",
            `Repeated repair finding exceeded its budget: ${summary}`,
            "budget-exhausted",
        )
        return
    }
    const now = new Date().toISOString()
    const task: RepairTask = {
        id: stableId("repair-task-instance", fingerprint, priorAttempts + 1, now),
        target,
        modes,
        findingIds: selected.map(finding => finding.id),
        findingFingerprints: selected.map(findingFingerprint),
        summary,
        evidence: selected.flatMap(finding => finding.evidence),
        acceptanceCriteria: [...new Set(selected.flatMap(finding => finding.acceptanceCriteria))],
        sourceLedgerHash: hash(serializedLedger),
        sourceDiffHash: state.implementationDiffHash,
        fingerprint,
        attempt: priorAttempts + 1,
        status: "queued",
        beforeDiffHash: state.implementationDiffHash,
        at: now,
    }

    state.repairTasks.push(task)
    state.pendingRepair = {
        mode: modes[0]!,
        summary,
        instruction,
        taskId: task.id,
        findingIds: task.findingIds,
        evidence: task.evidence,
        acceptanceCriteria: task.acceptanceCriteria,
        sourceLedgerHash: task.sourceLedgerHash,
    }
    state.repairs.push({ mode: modes[0]!, summary, at: now })
    state.budgetUsage.maxRepairCycles = used + 1
    const root: ArtifactId =
        target === "planning"
            ? "proposal"
            : target === "design"
              ? state.scopeTier === "full"
                  ? "design"
                  : "proposal"
              : "implementation"
    invalidate(state, [root], `blocking review finding: ${summary}`)
}

/** Mark completed tasks verified only after fresh assurance no longer sustains their group. */
function reconcileRepairTasks(
    state: RunState,
    ledger: ReviewLedger,
    config: { review: Pick<SpecOpsConfig["review"], "blockingSeverities"> },
): void {
    const currentFingerprints = new Set<string>()
    const currentFindingFingerprints = new Set<string>()
    for (const target of ["planning", "design", "implementation"] as const) {
        const findings = ledger.findings
            .filter(
                finding =>
                    config.review.blockingSeverities.includes(finding.severity) &&
                    finding.mode &&
                    repairTargetForMode(finding.mode) === target,
            )
            .sort((left, right) => left.id.localeCompare(right.id))
        if (findings.length) {
            currentFingerprints.add(repairGroupFingerprint(target, findings))
            for (const finding of findings) {
                currentFindingFingerprints.add(findingFingerprint(finding))
            }
        }
    }
    for (const task of state.repairTasks ?? []) {
        const remainsSustained =
            task.findingFingerprints?.some(fingerprint =>
                currentFindingFingerprints.has(fingerprint),
            ) ?? currentFingerprints.has(task.fingerprint)
        if (task.status === "completed" && !remainsSustained) {
            task.status = "verified"
        }
    }
}

/**
 * Rebind a valid implementation artifact to the current repository diff.
 *
 * Any change observed outside implementation/repair completion invalidates the
 * implementation and all downstream assurance rather than silently reviewing
 * or finalizing a different worktree.
 */
async function refreshImplementationBinding(
    directory: string,
    state: RunState,
    maxDiffBytes: number,
): Promise<boolean> {
    if (state.status !== "running" || state.artifacts.implementation?.validity !== "valid") {
        return false
    }
    // Repository diff collection requires a real git commit baseline; skip
    // the refresh for synthetic test baselines where no git context exists.
    if (!/^[0-9a-f]{40}$/i.test(state.baseline)) return false
    const current = hash(await collectDiff(directory, maxDiffBytes))
    const previous = state.implementationDiffHash
    state.implementationDiffHash = current
    if (previous === undefined || previous === current) return false
    invalidate(state, ["implementation"], "implementation diff changed outside writer completion")
    return true
}

/** Build the semantic repeated-repair fingerprint for one target group. */
function repairGroupFingerprint(
    target: RepairTask["target"],
    findings: ReviewLedger["findings"],
): string {
    return stableId("repair-task", target, findings.map(findingFingerprint).sort())
}

/** Build a semantic finding identity that survives fresh dispatch/source ids. */
function findingFingerprint(finding: ReviewLedger["findings"][number]): string {
    return stableId(
        "repair-finding",
        finding.mode ?? "",
        finding.summary.trim().toLowerCase(),
        [...finding.evidence].sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
        ),
    )
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
function applyClaim(
    state: RunState,
    claim: EscalationClaim | undefined,
    config: Pick<SpecOpsConfig, "routing">,
): void {
    if (!claim) {
        return
    }

    const decision = decideEscalation(state, claim, config)
    state.decisions.push(decision)
    if (decision.disposition === "accepted" || decision.disposition === "narrowed") {
        applyEscalation(state, decision.appliedPatch)
        const invalidationRoots = decision.appliedPatch.invalidate ?? []
        if (invalidationRoots.length) {
            invalidate(
                state,
                [...new Set(invalidationRoots)],
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
 * Upgrade a run when the actual implementation diff exceeds its current size floor.
 *
 * Files are counted directly. Modules are unique top-level directories, with
 * repository-root files grouped under `"."`. Full thresholds take precedence
 * over the Standard overflow threshold.
 *
 * @param state - Mutable run state.
 * @param paths - Changed non-OpenSpec repository paths.
 * @param config - Workflow thresholds and routing floors.
 */
function applyActualDiffFloor(
    state: RunState,
    paths: string[],
    config: Pick<SpecOpsConfig, "workflow" | "routing">,
): void {
    if (state.scopeTier === "full" || paths.length === 0) return
    const modules = new Set(
        paths.map(changedPath => {
            const segments = changedPath.split("/").filter(Boolean)
            return segments.length > 1 ? segments[0] : "."
        }),
    ).size
    const target = scopeForActualDiff(state.scopeTier, paths, config.workflow.scopeThresholds)
    if (target === state.scopeTier) return

    applyClaim(
        state,
        {
            category: "scope-overflow",
            confidence: "high",
            summary: `Actual diff spans ${paths.length} files across ${modules} modules.`,
            evidence: paths.map(changedPath => ({ kind: "changed-path", path: changedPath })),
            boundaryCrossed: `${state.scopeTier} implementation size floor`,
            whyCurrentRequirementsAreInsufficient:
                "The actual implementation is larger than the routed workflow permits.",
            requestedPatch: {
                raiseScopeTier: target,
            },
        },
        config,
    )
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
    if (action.capability === "frontier") {
        return "review-ledger"
    }
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
            return action.mode === "task-refinement" || action.mode === "lean-plan"
                ? "tasks"
                : "proposal"
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
        outputHash: hash(content.trim()),
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
    const questionHashes = state.questionHistory
        .filter(record => record.outcome === "answered" && record.answerHash)
        .map(record => [record.id, record.answerHash] as [string, string])
    const checkpointHashes = state.checkpointHistory
        .filter(record => record.outcome === "feedback" && record.feedbackHash)
        .map(record => [record.dispatchId, record.feedbackHash] as [string, string])
    const result: Record<string, string> = {}
    for (const [k, v] of [...questionHashes, ...checkpointHashes]) {
        result[k] = v
    }
    return result
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
 * Render the assessor's repository inspection into the Lean exploration artifact.
 *
 * This deterministic projection avoids a second inspection call while keeping
 * the existing OpenSpec Lean evidence artifact and provenance.
 *
 * @param state - Newly routed Lean run state.
 * @returns Evidence-backed exploration Markdown.
 */
function assessmentExplorationMarkdown(state: RunState): string {
    const assessment = state.assessment
    const section = (title: string, values: string[]): string[] => [
        `## ${title}`,
        "",
        ...(values.length ? values.map(value => `- ${value}`) : ["- None."]),
        "",
    ]
    return [
        "# Exploration",
        "",
        ...section("Facts", assessment.facts),
        ...section("Inferences", assessment.inferences),
        ...section("Inspected paths", assessment.inspectedPaths),
        ...section("Risk facets", assessment.riskFacets),
        ...section("Unresolved questions", assessment.unresolvedQuestions),
        ...section(
            "Likely validations",
            assessment.likelyValidations.map(
                validation =>
                    `${validation.executable} ${validation.args.join(" ")} — ${validation.purpose}`,
            ),
        ),
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
 * Each spec name must match {@link SPEC_NAME_REGEX} (it becomes the
 * `specs/<name>/spec.md` directory) and each value must be a non-empty string
 * following the normative spec template enforced by {@link validateSpecContent}.
 *
 * @param value - The raw value from the planning bundle JSON.
 * @returns A record of spec names to validated spec markdown bodies.
 * @throws When the value is not an object, is an array, contains invalid spec
 *   names, has empty content, fails normative structure validation, or is empty.
 */
function parseSpecs(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(
            "planning bundle specs must be a JSON object mapping spec names to markdown strings, not an array",
        )
    }

    const specs: Record<string, string> = {}
    for (const [name, content] of Object.entries(value as Record<string, unknown>)) {
        if (!SPEC_NAME_REGEX.test(name)) {
            throw new Error(
                `planning bundle spec name "${name}" must match ^[a-z0-9][a-z0-9-]*$ (lowercase alphanumeric and hyphens)`,
            )
        }
        if (typeof content !== "string" || !content.trim()) {
            throw new Error(`planning bundle spec "${name}" content must be a non-empty string`)
        }
        const structureError = validateSpecContent(content, name)
        if (structureError) {
            throw new Error(`planning bundle ${structureError}`)
        }
        specs[name] = content.trim()
    }
    if (!Object.keys(specs).length) {
        throw new Error("planning bundle must contain at least one spec")
    }
    return specs
}

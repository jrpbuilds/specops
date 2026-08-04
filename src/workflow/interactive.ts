import { readRun, withRunLock, writeRun } from "../state/store.js"
import type { RunState } from "../types.js"
import { writeArtifactIndex } from "./artifacts.js"
import {
    answerQuestion,
    dismissQuestion,
    flushPendingQuestionOnCancel,
    writeQuestionLedger,
} from "./questions.js"
import { isActive, setOutcome } from "./run-state.js"

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
    return withRunLock(directory, change, "answer question", () =>
        answerQuestionActionLocked(directory, change, questionId, selectedOptionId, otherText),
    )
}

/** Answer a question after the caller has acquired the run mutation lock. */
async function answerQuestionActionLocked(
    directory: string,
    change: string,
    questionId: string,
    selectedOption?: string,
    otherText?: string,
): Promise<RunState> {
    const state = await readRun(directory, change)
    answerQuestion(state, questionId, selectedOption, otherText)
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
    return withRunLock(directory, change, "answer questions", () =>
        answerQuestionsActionLocked(directory, change, answers),
    )
}

/** Answer a question batch after the caller has acquired the run mutation lock. */
async function answerQuestionsActionLocked(
    directory: string,
    change: string,
    answers: Array<{
        questionId: string
        selectedOption?: string
        otherText?: string
    }>,
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
    return withRunLock(directory, change, "dismiss question", () =>
        dismissQuestionActionLocked(directory, change, questionId),
    )
}

/** Dismiss a question after the caller has acquired the run mutation lock. */
async function dismissQuestionActionLocked(
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
    return withRunLock(directory, change, "cancel run", () =>
        cancelRunLocked(directory, change, reason),
    )
}

/** Cancel a run after the caller has acquired the run mutation lock. */
async function cancelRunLocked(
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

/**
 * Canonical deterministic-protocol tool IDs.
 *
 * Command templates and plugin registration consume these values so a tool
 * rename cannot leave a public command pointing at a missing implementation.
 *
 * Each property maps a logical operation to the OpenCode tool id that callers
 * must reference verbatim.
 */
export const TOOL_IDS = {
    /** Create a final-format deterministic run from a strict assessment. */
    startRun: "specops_start_run",
    /** Return the next controller directive (dispatch, ask-question, checkpoint, block, finalize). */
    nextAction: "specops_next_action",
    /** Validate and persist an issued deterministic worker result. */
    completeAction: "specops_complete_action",
    /** Record an answer to a worker-raised pending question. */
    answerQuestion: "specops_answer_question",
    /** Record that the user dismissed the native question UI without answering. */
    dismissQuestion: "specops_dismiss_question",
    /** Resolve a pending checkpoint and resume scheduling. */
    resumeCheckpoint: "specops_resume_checkpoint",
    /** Read bounded, scheduler-safe run context and persisted artifacts. */
    requestContext: "specops_request_context",
    /** Execute a registered arbitrary validation command without a shell. */
    runValidation: "specops_run_validation",
    /** Read final-format deterministic run state. */
    getStatus: "specops_get_status",
    /** Persist a safe cancellation outcome for an active run. */
    cancelRun: "specops_cancel_run",
    /** Finalize a run only when deterministic completion gates are satisfied. */
    finalize: "specops_finalize",
    /** Install final SpecOps OpenSpec assets. */
    onboard: "specops_onboard",
    /** Diagnose final SpecOps configuration and assets. */
    doctor: "specops_doctor",
    /** Run a read-only OpenSpec command. */
    openSpec: "specops_openspec",
} as const

/** Union of every canonical tool id. */
export type ToolId = (typeof TOOL_IDS)[keyof typeof TOOL_IDS]

/**
 * Complete exact-set catalogue used by integration drift checks.
 *
 * Computed from {@link TOOL_IDS} so adding a tool id is the only edit needed
 * to keep drift tests in sync.
 */
export const ALL_TOOL_IDS: readonly ToolId[] = Object.values(TOOL_IDS)

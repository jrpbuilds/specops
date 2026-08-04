/**
 * Final-format deterministic workflow engine facade.
 *
 * Drives a change from clean start to terminal outcome via a strict sequence
 * of scheduler-selected dispatches, controller-owned artifact persistence,
 * escalation adjudication, and completion gates. The controller is the only
 * component allowed to mutate planning, design, and review artifacts.
 *
 * This module re-exports the public workflow actions composed from focused
 * sub-modules.
 */

export { archiveCompletedRun } from "./archive.js"
export { startRun } from "./run-start.js"
export { issueDirective, recoverDispatch } from "./directive.js"
export { finalizeRun } from "./finalization.js"
export { completeAction, resumeCheckpointAction } from "./completion.js"
export {
    answerQuestionAction,
    answerQuestionsAction,
    cancelRun,
    dismissQuestionAction,
} from "./interactive.js"

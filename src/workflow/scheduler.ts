import { createHash, randomUUID } from "node:crypto"
import { agentForCapability } from "../capabilities/registry.js"
import type {
    ArtifactId,
    BlockReason,
    CapabilityId,
    PauseReason,
    PendingQuestion,
    ResumeTarget,
    RunState,
} from "../types.js"
import type { WorkflowAction } from "./actions.js"
import { getResumeTarget, resumePromptForAnswer } from "./questions.js"

/**
 * Capability ids that map to risk-facet specialists consulted during planning
 * and re-dispatched for independent post-implementation review.
 */
const SPECIALIST_CAPABILITIES = new Set<CapabilityId>([
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
])

/**
 * Explicit directive returned by the canonical progression tool.
 *
 * Controllers follow this directive instead of inspecting arbitrary run state.
 */
export type ControllerDirective =
    | { type: "dispatch"; action: WorkflowAction }
    | { type: "ask-question"; question: PendingQuestion; bindingHash: string }
    | {
          type: "block"
          reason: BlockReason | PauseReason
          resumable: boolean
          question?: PendingQuestion
      }
    | { type: "finalize" }

/**
 * Return whether a persisted artifact is still usable by the scheduler.
 *
 * @param state - The current run state.
 * @param artifact - The artifact id to test.
 * @returns `true` when the artifact is recorded with `validity === "valid"`.
 */
const isComplete = (state: RunState, artifact: ArtifactId): boolean =>
    state.artifacts[artifact]?.validity === "valid"

/**
 * Select the one and only action that can advance the current run.
 *
 * This is shared by interactive and automatic execution. Focused
 * commands may query it, but never dispatch workers outside this gate.
 *
 * Returns `undefined` while a question is pending or when the run is not in
 * `running` status.
 *
 * @param state - The current run state with persisted artifacts and dispatches.
 * @param resumeTarget - Optional resume target to override "already completed"
 *   suppression for consultation and independent-review dispatches.
 * @returns The next {@link WorkflowAction} to issue, or `undefined` when the
 *   run has no pending work.
 */
export function nextAction(
    state: RunState,
    resumeTarget?: ResumeTarget,
): WorkflowAction | undefined {
    if (state.status !== "running" || state.pendingQuestion) {
        return undefined
    }

    const repair = repairAction(state)
    if (repair) {
        return repair
    }

    if (!isComplete(state, "exploration")) {
        return createAction(state, "exploration", "workflow", {
            artifact: "exploration.md",
            prompt: "Explore the repository and return complete Markdown evidence. Do not edit files.",
        })
    }

    if (!isComplete(state, "proposal")) {
        return createAction(state, "planning", "workflow", {
            mode: state.scopeTier === "full" ? "requirements-bundle" : "standard-bundle",
            artifact: "bundle",
            prompt:
                state.scopeTier === "full"
                    ? "Return JSON with proposal and specs only. Do not write files."
                    : "Return JSON with proposal, specs, and tasks. Do not write files.",
        })
    }

    if (state.scopeTier === "full" && !isComplete(state, "design")) {
        return createAction(state, "design", "workflow", {
            artifact: "design.md",
            prompt: "Return independent design Markdown. Do not write files.",
        })
    }

    if (state.scopeTier !== "lean" && !isComplete(state, "tasks")) {
        return createAction(state, "planning", "workflow", {
            mode: "task-refinement",
            artifact: "tasks.md",
            prompt: "Return tasks Markdown from persisted proposal, specs, and design. Do not edit files.",
        })
    }

    const consultation = state.requirements.requiredCapabilities.find(
        capability =>
            SPECIALIST_CAPABILITIES.has(capability) &&
            !hasCompletedDispatch(state, capability, "consultation", resumeTarget),
    )
    if (consultation) {
        return createAction(state, consultation, "consultation", {
            prompt: "Provide focused planning consultation with evidence. Do not edit files.",
        })
    }

    if (!isComplete(state, "implementation")) {
        return createAction(state, "implementation", "workflow", {
            prompt: "Implement approved artifacts and tests. Do not alter OpenSpec artifacts or Git history.",
        })
    }

    if (!isComplete(state, "verification")) {
        return createAction(state, "verification", "workflow", {
            artifact: "verification.md",
            prompt: "Verify requirements using registered command evidence. Return verification Markdown only.",
        })
    }

    if (!isComplete(state, "correctness-judgment")) {
        return createAction(state, "correctness-judgment", "judgment", {
            independent: true,
            artifact: "judgment-correctness.json",
            prompt: "Return an independent structured correctness judgment for the current diff.",
        })
    }

    if (
        state.requirements.judgePolicy.required.includes("compliance") &&
        !isComplete(state, "compliance-judgment")
    ) {
        return createAction(state, "compliance-judgment", "judgment", {
            independent: true,
            artifact: "judgment-compliance.json",
            prompt: "Return an independent structured specification-compliance judgment for the current diff.",
        })
    }

    if (!hasCompletedDispatch(state, "general-risk", "independent-review", resumeTarget)) {
        return createAction(state, "general-risk", "independent-review", {
            independent: true,
            prompt:
                "Perform only a cross-cutting risk scan and facet detection. " +
                "Request specialist escalation when needed; never substitute for deep specialist review.",
        })
    }

    const review = state.requirements.requiredReviewFacets.find(
        facet => !hasCompletedDispatch(state, facet, "independent-review", resumeTarget),
    )
    if (review) {
        return createAction(state, review, "independent-review", {
            independent: true,
            prompt: "Perform an independent post-implementation specialist review. Do not rely on consultation.",
        })
    }

    if (!isComplete(state, "review-ledger")) {
        return createAction(state, "refutation", "workflow", {
            artifact: "review-ledger.json",
            prompt:
                "Return JSON { findings: [{ severity, mode?, summary }] }. " +
                "Deduplicate findings and set mode only for a blocking repair.",
        })
    }

    return undefined
}

/**
 * Return the next controller directive for the current run.
 *
 * This is a pure read over the run state; it does not persist any issued
 * dispatch. The engine wraps it in {@link issueDirective} to persist dispatch
 * provenance when the directive is `dispatch`.
 *
 * @param state - The current run state.
 * @returns A {@link ControllerDirective} telling the controller what to do.
 */
export function nextDirective(state: RunState): ControllerDirective {
    const mode = state.mode ?? "interactive"

    // Paused states are handled first so a resumable pending question can be
    // presented again without dispatching a worker.
    if (state.status === "paused") {
        if (state.pendingQuestion) {
            if (mode === "automatic") {
                return {
                    type: "block",
                    reason: "pending-question",
                    resumable: true,
                    question: state.pendingQuestion,
                }
            }
            return {
                type: "ask-question",
                question: state.pendingQuestion,
                bindingHash: state.pendingQuestion.bindingHash,
            }
        }
        return {
            type: "block",
            reason: state.pauseReason ?? "pending-question",
            resumable: state.resumable ?? false,
        }
    }

    if (state.status !== "running") {
        return {
            type: "block",
            reason: state.blockReason ?? state.pauseReason ?? "validation-failed",
            resumable: false,
            question: state.pendingQuestion,
        }
    }

    if (state.pendingQuestion) {
        if (mode === "automatic") {
            return {
                type: "block",
                reason: "pending-question",
                resumable: true,
                question: state.pendingQuestion,
            }
        }
        return {
            type: "ask-question",
            question: state.pendingQuestion,
            bindingHash: state.pendingQuestion.bindingHash,
        }
    }

    const resumeTarget = getResumeTarget(state)
    const action = nextAction(state, resumeTarget)

    if (resumeTarget && action) {
        const answered = state.questionHistory.find(
            record => record.id === resumeTarget.questionId && record.outcome === "answered",
        )
        if (answered) {
            action.prompt = resumePromptForAnswer(action.prompt, answered)
        }
    }

    if (action) {
        return { type: "dispatch", action }
    }

    return { type: "finalize" }
}

/**
 * Hash stable dispatch inputs for an auditable provenance record.
 *
 * @param action - The action to fingerprint.
 * @param state - The run state contributing the policy and diff hashes.
 * @returns A SHA-256 hex digest of the capability, purpose, mode, policy
 *   hash, implementation diff hash, and current answer hashes.
 */
export function dispatchHash(action: WorkflowAction, state: RunState): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                capability: action.capability,
                purpose: action.purpose,
                mode: action.mode,
                policy: state.requirements.policyHash,
                diff: state.implementationDiffHash,
                answers: answerHashes(state),
            }),
        )
        .digest("hex")
}

/**
 * Build the action for a pending repair, if any.
 *
 * @param state - The current run state.
 * @returns The repair {@link WorkflowAction}, or `undefined` when no repair is
 *   pending.
 */
function repairAction(state: RunState): WorkflowAction | undefined {
    const repair = state.pendingRepair
    if (!repair) {
        return undefined
    }

    if (repair.mode === "spec-mismatch") {
        return createAction(state, "planning", "repair", {
            mode: "artifact-repair",
            artifact: "bundle",
            prompt: "Return validated replacement proposal and specs JSON. Do not edit repository files.",
        })
    }

    if (repair.mode === "design-revision") {
        return createAction(state, "design", "repair", {
            mode: "artifact-repair",
            artifact: "design.md",
            prompt: "Return validated replacement design Markdown. Do not edit repository files.",
        })
    }

    return createAction(state, "repair", "repair", {
        prompt: "Repair repository code and tests only. Do not alter OpenSpec artifacts or Git history.",
    })
}

/**
 * Construct a {@link WorkflowAction} with a fresh id and the agent resolved for
 * the capability/purpose pair.
 *
 * @param _state - Unused; retained for a consistent call signature with the
 *   other internal helpers.
 * @param capability - The capability to dispatch.
 * @param purpose - The dispatch purpose.
 * @param options - The prompt, mode, artifact, and `independent` override.
 * @returns A fully formed {@link WorkflowAction}.
 */
function createAction(
    _state: RunState,
    capability: CapabilityId,
    purpose: WorkflowAction["purpose"],
    options: Omit<WorkflowAction, "id" | "capability" | "agent" | "purpose" | "independent"> & {
        independent?: boolean
    },
): WorkflowAction {
    return {
        id: randomUUID(),
        capability,
        agent: agentForCapability(capability, purpose),
        purpose,
        independent: options.independent ?? false,
        mode: options.mode,
        artifact: options.artifact,
        prompt: options.prompt,
    }
}

/**
 * Test whether the run already has a completed dispatch for a capability/purpose pair.
 *
 * @param state - The current run state.
 * @param capability - The capability to check.
 * @param purpose - The dispatch purpose to check.
 * @returns `true` when at least one matching completed dispatch exists.
 */
function hasCompletedDispatch(
    state: RunState,
    capability: CapabilityId,
    purpose: WorkflowAction["purpose"],
    resumeTarget?: ResumeTarget,
): boolean {
    const completed = state.dispatches.some(
        dispatch =>
            dispatch.capability === capability &&
            dispatch.purpose === purpose &&
            dispatch.status === "completed",
    )
    if (!completed) return false
    // The resume target overrides "already completed" when the answer requires
    // the same capability to be re-dispatched.
    if (resumeTarget && resumeTarget.capability === capability) {
        return false
    }
    return true
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

import type { RunState } from "../state/schema.js"
import { cancelV1Run, updateV1Run } from "../state/store.js"
import type { PlanningArtifact } from "./stages.js"
import {
    applyPlanningFeedback,
    type PlanningResult,
    type PlanningWorkflowOptions,
} from "./planning.js"

/** Presentation-only summary shown at the one planning checkpoint. */
export type PlanningOverview = {
    change: string
    goal: string
    artifacts: readonly PlanningArtifact[]
}

/** The only actions available at the planning checkpoint. */
export type PlanningCheckpointAction =
    | { kind: "continue" }
    | { kind: "request-changes"; feedback: Partial<Record<PlanningArtifact, string>> }
    | { kind: "cancel"; reason?: string }

/** Return checkpoint presentation data without changing workflow state. */
export function planningOverview(state: RunState): PlanningOverview {
    return {
        change: state.change,
        goal: state.goal,
        artifacts: ["proposal", "specs", "design", "tasks"],
    }
}

/** Resolve the single planning checkpoint action. */
export async function resolvePlanningCheckpoint(
    options: PlanningWorkflowOptions,
    state: RunState,
    action: PlanningCheckpointAction,
): Promise<
    PlanningResult | { kind: "continued"; state: RunState } | { kind: "cancelled"; state: RunState }
> {
    if (state.status !== "awaiting-user" || state.stage !== "implementation") {
        throw new Error("planning checkpoint is not pending")
    }
    if (action.kind === "continue") {
        const next = await updateV1Run(options.directory, state.change, run => ({
            ...run,
            status: "active",
            stage: "implementation",
        }))
        return { kind: "continued", state: next }
    }
    if (action.kind === "cancel") {
        return { kind: "cancelled", state: await cancelV1Run(options.directory, state.change) }
    }
    return applyPlanningFeedback(options, state, action.feedback)
}

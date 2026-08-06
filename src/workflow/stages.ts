import type { RunStage, RunState } from "../state/schema.js"

/** Planning stages owned by the Phase 4 coordinator. */
export const PLANNING_STAGES = ["proposal", "specs", "design", "tasks"] as const

/** A standard OpenSpec artifact authored during planning. */
export type PlanningArtifact = (typeof PLANNING_STAGES)[number]

/** Return whether a coarse run stage is an OpenSpec planning artifact stage. */
export function isPlanningArtifact(stage: RunStage): stage is PlanningArtifact {
    return (PLANNING_STAGES as readonly string[]).includes(stage)
}

/** Return the stage after a successfully validated planning artifact. */
export function nextPlanningStage(stage: PlanningArtifact): RunStage {
    switch (stage) {
        case "proposal":
            return "specs"
        case "specs":
            return "design"
        case "design":
            return "tasks"
        case "tasks":
            return "implementation"
    }
}

/** Return a new active state at a coarse planning boundary. */
export function transitionPlanningStage(state: RunState, stage: RunStage): RunState {
    return { ...state, status: "active", stage, failure: null }
}

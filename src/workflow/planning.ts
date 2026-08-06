import type { AgentId } from "../agents/ids.js"
import type { OpenSpecInstructions } from "../openspec/instructions.js"
import type { OpenSpecChangeStatus } from "../openspec/status.js"
import type { OpenSpecValidationResult } from "../openspec/validation.js"
import type { RunState } from "../state/schema.js"
import { updateV1Run } from "../state/store.js"
import type { ValidationCommand, ValidationRecommendation } from "../validation/registry.js"
import type { ImplementationWorkflowOptions } from "./implementation.js"
import {
    isPlanningArtifact,
    nextPlanningStage,
    transitionPlanningStage,
    type PlanningArtifact,
} from "./stages.js"

/** The two automatic correction attempts allowed after an initial artifact write. */
export const MAX_ARTIFACT_CORRECTIONS = 2

/** Narrow adapter surface needed by planning, intentionally easy to fake in tests. */
export type PlanningOpenSpecAdapter = {
    status(change: string): Promise<OpenSpecChangeStatus>
    instructions(artifact: string, change: string): Promise<OpenSpecInstructions>
    validate(change: string): Promise<OpenSpecValidationResult>
}

/** One agent invocation requested by the planning coordinator. */
export type PlanningAgentRequest = {
    agent: AgentId
    change: string
    goal: string
    artifact: PlanningArtifact
    artifactPath: string
    instructions: OpenSpecInstructions
    kind: "initial" | "correction" | "feedback"
    correctionAttempt?: number
    validationErrors?: readonly unknown[]
    feedback?: string
    model?: string
}

/** Injected native-task boundary; workers own all artifact edits. */
export type PlanningAgentRunner = {
    run(request: PlanningAgentRequest): Promise<void>
}

/** Dependencies for deterministic planning orchestration. */
export type PlanningWorkflowOptions = {
    directory: string
    adapter: PlanningOpenSpecAdapter
    agents: PlanningAgentRunner
    validationCommands?: ValidationCommand[]
    validationRecommendations?: ValidationRecommendation[]
    implementation?: Omit<ImplementationWorkflowOptions, "directory" | "adapter" | "commands">
}

/** Result at a planning boundary, suitable for a coordinator/native UI. */
export type PlanningResult =
    | { kind: "checkpoint"; state: RunState }
    | { kind: "correction-exhausted"; artifact: PlanningArtifact; state: RunState }

/** Run or resume planning at its persisted coarse stage until it reaches a user boundary. */
export async function runPlanning(
    options: PlanningWorkflowOptions,
    state: RunState,
): Promise<PlanningResult> {
    let current = state
    while (isPlanningArtifact(current.stage)) {
        const artifact = current.stage
        const result = await authorArtifact(options, current, artifact)
        if (result.kind === "correction-exhausted") return result
        current = result.state
    }
    if (current.stage !== "implementation") {
        throw new Error(`cannot present planning checkpoint from ${current.stage}`)
    }
    const complete = await options.adapter.status(current.change)
    if (!complete.isComplete) {
        throw new Error("OpenSpec reports planning artifacts are incomplete")
    }
    const validation = await options.adapter.validate(current.change)
    if (!validation.valid) {
        throw new Error("OpenSpec reports invalid planning artifacts at the checkpoint")
    }
    const checkpoint = await updateV1Run(options.directory, current.change, run => ({
        ...run,
        status: "awaiting-user",
        stage: "implementation",
    }))
    return { kind: "checkpoint", state: checkpoint }
}

/** Retry a correction explicitly approved after the automatic correction budget is exhausted. */
export async function retryPlanningArtifact(
    options: PlanningWorkflowOptions,
    state: RunState,
    model?: string,
): Promise<PlanningResult> {
    if (!isPlanningArtifact(state.stage)) {
        throw new Error("no planning artifact is awaiting correction")
    }
    const artifact = state.stage
    const active = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "active",
        artifactCorrectionAttempts: { ...run.artifactCorrectionAttempts, [artifact]: 0 },
    }))
    return authorArtifact(options, active, artifact, model, true)
}

/** Revalidate a manually edited artifact without rewriting any model-owned content. */
export async function revalidatePlanningArtifact(
    options: PlanningWorkflowOptions,
    state: RunState,
): Promise<PlanningResult> {
    if (!isPlanningArtifact(state.stage)) {
        throw new Error("no planning artifact is awaiting manual revalidation")
    }
    const artifact = state.stage
    const validation = await options.adapter.validate(state.change)
    if (!validation.valid) return { kind: "correction-exhausted", artifact, state }
    const next = await updateV1Run(options.directory, state.change, run =>
        transitionPlanningStage(run, nextPlanningStage(artifact)),
    )
    return runPlanning(options, next)
}

/** Route user feedback only to changed artifact owners and revalidate each changed artifact. */
export async function applyPlanningFeedback(
    options: PlanningWorkflowOptions,
    state: RunState,
    feedback: Partial<Record<PlanningArtifact, string>>,
): Promise<PlanningResult> {
    if (state.status !== "awaiting-user" || state.stage !== "implementation") {
        throw new Error("planning feedback requires the planning checkpoint")
    }
    for (const artifact of ["proposal", "specs", "design", "tasks"] as const) {
        const message = feedback[artifact]
        if (!message?.trim()) continue
        const { instructions, status } = await artifactInstructions(options, state.change, artifact)
        if (status !== "done") {
            throw new Error(
                `OpenSpec does not report ${artifact} as complete for planning feedback`,
            )
        }
        await options.agents.run({
            agent: ownerFor(artifact),
            change: state.change,
            goal: state.goal,
            artifact,
            artifactPath: instructions.resolvedOutputPath,
            instructions,
            kind: "feedback",
            feedback: message,
        })
        const validation = await options.adapter.validate(state.change)
        if (!validation.valid) {
            return await pauseForCorrections(options, state, artifact, validation.issues)
        }
    }
    return runPlanning(
        options,
        await updateV1Run(options.directory, state.change, run => ({ ...run, status: "active" })),
    )
}

/** Author one artifact and apply the bounded OpenSpec-directed correction loop. */
async function authorArtifact(
    options: PlanningWorkflowOptions,
    state: RunState,
    artifact: PlanningArtifact,
    model?: string,
    forceInitialWrite = false,
): Promise<PlanningResult> {
    const { instructions, status } = await artifactInstructions(options, state.change, artifact)
    if (status !== "ready" && status !== "done") {
        throw new Error(`OpenSpec does not report ${artifact} as ready`)
    }
    const attempts = state.artifactCorrectionAttempts[artifact] ?? 0
    if ((status === "ready" || forceInitialWrite) && attempts === 0) {
        await options.agents.run({
            agent: ownerFor(artifact),
            change: state.change,
            goal: state.goal,
            artifact,
            artifactPath: instructions.resolvedOutputPath,
            instructions,
            kind: "initial",
            model,
        })
    }
    let validation = await options.adapter.validate(state.change)
    if (validation.valid) return advanceArtifact(options, state, artifact)

    for (let correction = attempts + 1; correction <= MAX_ARTIFACT_CORRECTIONS; correction += 1) {
        const corrected = await updateV1Run(options.directory, state.change, run => ({
            ...run,
            artifactCorrectionAttempts: {
                ...run.artifactCorrectionAttempts,
                [artifact]: correction,
            },
        }))
        await options.agents.run({
            agent: ownerFor(artifact),
            change: corrected.change,
            goal: corrected.goal,
            artifact,
            artifactPath: instructions.resolvedOutputPath,
            instructions,
            kind: "correction",
            correctionAttempt: correction,
            validationErrors: validation.issues,
            model,
        })
        validation = await options.adapter.validate(corrected.change)
        if (validation.valid) return advanceArtifact(options, corrected, artifact)
        state = corrected
    }
    return pauseForCorrections(options, state, artifact, validation.issues)
}

/** Persist an awaiting-user correction pause without converting invalid artifacts into failure. */
async function pauseForCorrections(
    options: PlanningWorkflowOptions,
    state: RunState,
    artifact: PlanningArtifact,
    _errors: readonly unknown[],
): Promise<PlanningResult> {
    const paused = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "awaiting-user",
        stage: artifact,
    }))
    return { kind: "correction-exhausted", artifact, state: paused }
}

/** Advance only after OpenSpec validates the artifact sequence boundary. */
async function advanceArtifact(
    options: PlanningWorkflowOptions,
    state: RunState,
    artifact: PlanningArtifact,
): Promise<PlanningResult> {
    const next = await updateV1Run(options.directory, state.change, run =>
        transitionPlanningStage(run, nextPlanningStage(artifact)),
    )
    return runPlanning(options, next)
}

/** Query upstream artifact state and instructions without reproducing readiness rules in TypeScript. */
async function artifactInstructions(
    options: PlanningWorkflowOptions,
    change: string,
    artifact: PlanningArtifact,
): Promise<{ status: string; instructions: OpenSpecInstructions }> {
    const status = await options.adapter.status(change)
    const item = status.artifacts.find(candidate => candidate.id === artifact)
    if (!item) throw new Error(`OpenSpec does not report a ${artifact} artifact`)
    return {
        status: item.status,
        instructions: await options.adapter.instructions(artifact, change),
    }
}

/** Return the single agent permitted to mutate a standard planning artifact. */
function ownerFor(artifact: PlanningArtifact): AgentId {
    return artifact === "design" ? "specops-designer" : "specops-planner"
}

import { readFile } from "node:fs/promises"
import { AGENT_IDS } from "../agents/ids.js"
import { loadPrompt } from "../prompts/loader.js"
import { detectRepositoryMutation, type RepositoryMutation } from "../repository/changes.js"
import type { OpenSpecChangeStatus } from "../openspec/status.js"
import { explorationPath } from "../state/paths.js"
import type { RunState } from "../state/schema.js"
import { updateV1Run } from "../state/store.js"
import type { AcceptedValidationCommands } from "../validation/commands.js"
import { invalidateValidationEvidence, persistValidationEvidence } from "../validation/evidence.js"
import {
    executeValidationCommand,
    type ValidationEvidence,
    type ValidationProcessRunner,
} from "../validation/executor.js"
import type { ValidationCommand } from "../validation/registry.js"
import { MAX_VALIDATION_FIXES } from "./limits.js"

export { MAX_VALIDATION_FIXES } from "./limits.js"

/** Complete approved artifacts supplied to every implementer invocation. */
export type ImplementationArtifacts = {
    exploration: string
    proposal: string
    specs: string
    design: string
    tasks: string
}

/** Structured worker report used only at the implementation boundary. */
export type ImplementationBlocker =
    | {
          kind: "artifact-conflict"
          artifact: "proposal" | "specs" | "design" | "tasks"
          message: string
      }
    | {
          kind: "material-decision"
          prompt: string
          outcomes: readonly string[]
          repositoryResolvable: boolean
          affectsMaterialOutcome: boolean
          reversibleLowRiskAssumptionAvailable: boolean
      }
    | { kind: "ordinary-failure"; message: string }
    | {
          kind: "frontier"
          message: string
          inspectedEvidence: readonly string[]
          concreteAttempt: string
          substantial: boolean
          ordinaryRetryUnlikely: boolean
          materialQuestion?: Extract<ImplementationBlocker, { kind: "material-decision" }>
      }

/** Result reported by the implementer after a bounded implementation attempt. */
export type ImplementationWorkerResult =
    { kind: "completed" } | { kind: "blocker"; blocker: ImplementationBlocker }

/** Full native-task request for the only code-writing implementation agent. */
export type ImplementationAgentRequest = {
    agent: typeof AGENT_IDS.implementer
    change: string
    goal: string
    artifacts: ImplementationArtifacts
    baselineRepositoryState: string
    acceptedValidationCommands: readonly ValidationCommand[]
    prompt: string
    state: RunState
    kind: "initial" | "retry" | "validation-fix" | "frontier-advice" | "review-repair"
    validationEvidence?: readonly ValidationEvidence[]
    frontierAdvice?: string
    reviewBlockingFindingIds?: readonly string[]
}

/** Injectable native task boundary for the implementer. */
export type ImplementationAgentRunner = {
    run(request: ImplementationAgentRequest): Promise<ImplementationWorkerResult | void>
}

/** Read-only native task boundary for a one-time frontier consultation. */
export type FrontierRunner = {
    run(request: {
        agent: typeof AGENT_IDS.frontier
        change: string
        goal: string
        state: RunState
        blocker: Extract<ImplementationBlocker, { kind: "frontier" }>
        readOnly: true
    }): Promise<{ advice: string }>
}

/** Minimal OpenSpec status surface needed to locate approved artifacts. */
export type ImplementationOpenSpecAdapter = {
    status(change: string): Promise<OpenSpecChangeStatus>
}

/** A parsed standard OpenSpec task checkbox. */
export type OpenSpecTask = { id: string; complete: boolean; text: string }

/** Deterministic outcome at an implementation or validation boundary. */
export type ImplementationResult =
    | { kind: "ready-for-review"; state: RunState; evidence: ValidationEvidence[] }
    | { kind: "tasks-incomplete"; state: RunState; incompleteTasks: OpenSpecTask[] }
    | {
          kind: "artifact-conflict"
          state: RunState
          agent: "specops-planner" | "specops-designer"
          message: string
      }
    | { kind: "material-question"; state: RunState; prompt: string; outcomes: readonly string[] }
    | { kind: "blocked"; state: RunState; message: string }
    | { kind: "external-mutation"; state: RunState; mutation: RepositoryMutation }

/** Dependencies for the bounded source implementation and validation workflow. */
export type ImplementationWorkflowOptions = {
    directory: string
    adapter: ImplementationOpenSpecAdapter
    implementer: ImplementationAgentRunner
    frontier: FrontierRunner
    commands: AcceptedValidationCommands
    loadArtifacts?: (directory: string, change: string) => Promise<ImplementationArtifacts>
    loadPrompt?: () => string
    detectMutation?: (directory: string, previous: string) => Promise<RepositoryMutation>
    executeCommand?: (
        directory: string,
        command: ValidationCommand,
        identity: string,
        run?: ValidationProcessRunner,
    ) => Promise<ValidationEvidence>
    validationProcess?: ValidationProcessRunner
    notifyMutation?: (mutation: RepositoryMutation) => void | Promise<void>
}

/** Parse standard OpenSpec checkbox entries without storing a parallel task state. */
export function parseOpenSpecTasks(tasks: string): OpenSpecTask[] {
    const entries = [...tasks.matchAll(/^\s*- \[([ xX])\]\s+(\d+(?:\.\d+)*)\s+(.+\S)\s*$/gm)]
    if (entries.length === 0)
        throw new Error("OpenSpec tasks.md contains no trackable task checkboxes")
    return entries.map(match => ({
        id: match[2],
        complete: match[1].toLowerCase() === "x",
        text: match[3],
    }))
}

/** Return the unchecked required tasks from standard OpenSpec task content. */
export function incompleteOpenSpecTasks(
    tasks: string,
    requiredTaskIds?: readonly string[],
): OpenSpecTask[] {
    const required = requiredTaskIds ? new Set(requiredTaskIds) : undefined
    return parseOpenSpecTasks(tasks).filter(
        task => (!required || required.has(task.id)) && !task.complete,
    )
}

/** Route a reported blocker without allowing worker output to mutate run state directly. */
export function routeImplementationBlocker(
    blocker: ImplementationBlocker,
    frontierAlreadyUsed: boolean,
):
    | { kind: "artifact-conflict"; agent: "specops-planner" | "specops-designer" }
    | { kind: "material-question" }
    | { kind: "frontier" }
    | { kind: "retry" }
    | { kind: "blocked" } {
    if (blocker.kind === "artifact-conflict") {
        return {
            kind: "artifact-conflict",
            agent: blocker.artifact === "design" ? AGENT_IDS.designer : AGENT_IDS.planner,
        }
    }
    if (blocker.kind === "material-decision") {
        return isMaterialDecision(blocker) ? { kind: "material-question" } : { kind: "retry" }
    }
    if (blocker.kind === "ordinary-failure") return { kind: "retry" }
    if (!isFrontierEligible(blocker)) return { kind: "retry" }
    if (!frontierAlreadyUsed) return { kind: "frontier" }
    return blocker.materialQuestion && isMaterialDecision(blocker.materialQuestion)
        ? { kind: "material-question" }
        : { kind: "blocked" }
}

/** Run or resume implementation, then perform only the required validation gate. */
export async function runImplementation(
    options: ImplementationWorkflowOptions,
    state: RunState,
): Promise<ImplementationResult> {
    if (state.stage === "review") {
        return { kind: "ready-for-review", state, evidence: [] }
    }
    if (state.stage !== "implementation" && state.stage !== "validation") {
        throw new Error(`cannot run implementation from ${state.stage}`)
    }

    let artifacts = await implementationArtifacts(options, state)
    if (state.stage === "implementation") {
        const worker = await resolveImplementationWorker(options, state, artifacts)
        if (worker) return worker
        artifacts = await implementationArtifacts(options, state)
        const incompleteTasks = incompleteOpenSpecTasks(artifacts.tasks)
        if (incompleteTasks.length > 0) return { kind: "tasks-incomplete", state, incompleteTasks }
    }
    return runRequiredValidation(options, state, artifacts)
}

/** Load the latest model-owned artifact content at an implementation boundary. */
async function implementationArtifacts(
    options: ImplementationWorkflowOptions,
    state: RunState,
): Promise<ImplementationArtifacts> {
    return options.loadArtifacts
        ? await options.loadArtifacts(options.directory, state.change)
        : await loadImplementationArtifacts(options.directory, state.change, options.adapter)
}

/** Invoke the implementer and deterministically route only a reported blocker. */
async function resolveImplementationWorker(
    options: ImplementationWorkflowOptions,
    state: RunState,
    artifacts: ImplementationArtifacts,
): Promise<ImplementationResult | undefined> {
    let result = await invokeImplementer(options, state, artifacts, "initial")
    let retries = 0
    let frontierUsed = false
    while (result?.kind === "blocker") {
        const route = routeImplementationBlocker(result.blocker, frontierUsed)
        if (route.kind === "artifact-conflict") {
            return pauseForArtifactConflict(
                options,
                state,
                route.agent,
                blockerMessage(result.blocker),
            )
        }
        if (route.kind === "material-question") {
            const blocker =
                result.blocker.kind === "frontier"
                    ? result.blocker.materialQuestion
                    : result.blocker
            if (!blocker || blocker.kind !== "material-decision") {
                return block(options, state, blockerMessage(result.blocker))
            }
            return pauseForMaterialQuestion(options, state, blocker)
        }
        if (route.kind === "frontier") {
            frontierUsed = true
            const blocker = result.blocker as Extract<ImplementationBlocker, { kind: "frontier" }>
            const consultation = await options.frontier.run({
                agent: AGENT_IDS.frontier,
                change: state.change,
                goal: state.goal,
                state,
                blocker,
                readOnly: true,
            })
            result = await invokeImplementer(
                options,
                state,
                artifacts,
                "frontier-advice",
                undefined,
                consultation.advice,
            )
            continue
        }
        if (route.kind === "retry" && retries < 1) {
            retries += 1
            result = await invokeImplementer(options, state, artifacts, "retry")
            continue
        }
        return block(options, state, blockerMessage(result.blocker))
    }
    return undefined
}

/** Execute every accepted command against one identity and persist exact evidence. */
async function runRequiredValidation(
    options: ImplementationWorkflowOptions,
    initialState: RunState,
    initialArtifacts: ImplementationArtifacts,
): Promise<ImplementationResult> {
    let state = initialState
    let artifacts = initialArtifacts
    let fixes = 0
    const detect = options.detectMutation ?? detectRepositoryMutation
    const execute = options.executeCommand ?? executeValidationCommand

    while (true) {
        const before = await detect(options.directory, state.currentRepositoryState)
        if (before.changed) {
            await invalidateValidationEvidence(options.directory, state.change, before.current)
            await options.notifyMutation?.(before)
        }
        state = await updateV1Run(options.directory, state.change, run => ({
            ...run,
            status: "active",
            stage: "validation",
            currentRepositoryState: before.current,
            validatedRepositoryState: before.changed ? null : run.validatedRepositoryState,
            failure: null,
        }))

        const evidence: ValidationEvidence[] = []
        for (const command of options.commands.required) {
            const item = await execute(
                options.directory,
                command,
                before.current,
                options.validationProcess,
            )
            await persistValidationEvidence(options.directory, state.change, item)
            evidence.push(item)
        }

        const after = await detect(options.directory, before.current)
        if (after.changed) {
            await invalidateValidationEvidence(options.directory, state.change, after.current)
            await options.notifyMutation?.(after)
            const mutated = await updateV1Run(options.directory, state.change, run => ({
                ...run,
                status: "active",
                stage: "validation",
                currentRepositoryState: after.current,
                validatedRepositoryState: null,
                failure: null,
            }))
            return { kind: "external-mutation", state: mutated, mutation: after }
        }

        const failures = evidence.filter(
            item => item.timedOut || item.exitCode !== 0 || item.executionError,
        )
        if (failures.length === 0) {
            const ready = await updateV1Run(options.directory, state.change, run => ({
                ...run,
                status: "active",
                stage: "review",
                currentRepositoryState: before.current,
                validatedRepositoryState: before.current,
                failure: null,
            }))
            return { kind: "ready-for-review", state: ready, evidence }
        }
        if (fixes >= MAX_VALIDATION_FIXES) {
            return block(
                options,
                state,
                "required validation failed after bounded implementation fixes",
            )
        }
        fixes += 1
        state = await updateV1Run(options.directory, state.change, run => ({
            ...run,
            status: "active",
            stage: "implementation",
            currentRepositoryState: before.current,
            validatedRepositoryState: null,
            failure: null,
        }))
        const result = await invokeImplementer(
            options,
            state,
            artifacts,
            "validation-fix",
            failures,
        )
        if (result?.kind === "blocker") {
            const routed = await resolveImplementationWorkerResult(options, state, result)
            if (routed) return routed
        }
        artifacts = await implementationArtifacts(options, state)
        const incompleteTasks = incompleteOpenSpecTasks(artifacts.tasks)
        if (incompleteTasks.length > 0) return { kind: "tasks-incomplete", state, incompleteTasks }
    }
}

/** Route a validation-fix blocker without starting an additional implementation pass. */
async function resolveImplementationWorkerResult(
    options: ImplementationWorkflowOptions,
    state: RunState,
    result: Extract<ImplementationWorkerResult, { kind: "blocker" }>,
): Promise<ImplementationResult | undefined> {
    const route = routeImplementationBlocker(result.blocker, false)
    if (route.kind === "artifact-conflict") {
        return pauseForArtifactConflict(options, state, route.agent, blockerMessage(result.blocker))
    }
    if (route.kind === "material-question" && result.blocker.kind === "material-decision") {
        return pauseForMaterialQuestion(options, state, result.blocker)
    }
    return block(options, state, blockerMessage(result.blocker))
}

/** Invoke the implementer with every approved artifact and current bounded context. */
async function invokeImplementer(
    options: ImplementationWorkflowOptions,
    state: RunState,
    artifacts: ImplementationArtifacts,
    kind: ImplementationAgentRequest["kind"],
    validationEvidence?: readonly ValidationEvidence[],
    frontierAdvice?: string,
): Promise<ImplementationWorkerResult | void> {
    return options.implementer.run({
        agent: AGENT_IDS.implementer,
        change: state.change,
        goal: state.goal,
        artifacts,
        baselineRepositoryState: state.baselineRepositoryState,
        acceptedValidationCommands: options.commands.required,
        prompt: (options.loadPrompt ?? (() => loadPrompt(AGENT_IDS.implementer)))(),
        state,
        kind,
        validationEvidence,
        frontierAdvice,
    })
}

/** Pause for an artifact owner's correction without advancing implementation. */
async function pauseForArtifactConflict(
    options: ImplementationWorkflowOptions,
    state: RunState,
    agent: "specops-planner" | "specops-designer",
    message: string,
): Promise<ImplementationResult> {
    const paused = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "awaiting-user",
        stage: "implementation",
    }))
    return { kind: "artifact-conflict", state: paused, agent, message }
}

/** Pause only for a material decision that the coordinator must present. */
async function pauseForMaterialQuestion(
    options: ImplementationWorkflowOptions,
    state: RunState,
    blocker: Extract<ImplementationBlocker, { kind: "material-decision" }>,
): Promise<ImplementationResult> {
    const paused = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "awaiting-user",
        stage: "implementation",
    }))
    return {
        kind: "material-question",
        state: paused,
        prompt: blocker.prompt,
        outcomes: blocker.outcomes,
    }
}

/** Persist a genuine unresolved implementation problem as blocked. */
async function block(
    options: ImplementationWorkflowOptions,
    state: RunState,
    message: string,
): Promise<ImplementationResult> {
    const blocked = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "blocked",
        failure: { kind: "blocked", message, at: new Date().toISOString() },
    }))
    return { kind: "blocked", state: blocked, message }
}

/** Return whether a worker decision meets the coordinator's narrow question policy. */
function isMaterialDecision(
    blocker: Extract<ImplementationBlocker, { kind: "material-decision" }>,
): boolean {
    return (
        blocker.prompt.trim().length > 0 &&
        blocker.outcomes.length >= 2 &&
        !blocker.repositoryResolvable &&
        blocker.affectsMaterialOutcome &&
        !blocker.reversibleLowRiskAssumptionAvailable
    )
}

/** Return a concise diagnostic for any worker-reported blocker shape. */
function blockerMessage(blocker: ImplementationBlocker): string {
    return blocker.kind === "material-decision" ? blocker.prompt : blocker.message
}

/** Require documented investigation and a concrete failed attempt before frontier advice. */
function isFrontierEligible(
    blocker: Extract<ImplementationBlocker, { kind: "frontier" }>,
): boolean {
    return (
        blocker.inspectedEvidence.some(item => item.trim().length > 0) &&
        blocker.concreteAttempt.trim().length > 0 &&
        blocker.substantial &&
        blocker.ordinaryRetryUnlikely
    )
}

/** Read all approved artifacts from OpenSpec's current status paths. */
export async function loadImplementationArtifacts(
    directory: string,
    change: string,
    adapter?: ImplementationOpenSpecAdapter,
): Promise<ImplementationArtifacts> {
    if (!adapter) throw new Error("implementation artifact loader requires an OpenSpec adapter")
    const status = await adapter.status(change)
    if (!status.isComplete)
        throw new Error("OpenSpec planning artifacts are not approved for implementation")
    const readArtifact = async (id: "proposal" | "specs" | "design" | "tasks"): Promise<string> => {
        const paths = status.artifactPaths[id]?.existingOutputPaths
        if (!paths?.length) throw new Error(`OpenSpec has no approved ${id} artifact path`)
        const content = await Promise.all(paths.map(path => readFile(path, "utf8")))
        const joined = content.join("\n")
        if (!joined.trim()) throw new Error(`OpenSpec ${id} artifact is empty`)
        return joined
    }
    const [exploration, proposal, specs, design, tasks] = await Promise.all([
        readFile(explorationPath(directory, change), "utf8"),
        readArtifact("proposal"),
        readArtifact("specs"),
        readArtifact("design"),
        readArtifact("tasks"),
    ])
    if (!exploration.trim()) throw new Error("exploration artifact is empty")
    return { exploration, proposal, specs, design, tasks }
}

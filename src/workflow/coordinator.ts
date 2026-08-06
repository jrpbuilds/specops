import { access, readFile } from "node:fs/promises"
import { AGENT_IDS } from "../agents/ids.js"
import type { OpenSpecChangeStatus } from "../openspec/status.js"
import { OpenSpecOperationalError } from "../openspec/errors.js"
import { captureRepositoryBaseline, type RepositoryBaseline } from "../repository/baseline.js"
import { explorationPath } from "../state/paths.js"
import { recoverV1Run } from "../state/recovery.js"
import type { RunState } from "../state/schema.js"
import { createV1Run, readV1Run, updateV1Run } from "../state/store.js"
import {
    runPlanning,
    type PlanningAgentRunner,
    type PlanningOpenSpecAdapter,
    type PlanningResult,
} from "./planning.js"

/** Adapter contract consumed by the coordinator and intentionally fake-friendly. */
export type CoordinatorOpenSpecAdapter = PlanningOpenSpecAdapter & {
    version(): Promise<string>
    assertStandardSchema(change: string): Promise<string>
    createChange(change: string, goal: string): Promise<void>
}

/** Native explorer task boundary. The explorer alone writes the managed report. */
export type ExplorerRunner = {
    run(input: {
        agent: typeof AGENT_IDS.explorer
        change: string
        goal: string
        directory: string
    }): Promise<void>
}

/** Dependencies for starting or resuming a V1 planning run. */
export type CoordinatorOptions = {
    directory: string
    adapter: CoordinatorOpenSpecAdapter
    explorer: ExplorerRunner
    planners: PlanningAgentRunner
    captureBaseline?: (directory: string) => Promise<RepositoryBaseline>
    recover?: (
        directory: string,
        change: string,
        readStatus: (change: string) => Promise<OpenSpecChangeStatus>,
    ) => Promise<{ state: RunState }>
}

/** Result returned at the next coordinator-owned planning boundary. */
export type CoordinatorResult = PlanningResult & { resumed: boolean }

/** Start a standard OpenSpec change or resume its persisted coarse V1 planning boundary. */
export async function startOrResumePlanning(
    options: CoordinatorOptions,
    input: { change: string; goal: string },
): Promise<CoordinatorResult> {
    await options.adapter.version()
    const existing = await existingRun(options.directory, input.change)
    if (existing) {
        const recovered = await (options.recover ?? recoverV1Run)(
            options.directory,
            input.change,
            change => options.adapter.status(change),
        )
        return { ...(await runWithOperationalFailure(options, recovered.state)), resumed: true }
    }

    await identifyOrCreateChange(options.adapter, input.change, input.goal)
    await options.adapter.assertStandardSchema(input.change)
    const baseline = await (options.captureBaseline ?? captureRepositoryBaseline)(options.directory)
    const created = await createV1Run(options.directory, {
        change: input.change,
        goal: input.goal,
        baselineRepositoryState: baseline.identity,
    })
    return { ...(await runWithOperationalFailure(options, created)), resumed: false }
}

/** Persist an OpenSpec operational failure without presenting it as an artifact correction. */
async function runWithOperationalFailure(
    options: CoordinatorOptions,
    state: RunState,
): Promise<PlanningResult> {
    try {
        return await resumePlanning(options, state)
    } catch (error) {
        if (error instanceof OpenSpecOperationalError) {
            await updateV1Run(options.directory, state.change, run => ({
                ...run,
                status: "failed",
                failure: {
                    kind: "operational",
                    message: error.message,
                    at: new Date().toISOString(),
                },
            }))
        }
        throw error
    }
}

/** Resume the persisted exploration or planning stage without reconstructing prior work. */
async function resumePlanning(
    options: CoordinatorOptions,
    state: Awaited<ReturnType<typeof readV1Run>>,
): Promise<PlanningResult> {
    if (state.stage === "exploration") {
        await options.explorer.run({
            agent: AGENT_IDS.explorer,
            change: state.change,
            goal: state.goal,
            directory: options.directory,
        })
        await assertExploration(options.directory, state.change)
        state = await updateV1Run(options.directory, state.change, run => ({
            ...run,
            status: "active",
            stage: "proposal",
        }))
    }
    return runPlanning(
        { directory: options.directory, adapter: options.adapter, agents: options.planners },
        state,
    )
}

/** Identify an existing change first; only a missing status is eligible for creation. */
async function identifyOrCreateChange(
    adapter: CoordinatorOpenSpecAdapter,
    change: string,
    goal: string,
): Promise<OpenSpecChangeStatus> {
    try {
        return await adapter.status(change)
    } catch (error) {
        if (
            !(error instanceof Error) ||
            !/not found|unknown change|does not exist/i.test(error.message)
        ) {
            throw error
        }
        await adapter.createChange(change, goal)
        return adapter.status(change)
    }
}

/** Verify that the explorer wrote a non-empty managed report before planning starts. */
async function assertExploration(directory: string, change: string): Promise<void> {
    const output = explorationPath(directory, change)
    await access(output)
    if (!(await readFile(output, "utf8")).trim()) {
        throw new Error("explorer produced an empty exploration report")
    }
}

/** Return a persisted V1 state only when its managed path exists. */
async function existingRun(directory: string, change: string): Promise<boolean> {
    try {
        await readV1Run(directory, change)
        return true
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
        throw error
    }
}

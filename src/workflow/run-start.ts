import type { SpecOpsConfig } from "../config.js"
import { AGENT_IDS } from "../capabilities/ids.js"
import { assertCleanWorktree, baseCommit } from "../git.js"
import { createChange, uniqueChangeName } from "../openspec.js"
import { parseAssessment } from "../routing/assessment.js"
import { requirementsFor } from "../routing/policy.js"
import { withRunLock, writeMachine, writeRun } from "../state/store.js"
import { persistArtifact, writeArtifactIndex } from "./artifacts.js"
import type { RunState } from "../types.js"

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

    return withRunLock(directory, change, "start run", async () => {
        const now = new Date().toISOString()
        const state: RunState = {
            version: 7,
            revision: 0,
            mode: input.mode,
            goal: input.goal,
            baseline: "",
            requestedTier: input.requestedTier,
            scopeTier: routed.requirements.scopeTier,
            assessment,
            requirements: routed.requirements,
            riskFacets: assessment.riskFacets,
            confidence: assessment.confidence,
            routingReasons: routed.reasons,
            decisions: [],
            budgetUsage: {
                maxScopeEscalations: 0,
                maxSpecialistDispatches: 0,
                maxRepairCycles: 0,
                maxRepeatedFailureFingerprints: 0,
            },
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
            schedulerHistory: [],
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
    })
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

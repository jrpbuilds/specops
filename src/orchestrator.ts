import { readFile } from "node:fs/promises"
import path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { contextPacket } from "./capabilities/context.js"
import { COMMANDS } from "./commands.js"
import { doctor } from "./doctor.js"
import { executeValidation } from "./evidence/commands.js"
import { READ_ONLY_OPENSPEC_COMMANDS, openSpecOrThrow, onboard, readConfig } from "./openspec.js"
import { publishProgress, type MetadataContext } from "./progress.js"
import { summarize } from "./summary.js"
import { TOOL_IDS } from "./protocol.js"
import { changeRoot, readMachine, readRun, writeMachine } from "./state/store.js"
import {
    cancelRun,
    completeAction,
    finalizeRun,
    issueDirective,
    resumeCheckpointAction,
    startRun,
    answerQuestionAction,
    dismissQuestionAction,
} from "./workflow/engine.js"
import { pendingCheckpointBlockView, pendingQuestionBlockView } from "./workflow/questions.js"

/** Validated change-name pattern used by every tool that accepts a `change` argument. */
const CHANGE_NAME = /^[a-z0-9][a-z0-9-]*$/

/**
 * Allow-list of artifact file names that may be requested through the
 * `specops_request_context` tool. Limits the controller's view to the same
 * deterministic artifacts the workflow produces.
 */
const CONTEXT_ARTIFACTS = new Set([
    "routing.md",
    "exploration.md",
    "proposal.md",
    "design.md",
    "tasks.md",
    "verification.md",
    "review-ledger.json",
])

/**
 * Register the final SpecOps command and tool surface.
 *
 * Composes the deterministic protocol tools (start/next/complete/finalize,
 * context, validation, status, cancel) with diagnostic tools (onboard,
 * doctor, openspec) under a single OpenCode {@link Plugin}. The `config`
 * hook installs every SpecOps command without overwriting user overrides.
 * @param _input - OpenCode plugin input (currently unused).
 * @returns Plugin object exposing the SpecOps tool surface.
 */
export const SpecOpsPlugin: Plugin = async _input => ({
    config: async config => {
        config.command ??= {}
        for (const [name, command] of Object.entries(COMMANDS)) {
            config.command[name] ??= command
        }
    },
    tool: {
        [TOOL_IDS.startRun]: tool({
            description: "Create a final-format deterministic run from a strict assessment.",
            args: {
                goal: tool.schema.string().min(1),
                assessment: tool.schema.string().min(2),
                requestedTier: tool.schema.enum(["auto", "lean", "standard", "full"]),
                mode: tool.schema.enum(["automatic", "interactive"]),
            },
            async execute(args, context) {
                const config = await readConfig(context.directory)
                await onboard(context.directory)
                try {
                    const started = await startRun(context.directory, config, {
                        goal: args.goal,
                        assessmentOutput: args.assessment,
                        requestedTier: args.requestedTier,
                        mode: args.mode,
                    })
                    return summarize(started.state, started.change, "Run started")
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    if (/ResourceExhausted|rate.limit|429|too many requests/i.test(message)) {
                        return "SpecOps could not start the run: the upstream LLM provider returned a rate-limit error. Wait a moment and retry with the same specops_start_run call; no run state was persisted."
                    }
                    throw error
                }
            },
        }),
        [TOOL_IDS.nextAction]: tool({
            description:
                "Return the next controller directive (dispatch, ask-question, checkpoint, block, finalize).",
            args: { change: tool.schema.string().regex(CHANGE_NAME) },
            async execute(args, context) {
                return JSON.stringify(
                    await issueDirective(
                        context.directory,
                        args.change,
                        await readConfig(context.directory),
                    ),
                    null,
                    2,
                )
            },
        }),
        [TOOL_IDS.completeAction]: tool({
            description: "Validate and persist an issued deterministic worker result.",
            args: {
                change: tool.schema.string().regex(CHANGE_NAME),
                dispatchId: tool.schema.string().min(1),
                output: tool.schema.string(),
            },
            async execute(args, context) {
                const state = await completeAction(
                    context.directory,
                    args.change,
                    args.dispatchId,
                    args.output,
                    await readConfig(context.directory),
                )
                await publishProgress(
                    context as MetadataContext,
                    context.directory,
                    args.change,
                    state,
                )
                const dispatch = state.dispatches.find(d => d.id === args.dispatchId)
                const label = dispatch
                    ? `${dispatch.capability}${dispatch.purpose === "judgment" ? " judgment" : ""} completed`
                    : "Action completed"
                return summarize(state, args.change, label)
            },
        }),
        [TOOL_IDS.answerQuestion]: tool({
            description: "Record an answer to a worker-raised pending question.",
            args: {
                change: tool.schema.string().regex(CHANGE_NAME),
                questionId: tool.schema.string().min(1),
                selectedOption: tool.schema.string().optional(),
                otherText: tool.schema.string().optional(),
            },
            async execute(args, context) {
                if ((args.selectedOption === undefined) === (args.otherText === undefined)) {
                    throw new Error("Provide exactly one of selectedOption or otherText")
                }
                const state = await answerQuestionAction(
                    context.directory,
                    args.change,
                    args.questionId,
                    args.selectedOption,
                    args.otherText,
                    await readConfig(context.directory),
                )
                await publishProgress(
                    context as MetadataContext,
                    context.directory,
                    args.change,
                    state,
                )
                return summarize(state, args.change, "Question answered")
            },
        }),
        [TOOL_IDS.dismissQuestion]: tool({
            description: "Record that the user dismissed the native question UI without answering.",
            args: {
                change: tool.schema.string().regex(CHANGE_NAME),
                questionId: tool.schema.string().min(1),
            },
            async execute(args, context) {
                const state = await dismissQuestionAction(
                    context.directory,
                    args.change,
                    args.questionId,
                )
                await publishProgress(
                    context as MetadataContext,
                    context.directory,
                    args.change,
                    state,
                )
                return summarize(state, args.change, "Question dismissed")
            },
        }),
        [TOOL_IDS.resumeCheckpoint]: tool({
            description: "Resolve a pending interactive checkpoint and resume scheduling.",
            args: {
                change: tool.schema.string().regex(CHANGE_NAME),
                feedback: tool.schema.string().optional(),
            },
            async execute(args, context) {
                const state = await resumeCheckpointAction(
                    context.directory,
                    args.change,
                    args.feedback,
                    await readConfig(context.directory),
                )
                await publishProgress(
                    context as MetadataContext,
                    context.directory,
                    args.change,
                    state,
                )
                return summarize(state, args.change, "Checkpoint resolved")
            },
        }),
        [TOOL_IDS.requestContext]: tool({
            description: "Read bounded, scheduler-safe run context and persisted artifacts.",
            args: {
                change: tool.schema.string().regex(CHANGE_NAME),
                artifacts: tool.schema.array(tool.schema.string()).optional(),
            },
            async execute(args, context) {
                const config = await readConfig(context.directory)
                const state = await readRun(context.directory, args.change)
                const names = args.artifacts ?? []
                if (names.some(name => !CONTEXT_ARTIFACTS.has(name))) {
                    throw new Error("requested context artifact is not available")
                }

                const artifacts = await readContextArtifacts(
                    context.directory,
                    args.change,
                    names,
                    config.review.maxContextBytes,
                )
                return JSON.stringify({ context: contextPacket(state), artifacts }, null, 2)
            },
        }),
        [TOOL_IDS.runValidation]: tool({
            description: "Execute a registered arbitrary validation command without a shell.",
            args: {
                change: tool.schema.string().regex(CHANGE_NAME),
                dispatchId: tool.schema.string().min(1),
                validationId: tool.schema.string().min(1),
                executable: tool.schema.string().min(1),
                args: tool.schema.array(tool.schema.string()),
                cwd: tool.schema.string().optional(),
            },
            async execute(args, context) {
                const config = await readConfig(context.directory)
                const state = await readRun(context.directory, args.change)
                if (
                    !state.dispatches.some(
                        dispatch => dispatch.id === args.dispatchId && dispatch.status === "issued",
                    )
                ) {
                    throw new Error("validation requires an issued dispatch")
                }

                const requirement = state.requirements.requiredValidations.find(
                    (
                        candidate,
                    ): candidate is Extract<
                        (typeof state.requirements.requiredValidations)[number],
                        { kind: "command" }
                    > => candidate.id === args.validationId && candidate.kind === "command",
                )
                if (
                    !requirement ||
                    requirement.executable !== args.executable ||
                    JSON.stringify(requirement.args) !== JSON.stringify(args.args) ||
                    requirement.cwd !== args.cwd
                ) {
                    throw new Error("validation command does not match the run evidence registry")
                }

                const evidence = await executeValidation(
                    context.directory,
                    config,
                    {
                        ...args,
                        implementationDiffHash: state.implementationDiffHash,
                        policyHash: state.requirements.policyHash,
                    },
                    context.abort,
                )
                const registry = await readMachine(
                    context.directory,
                    args.change,
                    "specops-evidence.json",
                    {
                        version: 2,
                        commands: [] as unknown[],
                    },
                )
                registry.version = 2
                registry.commands.push(evidence)
                await writeMachine(
                    context.directory,
                    args.change,
                    "specops-evidence.json",
                    registry,
                )
                return JSON.stringify(evidence, null, 2)
            },
        }),
        [TOOL_IDS.getStatus]: tool({
            description: "Read final-format deterministic run state.",
            args: { change: tool.schema.string().regex(CHANGE_NAME) },
            async execute(args, context) {
                return JSON.stringify(await readRun(context.directory, args.change), null, 2)
            },
        }),
        [TOOL_IDS.cancelRun]: tool({
            description: "Persist a safe cancellation outcome for an active run.",
            args: {
                change: tool.schema.string().regex(CHANGE_NAME),
                reason: tool.schema.string().min(1).optional(),
            },
            async execute(args, context) {
                const state = await cancelRun(context.directory, args.change, args.reason)
                return summarize(state, args.change, "Run cancelled")
            },
        }),
        [TOOL_IDS.finalize]: tool({
            description: "Finalize a run only when deterministic completion gates are satisfied.",
            args: { change: tool.schema.string().regex(CHANGE_NAME) },
            async execute(args, context) {
                const state = await finalizeRun(
                    context.directory,
                    args.change,
                    await readConfig(context.directory),
                )
                const questionDto = pendingQuestionBlockView(state, args.change)
                if (questionDto) {
                    return JSON.stringify(questionDto, null, 2)
                }
                const checkpointDto = pendingCheckpointBlockView(state, args.change)
                if (checkpointDto) {
                    return JSON.stringify(checkpointDto, null, 2)
                }
                await publishProgress(
                    context as MetadataContext,
                    context.directory,
                    args.change,
                    state,
                )
                const label = state.status === "passed" ? "Run passed" : "Run finalized"
                return summarize(state, args.change, label)
            },
        }),
        [TOOL_IDS.onboard]: tool({
            description: "Install final SpecOps OpenSpec assets.",
            args: {},
            async execute(_args, context) {
                await onboard(context.directory)
                return "SpecOps final assets installed."
            },
        }),
        [TOOL_IDS.doctor]: tool({
            description: "Diagnose final SpecOps configuration and assets.",
            args: {},
            async execute(_args, context) {
                return doctor(context.directory, await readConfig(context.directory))
            },
        }),
        [TOOL_IDS.openSpec]: tool({
            description: "Run a read-only OpenSpec command.",
            args: { args: tool.schema.array(tool.schema.string()).min(1) },
            async execute(args, context) {
                if (!READ_ONLY_OPENSPEC_COMMANDS.has(args.args[0])) {
                    throw new Error("OpenSpec command is not read-only")
                }
                return openSpecOrThrow(
                    context.directory,
                    await readConfig(context.directory),
                    args.args,
                )
            },
        }),
    },
})

/**
 * Read a subset of context artifact files from a change directory, honouring
 * a byte budget so a single large artifact cannot crowd out the others.
 * @param directory - Repository root containing the `.specops` directory.
 * @param change - Change slug identifying the run's directory.
 * @param names - Artifact file names to read; must be in
 *   {@link CONTEXT_ARTIFACTS}.
 * @param limit - Maximum total bytes to return across all artifacts.
 * @returns Map of artifact file name to its (possibly truncated) content.
 */
async function readContextArtifacts(
    directory: string,
    change: string,
    names: string[],
    limit: number,
): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    let remaining = limit
    for (const name of names) {
        if (remaining <= 0) {
            break
        }
        const content = await readFile(path.join(changeRoot(directory, change), name), "utf8")
        result[name] = content.slice(0, remaining)
        remaining -= Buffer.byteLength(result[name])
    }
    return result
}

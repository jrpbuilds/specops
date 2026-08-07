import { tool, type Config, type Plugin } from "@opencode-ai/plugin";
import { COMMANDS } from "./commands.js";
import { loadV1Configuration } from "./config/loader.js";
import { OpenSpecAdapter } from "./openspec/adapter.js";
import { WORKFLOW_TOOL_IDS } from "./workflow/tools.js";
import { captureRepositoryBaseline } from "./repository/baseline.js";
import { calculateRepositoryIdentity } from "./repository/identity.js";
import { cancelV1Run, createV1Run, readV1Run, updateV1Run } from "./state/store.js";
import { persistValidationEvidence } from "./validation/evidence.js";
import { executeValidationCommand } from "./validation/executor.js";
import { formatV1Status, getV1Status } from "./status.js";
import { resolveCompletion, type CompletionOptions } from "./workflow/finalize.js";
import { reconcileStage } from "./workflow/reconcile.js";

/** Validates a canonical OpenSpec change identifier at every tool boundary. */
const CHANGE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;
const CHANGE_NAME_SCHEMA = tool.schema.string().regex(CHANGE_NAME);

/**
 * Register only the six V1 workflow tools and five public commands.
 *
 * Model delegation intentionally stays with OpenCode native tasks. Each tool
 * owns one deterministic boundary and returns bounded JSON context; none
 * exposes an old scheduler, dispatch identifier, or worker-output envelope.
 */
export const SpecOpsPlugin: Plugin = async () => ({
    config: async (config: Config) => {
        config.command ??= {};
        for (const [name, command] of Object.entries(COMMANDS)) config.command[name] ??= command;
    },
    tool: {
        [WORKFLOW_TOOL_IDS.startOrResume]: tool({
            description: "Start a V1 run or recover its persisted coarse stage boundary.",
            args: {
                change: CHANGE_NAME_SCHEMA,
                goal: tool.schema.string().min(1),
            },
            async execute(args, context) {
                const adapter = await adapterFor(context.directory);
                await adapter.version();
                let state;
                try {
                    state = await readV1Run(context.directory, args.change);
                } catch (error) {
                    if (!isMissingRun(error)) throw error;
                    await ensureChange(adapter, args.change, args.goal);
                    await adapter.assertStandardSchema(args.change);
                    const baseline = await captureRepositoryBaseline(context.directory);
                    state = await createV1Run(context.directory, {
                        change: args.change,
                        goal: args.goal,
                        baselineRepositoryState: baseline.identity,
                    });
                }
                return JSON.stringify({ kind: "success", state }, null, 2);
            },
        }),
        [WORKFLOW_TOOL_IDS.reconcileStage]: tool({
            description: "Validate one coarse V1 stage boundary and persist its bounded outcome.",
            args: { change: CHANGE_NAME_SCHEMA },
            async execute(args, context) {
                const outcome = await reconcileStage(
                    { directory: context.directory, adapter: await adapterFor(context.directory) },
                    await readV1Run(context.directory, args.change),
                );
                return JSON.stringify(outcome, null, 2);
            },
        }),
        [WORKFLOW_TOOL_IDS.getStatus]: tool({
            description: "Read bounded persisted context for a V1 run.",
            args: { change: CHANGE_NAME_SCHEMA },
            async execute(args, context) {
                return formatV1Status(
                    await getV1Status(
                        context.directory,
                        args.change,
                        await adapterFor(context.directory),
                    ),
                );
            },
        }),
        [WORKFLOW_TOOL_IDS.runValidation]: tool({
            description:
                "Execute one configured validation command shell-free and persist its evidence.",
            args: {
                change: CHANGE_NAME_SCHEMA,
                commandId: tool.schema.string().regex(CHANGE_NAME),
            },
            async execute(args, context) {
                const configuration = await loadV1Configuration(context.directory);
                const command = configuration.validation.commands.find(
                    item => item.id === args.commandId,
                );
                if (!command)
                    throw new Error(`configured validation command not found: ${args.commandId}`);
                const identity = await calculateRepositoryIdentity(context.directory);
                const evidence = await executeValidationCommand(
                    context.directory,
                    command,
                    identity,
                );
                await persistValidationEvidence(context.directory, args.change, evidence);
                const state = await updateV1Run(context.directory, args.change, run => ({
                    ...run,
                    currentRepositoryState: identity,
                    failure: null,
                }));
                return JSON.stringify({ kind: "success", state, evidence }, null, 2);
            },
        }),
        [WORKFLOW_TOOL_IDS.finalize]: tool({
            description:
                "Run V1 completion checks and archive only after explicit completion approval.",
            args: { change: CHANGE_NAME_SCHEMA },
            async execute(args, context) {
                const state = await readV1Run(context.directory, args.change);
                const adapter = await adapterFor(context.directory);
                const result = await resolveCompletion(
                    await completionOptions(context.directory, adapter),
                    state,
                    { kind: "complete-and-archive" },
                );
                return JSON.stringify(result, null, 2);
            },
        }),
        [WORKFLOW_TOOL_IDS.cancel]: tool({
            description:
                "Cancel an active V1 run without deleting artifacts or repository changes.",
            args: { change: CHANGE_NAME_SCHEMA },
            async execute(args, context) {
                return JSON.stringify(
                    { kind: "success", state: await cancelV1Run(context.directory, args.change) },
                    null,
                    2,
                );
            },
        }),
    },
});

/** Construct the single OpenSpec adapter used by all active V1 tool boundaries. */
async function adapterFor(directory: string): Promise<OpenSpecAdapter> {
    const config = await loadV1Configuration(directory);
    return new OpenSpecAdapter({ directory, command: config.openspec.command });
}

/** Create the standard OpenSpec change only when its status cannot be found. */
async function ensureChange(adapter: OpenSpecAdapter, change: string, goal: string): Promise<void> {
    try {
        await adapter.status(change);
    } catch (error) {
        if (
            !(error instanceof Error) ||
            !/not found|unknown change|does not exist/i.test(error.message)
        ) {
            throw error;
        }
        await adapter.createChange(change, goal);
    }
}

/** Identify the absent V1 metadata file without swallowing malformed legacy state. */
function isMissingRun(error: unknown): boolean {
    return Boolean(
        error && typeof error === "object" && "code" in error && error.code === "ENOENT",
    );
}

/**
 * Supply the Phase 7 finalizer the strict V1 required validation command set.
 */
async function completionOptions(
    directory: string,
    adapter: OpenSpecAdapter,
): Promise<CompletionOptions> {
    const configuration = await loadV1Configuration(directory);
    return {
        directory,
        adapter,
        implementation: {
            commands: { required: configuration.validation.commands, recommendations: [] },
        } as never,
        review: {} as never,
    };
}

import { readFile } from "node:fs/promises";
import { AGENT_IDS } from "../agents/ids.js";
import { runProcess } from "../process.js";
import { loadPrompt } from "../prompts/loader.js";
import { parseReview, type ParsedReview } from "../review/parser.js";
import { calculateRepositoryIdentity } from "../repository/identity.js";
import { summarizeChangedFiles, type ChangedFile } from "../repository/changes.js";
import { reviewPath } from "../state/paths.js";
import type { RunState } from "../state/schema.js";
import { updateV1Run } from "../state/store.js";
import {
    invalidateValidationEvidence,
    isValidationEvidenceCurrent,
    readValidationEvidence,
} from "../validation/evidence.js";
import type { ValidationEvidence } from "../validation/executor.js";
import {
    loadImplementationArtifacts,
    runImplementation,
    type ImplementationBlocker,
    type ImplementationArtifacts,
    type ImplementationOpenSpecAdapter,
    type ImplementationResult,
    type ImplementationWorkflowOptions,
} from "./implementation.js";
import { MAX_REVIEW_REPAIRS } from "./limits.js";

/** Full evidence supplied to the single independent reviewer. */
export type ReviewAgentRequest = {
    agent: typeof AGENT_IDS.reviewer;
    change: string;
    goal: string;
    artifacts: ImplementationArtifacts;
    diff: string;
    changedFiles: readonly ChangedFile[];
    repositoryIdentity: string;
    validationEvidence: readonly ValidationEvidence[];
    prompt: string;
    state: RunState;
    readOnly: true;
    writePath: string;
};

/** Injectable native-task boundary for the reviewer, which owns only review.md. */
type ReviewAgentRunner = {
    run(request: ReviewAgentRequest): Promise<void>;
};

/** Dependencies for the review gate and bounded repair loop. */
export type ReviewWorkflowOptions = {
    directory: string;
    adapter: ImplementationOpenSpecAdapter;
    reviewer: ReviewAgentRunner;
    implementation: Omit<ImplementationWorkflowOptions, "directory" | "adapter">;
    loadArtifacts?: (directory: string, change: string) => Promise<ImplementationArtifacts>;
    loadPrompt?: () => string;
    currentDiff?: (directory: string) => Promise<string>;
    summarizeChanges?: (directory: string) => Promise<ChangedFile[]>;
    calculateIdentity?: (directory: string) => Promise<string>;
    readEvidence?: (directory: string, change: string) => Promise<ValidationEvidence[]>;
    readReview?: (directory: string, change: string) => Promise<string>;
};

/** Deterministic review or repair boundary outcome. */
export type ReviewResult =
    | { kind: "ready-for-completion"; state: RunState }
    | { kind: "invalid-review"; state: RunState; reason: string }
    | { kind: "review-invalidated"; state: RunState; reason: string }
    | { kind: "blocked"; state: RunState; message: string }
    | {
          kind: "repair-validation";
          result: Exclude<ImplementationResult, { kind: "ready-for-review" }>;
      };

/** Run one independent review and, only for blocking findings, a bounded repair loop. */
export async function runReview(
    options: ReviewWorkflowOptions,
    initialState: RunState,
): Promise<ReviewResult> {
    if (initialState.stage !== "review" && initialState.stage !== "repair") {
        throw new Error(`cannot run review from ${initialState.stage}`);
    }

    let state = initialState;
    while (true) {
        const identity = await currentIdentity(options);
        const evidence = await currentEvidence(options, state);
        const validation = validationFailure(state, identity, evidence, options);
        if (validation) return invalidateForReview(options, state, identity, validation);

        const artifacts = await reviewArtifacts(options, state);
        await options.reviewer.run({
            agent: AGENT_IDS.reviewer,
            change: state.change,
            goal: state.goal,
            artifacts,
            diff: await (options.currentDiff ?? currentRepositoryDiff)(options.directory),
            changedFiles: await (options.summarizeChanges ?? summarizeChangedFiles)(
                options.directory,
            ),
            repositoryIdentity: identity,
            validationEvidence: evidence,
            prompt: options.loadPrompt?.() ?? loadPrompt(AGENT_IDS.reviewer),
            state,
            readOnly: true,
            writePath: reviewPath(options.directory, state.change),
        });

        let reviewed: ParsedReview;
        try {
            reviewed = parseReview(await reviewContent(options, state.change));
        } catch {
            return rejectInvalidReview(options, state, "review artifact is missing or unreadable");
        }
        const current = await currentIdentity(options);
        const reviewFailure = reviewFailureReason(reviewed, identity, current);
        if (reviewFailure) {
            return current !== identity || reviewed.reviewedRepositoryState !== identity
                ? invalidateForReview(options, state, current, reviewFailure)
                : rejectInvalidReview(options, state, reviewFailure);
        }

        if (reviewed.verdict === "pass") {
            const waiting = await updateV1Run(options.directory, state.change, run => ({
                ...run,
                status: "awaiting-user",
                stage: "archive",
                currentRepositoryState: current,
                reviewedRepositoryState: current,
                failure: null,
            }));
            return { kind: "ready-for-completion", state: waiting };
        }

        if (state.repairAttempts >= MAX_REVIEW_REPAIRS) {
            return blockReview(
                options,
                state,
                "review repair attempts exhausted; retry with a new run, switch model, repair manually, or cancel",
            );
        }

        const repaired = await invokeRepair(options, state, artifacts, reviewed.blockingFindingIds);
        if ("message" in repaired) return repaired;
        const validationResult = await runImplementation(
            { ...options.implementation, directory: options.directory, adapter: options.adapter },
            { ...repaired, stage: "validation" },
        );
        if (validationResult.kind !== "ready-for-review") {
            return { kind: "repair-validation", result: validationResult };
        }
        state = validationResult.state;
    }
}

/** Reject malformed reviewer output while retaining still-current validation evidence. */
async function rejectInvalidReview(
    options: ReviewWorkflowOptions,
    state: RunState,
    reason: string,
): Promise<Extract<ReviewResult, { kind: "invalid-review" }>> {
    const rejected = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "active",
        stage: "review",
        reviewedRepositoryState: null,
        failure: null,
    }));
    return { kind: "invalid-review", state: rejected, reason };
}

/** Reject stale review/validation without discarding evidence or reviewer diagnostics. */
async function invalidateForReview(
    options: ReviewWorkflowOptions,
    state: RunState,
    identity: string,
    reason: string,
): Promise<ReviewResult> {
    await invalidateValidationEvidence(options.directory, state.change, identity);
    const invalidated = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "active",
        stage: "review",
        currentRepositoryState: identity,
        validatedRepositoryState: null,
        reviewedRepositoryState: null,
        failure: null,
    }));
    return { kind: "review-invalidated", state: invalidated, reason };
}

/** Invoke only the existing implementer once with every blocking review finding. */
async function invokeRepair(
    options: ReviewWorkflowOptions,
    state: RunState,
    artifacts: ImplementationArtifacts,
    blockingFindingIds: readonly string[],
): Promise<RunState | Extract<ReviewResult, { kind: "blocked" }>> {
    const repair = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "active",
        stage: "repair",
        repairAttempts: run.repairAttempts + 1,
        validatedRepositoryState: null,
        reviewedRepositoryState: null,
        failure: null,
    }));
    const result = await options.implementation.implementer.run({
        agent: AGENT_IDS.implementer,
        change: repair.change,
        goal: repair.goal,
        artifacts,
        baselineRepositoryState: repair.baselineRepositoryState,
        acceptedValidationCommands: options.implementation.commands.required,
        prompt: options.implementation.loadPrompt?.() ?? loadPrompt(AGENT_IDS.implementer),
        state: repair,
        kind: "review-repair",
        reviewBlockingFindingIds: blockingFindingIds,
    });
    if (result?.kind === "blocker") {
        return blockReview(
            options,
            repair,
            `review repair blocked: ${blockerMessage(result.blocker)}`,
        );
    }
    return repair;
}

/** Render a safe concise diagnostic from a structured implementer blocker. */
function blockerMessage(blocker: ImplementationBlocker): string {
    if (blocker.kind === "material-decision") return blocker.prompt;
    return blocker.message;
}

/** Return a missing, stale, or unsuccessful required validation gate reason. */
function validationFailure(
    state: RunState,
    identity: string,
    evidence: readonly ValidationEvidence[],
    options: ReviewWorkflowOptions,
): string | undefined {
    if (state.validatedRepositoryState !== identity) return "required validation is stale";
    for (const command of options.implementation.commands.required) {
        const item = evidence.find(candidate => candidate.commandId === command.id);
        if (!item) return `required validation is missing: ${command.id}`;
        if (!isValidationEvidenceCurrent(item, identity))
            return `required validation is stale: ${command.id}`;
        if (item.timedOut || item.exitCode !== 0 || item.executionError) {
            return `required validation did not pass: ${command.id}`;
        }
    }
    return undefined;
}

/** Return a malformed, stale, or semantically inconsistent review reason. */
function reviewFailureReason(
    review: ParsedReview,
    expectedIdentity: string,
    currentIdentity: string,
): string | undefined {
    if (review.sections.length !== 6) return "review is missing required sections";
    if (!review.verdict) return "review verdict must be pass or changes-required";
    if (
        review.reviewedRepositoryState !== expectedIdentity ||
        currentIdentity !== expectedIdentity
    ) {
        return "reviewed repository identity is stale";
    }
    if (review.verdict === "pass" && review.blockingFindingIds.length > 0) {
        return "pass review cannot contain blocking findings";
    }
    if (review.verdict === "changes-required" && review.blockingFindingIds.length === 0) {
        return "changes-required review must contain blocking findings";
    }
    return undefined;
}

/** Persist an exhausted repair as a terminal blocked state while retaining diagnostics. */
async function blockReview(
    options: ReviewWorkflowOptions,
    state: RunState,
    message: string,
): Promise<Extract<ReviewResult, { kind: "blocked" }>> {
    const blocked = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "blocked",
        stage: "repair",
        failure: { kind: "blocked", message, at: new Date().toISOString() },
    }));
    return { kind: "blocked", state: blocked, message };
}

/** Load the approved planning artifacts through the same loader as implementation. */
async function reviewArtifacts(
    options: ReviewWorkflowOptions,
    state: RunState,
): Promise<ImplementationArtifacts> {
    return options.loadArtifacts
        ? options.loadArtifacts(options.directory, state.change)
        : options.implementation.loadArtifacts
          ? options.implementation.loadArtifacts(options.directory, state.change)
          : loadImplementationArtifacts(options.directory, state.change, options.adapter);
}

/** Read the managed review artifact without accepting caller-controlled paths. */
async function reviewContent(options: ReviewWorkflowOptions, change: string): Promise<string> {
    return options.readReview
        ? options.readReview(options.directory, change)
        : readFile(reviewPath(options.directory, change), "utf8");
}

/** Calculate the current implementation identity through an injectable boundary. */
async function currentIdentity(options: ReviewWorkflowOptions): Promise<string> {
    return (options.calculateIdentity ?? calculateRepositoryIdentity)(options.directory);
}

/** Read persisted validation evidence through an injectable boundary. */
async function currentEvidence(
    options: ReviewWorkflowOptions,
    state: RunState,
): Promise<ValidationEvidence[]> {
    return (options.readEvidence ?? readValidationEvidence)(options.directory, state.change);
}

/** Obtain the current tracked implementation diff without invoking a shell. */
async function currentRepositoryDiff(directory: string): Promise<string> {
    const result = await runProcess(
        "git",
        ["diff", "--no-ext-diff", "--binary", "HEAD", "--"],
        directory,
        undefined,
        { PATH: process.env.PATH ?? "", NO_COLOR: "1" },
    );
    if (result.code !== 0) throw new Error(`git diff failed: ${result.stderr}`);
    return result.stdout;
}

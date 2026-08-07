import { readFile } from "node:fs/promises";
import path from "node:path";
import { calculateRepositoryIdentity } from "../repository/identity.js";
import type { OpenSpecArchiveResult } from "../openspec/archive.js";
import type { OpenSpecValidationResult } from "../openspec/validation.js";
import type { OpenSpecChangeStatus } from "../openspec/status.js";
import { incompleteOpenSpecTasks } from "./implementation.js";
import {
    runImplementation,
    type ImplementationWorkflowOptions,
    type ImplementationResult,
} from "./implementation.js";
import { runReview, type ReviewWorkflowOptions, type ReviewResult } from "./review.js";
import type { ValidationEvidence } from "../validation/executor.js";
import { isValidationEvidenceCurrent, readValidationEvidence } from "../validation/evidence.js";
import { invalidateValidationEvidence } from "../validation/evidence.js";
import { parseReview } from "../review/parser.js";
import { reviewPath } from "../state/paths.js";
import type { ArchiveError, RunState } from "../state/schema.js";
import { cancelV1Run, updateV1Run } from "../state/store.js";

/** Adapter surface needed for finalisation preflight and archive. */
type FinalizationOpenSpecAdapter = {
    version(): Promise<string>;
    assertStandardSchema(change: string): Promise<string>;
    validate(change: string): Promise<OpenSpecValidationResult>;
    status(change: string): Promise<OpenSpecChangeStatus>;
    archive(change: string): Promise<OpenSpecArchiveResult>;
};

/** Dependencies for the V1 completion checkpoint and archive gate. */
export type CompletionOptions = {
    directory: string;
    adapter: FinalizationOpenSpecAdapter;
    implementation: Omit<ImplementationWorkflowOptions, "directory" | "adapter">;
    review: Omit<ReviewWorkflowOptions, "directory" | "adapter">;
    calculateIdentity?: (directory: string) => Promise<string>;
    readEvidence?: (directory: string, change: string) => Promise<ValidationEvidence[]>;
    readReview?: (directory: string, change: string) => Promise<string>;
    loadTasks?: (directory: string, change: string) => Promise<string>;
};

/** Presentation-only summary shown at the completion checkpoint. */
export type CompletionOverview = {
    change: string;
    goal: string;
    status: RunState["status"];
    stage: RunState["stage"];
    validatedRepositoryState: string | null;
    reviewedRepositoryState: string | null;
    repairAttempts: number;
};

/** The only actions available at the completion checkpoint. */
export type CompletionAction =
    | { kind: "complete-and-archive" }
    | { kind: "request-implementation-changes"; feedback: string }
    | { kind: "leave-change-open" }
    | { kind: "cancel" };

/** Deterministic outcome at the completion boundary. */
export type CompletionResult =
    | { kind: "completed"; state: RunState }
    | { kind: "archive-failed"; state: RunState; error: ArchiveError }
    | { kind: "verified"; state: RunState }
    | { kind: "cancelled"; state: RunState }
    | { kind: "finalisation-rejected"; state: RunState; reason: string }
    | {
          kind: "request-changes";
          state: RunState;
          result: ImplementationResult | ReviewResult;
      }
    | { kind: "verified-stale"; state: RunState; reason: string }
    | { kind: "verified-resumed"; state: RunState };

/** Return the presentation-only summary for the completion checkpoint. */
export function completionOverview(state: RunState): CompletionOverview {
    return {
        change: state.change,
        goal: state.goal,
        status: state.status,
        stage: state.stage,
        validatedRepositoryState: state.validatedRepositoryState,
        reviewedRepositoryState: state.reviewedRepositoryState,
        repairAttempts: state.repairAttempts,
    };
}

/** Resolve a completion checkpoint action deterministically. */
export async function resolveCompletion(
    options: CompletionOptions,
    state: RunState,
    action: CompletionAction,
): Promise<CompletionResult> {
    assertAtCompletionCheckpoint(state);

    if (action.kind === "cancel") {
        return { kind: "cancelled", state: await cancelV1Run(options.directory, state.change) };
    }

    if (action.kind === "leave-change-open") {
        const verified = await updateV1Run(options.directory, state.change, run => ({
            ...run,
            status: "verified",
            stage: "archive",
            failure: null,
        }));
        return { kind: "verified", state: verified };
    }

    if (action.kind === "request-implementation-changes") {
        return resolveRequestImplementationChanges(options, state, action.feedback);
    }

    return resolveCompleteAndArchive(options, state);
}

/** Resume a verified run, re-presenting the checkpoint or returning to validation/review. */
export async function resumeVerified(
    options: CompletionOptions,
    state: RunState,
): Promise<CompletionResult> {
    if (state.status !== "verified") {
        throw new Error("resumeVerified requires a verified run");
    }
    const identity = await (options.calculateIdentity ?? calculateRepositoryIdentity)(
        options.directory,
    );
    if (identity === state.currentRepositoryState) {
        const ready = await updateV1Run(options.directory, state.change, run => ({
            ...run,
            status: "awaiting-user",
            stage: "archive",
            failure: null,
        }));
        return { kind: "verified-resumed", state: ready };
    }
    await invalidateValidationEvidence(options.directory, state.change, identity);
    const stale = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "active",
        stage: "validation",
        currentRepositoryState: identity,
        validatedRepositoryState: null,
        reviewedRepositoryState: null,
        failure: null,
    }));
    return {
        kind: "verified-stale",
        state: stale,
        reason: "repository state changed since verification; fresh validation and review required",
    };
}

/** Run finalisation preflight checks and invoke OpenSpec archive on success. */
async function resolveCompleteAndArchive(
    options: CompletionOptions,
    state: RunState,
): Promise<CompletionResult> {
    const reason = await finalisationFailureReason(options, state);
    if (reason) {
        return { kind: "finalisation-rejected", state, reason };
    }

    const identity = await (options.calculateIdentity ?? calculateRepositoryIdentity)(
        options.directory,
    );
    let archiveResult: OpenSpecArchiveResult;
    try {
        archiveResult = await options.adapter.archive(state.change);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const errorRecord: ArchiveError = {
            message,
            attemptedAt: new Date().toISOString(),
            repositoryIdentity: identity,
        };
        const failed = await updateV1Run(options.directory, state.change, run => ({
            ...run,
            status: "failed",
            stage: "archive",
            failure: { kind: "archive", message, at: errorRecord.attemptedAt },
            archiveError: errorRecord,
        }));
        return { kind: "archive-failed", state: failed, error: errorRecord };
    }

    if (!archiveResult.success) {
        const message = archiveResult.stderr || archiveResult.stdout || "OpenSpec archive failed";
        const errorRecord: ArchiveError = {
            message,
            attemptedAt: new Date().toISOString(),
            repositoryIdentity: identity,
        };
        const failed = await updateV1Run(options.directory, state.change, run => ({
            ...run,
            status: "failed",
            stage: "archive",
            failure: { kind: "archive", message, at: errorRecord.attemptedAt },
            archiveError: errorRecord,
        }));
        return { kind: "archive-failed", state: failed, error: errorRecord };
    }

    const completed = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "completed",
        stage: "archive",
        archivedAt: new Date().toISOString(),
        failure: null,
        archiveError: null,
    }));
    return { kind: "completed", state: completed };
}

/** Route implementation-change feedback through validation and review before re-presenting. */
async function resolveRequestImplementationChanges(
    options: CompletionOptions,
    state: RunState,
    feedback: string,
): Promise<CompletionResult> {
    const identity = await (options.calculateIdentity ?? calculateRepositoryIdentity)(
        options.directory,
    );
    const invalidated = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "active",
        stage: "implementation",
        currentRepositoryState: identity,
        validatedRepositoryState: null,
        reviewedRepositoryState: null,
        failure: null,
        repairAttempts: 0,
    }));
    await invalidateValidationEvidence(options.directory, state.change, identity, true);
    const implementation = await runImplementation(
        {
            ...options.implementation,
            directory: options.directory,
            adapter: options.adapter,
            userFeedback: feedback,
        },
        invalidated,
    );
    if (implementation.kind !== "ready-for-review") {
        return { kind: "request-changes", state: implementation.state, result: implementation };
    }
    const review = await runReview(
        {
            ...options.review,
            directory: options.directory,
            adapter: options.adapter,
            implementation: options.implementation,
        },
        implementation.state,
    );
    return {
        kind: "request-changes",
        state: review.kind === "repair-validation" ? review.result.state : review.state,
        result: review,
    };
}

/** Return the first failing finalisation preflight reason, or undefined when all checks pass. */
async function finalisationFailureReason(
    options: CompletionOptions,
    state: RunState,
): Promise<string | undefined> {
    try {
        await options.adapter.version();
    } catch (error) {
        return error instanceof Error ? error.message : "unsupported OpenSpec version";
    }

    try {
        await options.adapter.assertStandardSchema(state.change);
    } catch (error) {
        return error instanceof Error ? error.message : "unsupported OpenSpec schema";
    }

    let validation: OpenSpecValidationResult;
    try {
        validation = await options.adapter.validate(state.change);
    } catch (error) {
        return error instanceof Error ? error.message : "OpenSpec validation failed";
    }
    if (!validation.valid) return "OpenSpec change is not valid";

    const tasksContent = await (options.loadTasks ?? loadTasks)(options.directory, state.change);
    const incomplete = incompleteOpenSpecTasks(tasksContent);
    if (incomplete.length > 0) {
        return `required tasks are not all complete: ${incomplete.map(t => t.id).join(", ")}`;
    }

    const identity = await (options.calculateIdentity ?? calculateRepositoryIdentity)(
        options.directory,
    );
    if (state.currentRepositoryState !== identity) {
        return "current repository identity changed since the completion checkpoint";
    }
    if (state.validatedRepositoryState !== identity) {
        return "validated repository identity does not match current identity";
    }

    const evidence = await (options.readEvidence ?? readValidationEvidence)(
        options.directory,
        state.change,
    );
    for (const command of options.implementation.commands.required) {
        const item = evidence.find(candidate => candidate.commandId === command.id);
        if (!item) return `required validation evidence missing: ${command.id}`;
        if (!isValidationEvidenceCurrent(item, identity)) {
            return `required validation is stale: ${command.id}`;
        }
        if (item.timedOut || item.exitCode !== 0 || item.executionError) {
            return `required validation did not pass: ${command.id}`;
        }
    }

    if (state.reviewedRepositoryState !== identity) {
        return "reviewed repository identity does not match current identity";
    }

    let reviewContent: string;
    try {
        reviewContent = await (options.readReview ?? readReviewContent)(
            options.directory,
            state.change,
        );
    } catch {
        return "review artifact is missing or unreadable";
    }
    const review = parseReview(reviewContent);
    if (review.verdict !== "pass") {
        return "review verdict is not pass";
    }
    if (review.reviewedRepositoryState !== identity) {
        return "reviewed repository identity in review does not match current identity";
    }

    return undefined;
}

/** Assert the run is at the completion checkpoint boundary. */
function assertAtCompletionCheckpoint(state: RunState): void {
    if (
        state.status !== "awaiting-user" &&
        state.status !== "verified" &&
        state.status !== "failed"
    ) {
        throw new Error(`completion checkpoint is not pending (status: ${state.status})`);
    }
    if (state.stage !== "archive") {
        throw new Error(`completion checkpoint is not pending (stage: ${state.stage})`);
    }
}

/** Load the standard OpenSpec tasks artifact. */
async function loadTasks(directory: string, change: string): Promise<string> {
    return readFile(path.join(directory, "openspec", "changes", change, "tasks.md"), "utf8");
}

/** Read the managed review artifact. */
async function readReviewContent(directory: string, change: string): Promise<string> {
    return readFile(reviewPath(directory, change), "utf8");
}

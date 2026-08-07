import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseReview } from "../review/parser.js";
import { calculateRepositoryIdentity } from "../repository/identity.js";
import { explorationPath, reviewPath } from "../state/paths.js";
import type { RunState } from "../state/schema.js";
import { updateV1Run } from "../state/store.js";
import { isValidationEvidenceCurrent, readValidationEvidence } from "../validation/evidence.js";
import { incompleteOpenSpecTasks } from "./implementation.js";
import { isPlanningArtifact, nextPlanningStage } from "./stages.js";

/** The only outcomes a coordinator receives after reconciling one stage boundary. */
export type ReconcileOutcome =
    | { kind: "success"; state: RunState; message: string }
    | { kind: "correction-required"; state: RunState; message: string; issues: unknown[] }
    | { kind: "user-input-required"; state: RunState; message: string }
    | { kind: "blocked"; state: RunState; message: string };

/** Minimal OpenSpec validation capability used at planning boundaries. */
export type ReconcileOpenSpecAdapter = {
    validate(item?: string, strict?: boolean): Promise<{ valid: boolean; issues: unknown[] }>;
};

/** Dependencies for the deterministic coarse stage-boundary reconciler. */
export type ReconcileStageOptions = {
    directory: string;
    adapter: ReconcileOpenSpecAdapter;
    calculateIdentity?: (directory: string) => Promise<string>;
};

/**
 * Reconcile exactly one persisted V1 stage after its owning agent or validator
 * has completed. This function never dispatches work or interprets worker
 * protocols; it checks the durable output and atomically persists the next
 * coarse boundary only when the corresponding gate is satisfied.
 */
export async function reconcileStage(
    options: ReconcileStageOptions,
    state: RunState,
): Promise<ReconcileOutcome> {
    if (state.status === "completed" || state.status === "cancelled") {
        return { kind: "blocked", state, message: `run is terminal (${state.status})` };
    }

    if (state.stage === "exploration") return reconcileExploration(options, state);
    if (isPlanningArtifact(state.stage)) return reconcilePlanningArtifact(options, state);
    if (state.stage === "implementation") return reconcileImplementation(options, state);
    if (state.stage === "validation") return reconcileValidation(options, state);
    if (state.stage === "review") return reconcileReview(options, state);
    if (state.stage === "repair") return reconcileRepair(options, state);

    return {
        kind: "user-input-required",
        state,
        message: "completion checkpoint is awaiting an explicit user decision",
    };
}

/** Reconcile the explorer-owned report before proposal authoring begins. */
async function reconcileExploration(
    options: ReconcileStageOptions,
    state: RunState,
): Promise<ReconcileOutcome> {
    const report = await readFile(explorationPath(options.directory, state.change), "utf8").catch(
        () => "",
    );
    if (!report.trim()) return block(options, state, "exploration report is missing or empty");

    const next = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "active",
        stage: "proposal",
        failure: null,
    }));
    return { kind: "success", state: next, message: "exploration report accepted" };
}

/** Reconcile one standard OpenSpec planning artifact through upstream validation. */
async function reconcilePlanningArtifact(
    options: ReconcileStageOptions,
    state: RunState,
): Promise<ReconcileOutcome> {
    const artifact = state.stage;
    if (!isPlanningArtifact(artifact)) {
        throw new Error(`cannot reconcile non-planning stage ${artifact} as an artifact`);
    }
    const validation = await options.adapter.validate(state.change, true);
    if (validation.valid) {
        const next = await updateV1Run(options.directory, state.change, run => ({
            ...run,
            status: "active",
            stage: nextPlanningStage(artifact),
            failure: null,
        }));
        return { kind: "success", state: next, message: `${artifact} passed OpenSpec validation` };
    }

    const attempts = (state.artifactCorrectionAttempts[artifact] ?? 0) + 1;
    const exhausted = attempts > 2;
    const next = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: exhausted ? "awaiting-user" : "active",
        artifactCorrectionAttempts: {
            ...run.artifactCorrectionAttempts,
            [artifact]: attempts,
        },
        failure: null,
    }));
    if (exhausted) {
        return {
            kind: "user-input-required",
            state: next,
            message: `${artifact} remains invalid after two automatic corrections`,
        };
    }
    return {
        kind: "correction-required",
        state: next,
        message: `${artifact} failed OpenSpec validation`,
        issues: validation.issues,
    };
}

/** Ensure the implementer completed the standard OpenSpec task list. */
async function reconcileImplementation(
    options: ReconcileStageOptions,
    state: RunState,
): Promise<ReconcileOutcome> {
    const tasks = await readFile(
        path.join(options.directory, "openspec", "changes", state.change, "tasks.md"),
        "utf8",
    ).catch(() => "");
    const incomplete = incompleteOpenSpecTasks(tasks);
    if (incomplete.length) {
        return {
            kind: "correction-required",
            state,
            message: `required tasks remain incomplete: ${incomplete.map(task => task.id).join(", ")}`,
            issues: incomplete,
        };
    }
    const next = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "active",
        stage: "validation",
        failure: null,
    }));
    return { kind: "success", state: next, message: "implementation tasks are complete" };
}

/** Bind successful validation evidence to the current repository identity. */
async function reconcileValidation(
    options: ReconcileStageOptions,
    state: RunState,
): Promise<ReconcileOutcome> {
    const identity = await (options.calculateIdentity ?? calculateRepositoryIdentity)(
        options.directory,
    );
    const evidence = await readValidationEvidence(options.directory, state.change);
    const failed = evidence.filter(
        item =>
            !isValidationEvidenceCurrent(item, identity) ||
            item.timedOut ||
            item.exitCode !== 0 ||
            item.executionError,
    );
    if (evidence.length === 0 || failed.length) {
        return {
            kind: "correction-required",
            state,
            message:
                evidence.length === 0
                    ? "required validation evidence is missing"
                    : "required validation evidence did not pass against the current repository state",
            issues: failed,
        };
    }
    const next = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "active",
        stage: "review",
        currentRepositoryState: identity,
        validatedRepositoryState: identity,
        failure: null,
    }));
    return { kind: "success", state: next, message: "validation evidence accepted" };
}

/** Parse and validate the reviewer-owned Markdown artifact at the review boundary. */
async function reconcileReview(
    options: ReconcileStageOptions,
    state: RunState,
): Promise<ReconcileOutcome> {
    const identity = await (options.calculateIdentity ?? calculateRepositoryIdentity)(
        options.directory,
    );
    const parsed = parseReview(
        await readFile(reviewPath(options.directory, state.change), "utf8").catch(() => ""),
    );
    if (
        parsed.sections.length !== 6 ||
        !parsed.verdict ||
        parsed.reviewedRepositoryState !== identity ||
        (parsed.verdict === "pass" && parsed.blockingFindingIds.length > 0) ||
        (parsed.verdict === "changes-required" && parsed.blockingFindingIds.length === 0)
    ) {
        return {
            kind: "correction-required",
            state,
            message: "review output is missing required sections, verdict, or current identity",
            issues: [],
        };
    }
    if (parsed.verdict === "changes-required") {
        const next = await updateV1Run(options.directory, state.change, run => ({
            ...run,
            status: "active",
            stage: "repair",
            repairAttempts: run.repairAttempts + 1,
            reviewedRepositoryState: identity,
            failure: null,
        }));
        return { kind: "success", state: next, message: "review requires bounded repair" };
    }
    const next = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "awaiting-user",
        stage: "archive",
        currentRepositoryState: identity,
        reviewedRepositoryState: identity,
        failure: null,
    }));
    return {
        kind: "user-input-required",
        state: next,
        message: "review passed; completion checkpoint is ready",
    };
}

/** Return repaired implementation to the deterministic validation gate. */
async function reconcileRepair(
    options: ReconcileStageOptions,
    state: RunState,
): Promise<ReconcileOutcome> {
    const next = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "active",
        stage: "validation",
        validatedRepositoryState: null,
        reviewedRepositoryState: null,
        failure: null,
    }));
    return { kind: "success", state: next, message: "repair submitted for validation" };
}

/** Persist a non-recoverable boundary failure without discarding user work. */
async function block(
    options: ReconcileStageOptions,
    state: RunState,
    message: string,
): Promise<ReconcileOutcome> {
    const blocked = await updateV1Run(options.directory, state.change, run => ({
        ...run,
        status: "blocked",
        failure: { kind: "blocked", message, at: new Date().toISOString() },
    }));
    return { kind: "blocked", state: blocked, message };
}

import { hash, invalidate } from "../artifacts/lifecycle.js";
import { redactSensitiveText } from "../security/redact.js";
import { readRun, writeRun, withRunLock } from "../state/store.js";
import type { SpecOpsConfig } from "../config.js";
import type { DispatchRecord, RunState } from "../types.js";
import { writeArtifactIndex } from "./artifacts.js";
import type { ControllerDirective } from "./scheduler.js";
import { assuranceEpoch, dispatchHash, nextDirective } from "./scheduler.js";
import { consumeResumeTarget } from "./questions.js";
import { recordFrontierDispatch } from "../frontier/policy.js";
import {
    appendEvidence,
    executeValidation,
    latestImplementationDispatch,
    missingCommandRequirements,
    readEvidenceRegistry,
} from "../evidence/registry.js";
import { refreshImplementationBinding, setOutcome } from "./run-state.js";
import { captureWriterGuard } from "./writer-guards.js";

/**
 * Compute and persist the next controller directive.
 *
 * This is the canonical progression entry point used by `specops_next_action`.
 * When the directive is `dispatch`, an issued {@link DispatchRecord} is
 * persisted so {@link completeAction} can later match the worker output. For
 * `ask-question`, `block`, and `finalize` directives no dispatch is recorded;
 * the run state is persisted only when a resume target was consumed.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param config - Configuration subset needed for diff collection limits.
 * @returns The next {@link ControllerDirective}.
 */
export async function issueDirective(
    directory: string,
    change: string,
    config: Pick<SpecOpsConfig, "review" | "frontier">,
): Promise<ControllerDirective> {
    return withRunLock(directory, change, "issue directive", () =>
        issueDirectiveLocked(directory, change, config),
    );
}

/**
 * Recover one interrupted worker dispatch without cancelling the whole run.
 *
 * Only the exact currently-issued dispatch may be recovered. Repository-mutating
 * dispatches invalidate implementation assurance because the worker may have
 * left a partial diff on disk before the interruption.
 *
 * @param directory - Repository root directory.
 * @param change - OpenSpec change id.
 * @param dispatchId - Exact issued dispatch to recover.
 * @param reason - Human-readable interruption reason.
 * @returns The updated run state.
 */
export async function recoverDispatch(
    directory: string,
    change: string,
    dispatchId: string,
    reason: string,
): Promise<RunState> {
    return withRunLock(directory, change, "recover dispatch", async () => {
        const state = await readRun(directory, change);
        const dispatch = state.dispatches.find(item => item.id === dispatchId);
        if (!dispatch) throw new Error(`unknown SpecOps dispatch: ${dispatchId}`);
        if (dispatch.status !== "issued") {
            throw new Error(`SpecOps dispatch ${dispatchId} is already ${dispatch.status}`);
        }
        const otherIssued = state.dispatches.find(
            item => item.status === "issued" && item.id !== dispatchId,
        );
        if (otherIssued) {
            throw new Error(`SpecOps has another issued dispatch: ${otherIssued.id}`);
        }
        const trimmed = redactSensitiveText(reason.trim()).slice(0, 1_000);
        if (!trimmed) throw new Error("dispatch recovery reason must be non-empty");
        const fingerprint = hash(
            JSON.stringify({
                capability: dispatch.capability,
                purpose: dispatch.purpose,
                action: dispatch.action,
                inputHash: dispatch.inputHash,
            }),
        );
        const attempt =
            state.dispatches.filter(item => item.recovery?.fingerprint === fingerprint).length + 1;
        dispatch.status = "failed";
        dispatch.finishedAt = new Date().toISOString();
        dispatch.failureReason = `Interrupted dispatch recovered: ${trimmed}`.slice(0, 2_000);
        dispatch.recovery = { reason: trimmed, at: dispatch.finishedAt, fingerprint, attempt };
        if (dispatch.capability === "implementation" || dispatch.capability === "repair") {
            invalidate(state, ["implementation"], "implementation worker interrupted");
        }
        if (attempt > state.requirements.budgets.maxRepeatedFailureFingerprints) {
            setOutcome(
                state,
                "blocked",
                "policy-blocked",
                `Interrupted dispatch recovery budget exhausted for ${dispatch.capability}.`,
                "budget-exhausted",
            );
        }
        await writeArtifactIndex(directory, change, state);
        await writeRun(directory, change, state);
        return state;
    });
}

/** Issue a directive after the caller has acquired the run mutation lock. */
async function issueDirectiveLocked(
    directory: string,
    change: string,
    config: Pick<SpecOpsConfig, "review" | "frontier">,
): Promise<ControllerDirective> {
    const state = await readRun(directory, change);

    const issued = state.dispatches.find(dispatch => dispatch.status === "issued");
    if (issued) {
        throw new Error(
            `SpecOps dispatch ${issued.id} is still issued and must be completed first`,
        );
    }

    await refreshImplementationBinding(directory, state, config.review.maxDiffBytes);

    const validationFailure = await runValidationBarrier(directory, change, state, config);
    if (validationFailure) {
        setOutcome(state, "failed", "validation-failed", validationFailure, "validation-failed");
        await writeRun(directory, change, state);
        return { type: "block", reason: "validation-failed", resumable: false };
    }

    const directive = nextDirective(state);

    if (directive.type === "dispatch") {
        const inputHash = dispatchHash(directive.action, state);
        const record: DispatchRecord = {
            id: directive.action.id,
            action: directive.action.mode ?? directive.action.capability,
            agent: directive.action.agent,
            capability: directive.action.capability,
            purpose: directive.action.purpose,
            independent: directive.action.independent,
            inputHash,
            attempt:
                state.dispatches.filter(
                    item =>
                        item.capability === directive.action.capability &&
                        item.purpose === directive.action.purpose &&
                        item.inputHash === inputHash,
                ).length + 1,
            status: "issued",
            at: new Date().toISOString(),
            assuranceEpoch: assuranceEpoch(state),
        };
        if (
            directive.action.capability === "implementation" ||
            directive.action.capability === "repair"
        ) {
            try {
                record.writerGuard = await captureWriterGuard(directory, change, state);
            } catch (error) {
                setOutcome(state, "blocked", "policy-blocked", String(error), "policy-rejected");
                await writeRun(directory, change, state);
                return { type: "block", reason: "policy-rejected", resumable: false };
            }
        }

        // Persist resume target metadata on the dispatch before consuming it.
        const resumeTarget = state.resumeTarget;
        const resume =
            resumeTarget &&
            directive.type === "dispatch" &&
            resumeTarget.capability === directive.action.capability &&
            resumeTarget.purpose === directive.action.purpose &&
            resumeTarget.action === (directive.action.mode ?? directive.action.capability)
                ? consumeResumeTarget(state)
                : undefined;
        if (resume) {
            record.resume = {
                sourceId: resume.sourceId,
                originalDispatchId: resume.originalDispatchId,
                answerHash: resume.answerHash,
                phase: resume.phase,
                capability: resume.capability,
                purpose: resume.purpose,
                action: resume.action,
                origin: resume.origin,
            };
        }
        if (
            state.frontierResume &&
            !state.frontierResume.consumed &&
            directive.action.capability === state.frontierResume.capability &&
            directive.action.purpose === state.frontierResume.purpose &&
            (directive.action.mode ?? directive.action.capability) === state.frontierResume.action
        ) {
            record.frontierResume = {
                episodeId: state.frontierResume.episodeId,
                originalDispatchId: state.frontierResume.originalDispatchId,
                adviceHash: state.frontierResume.adviceHash,
                phase: state.frontierResume.phase,
                capability: state.frontierResume.capability,
                purpose: state.frontierResume.purpose,
                action: state.frontierResume.action,
            };
            state.frontierResume.consumed = true;
        }
        state.dispatches.push(record);
        state.schedulerHistory ??= [];
        state.schedulerHistory.push({
            sequence: state.schedulerHistory.length + 1,
            revision: state.revision,
            snapshotHash: inputHash,
            action: record.action,
            capability: record.capability,
            purpose: record.purpose,
            bindingHash: record.inputHash,
            at: record.at,
        });
        if (state.schedulerHistory.length > 256) state.schedulerHistory.shift();
        if (directive.action.capability === "frontier") {
            recordFrontierDispatch(state);
        }
    } else if (directive.type === "block" && directive.reason === "workflow-stalled") {
        setOutcome(
            state,
            "blocked",
            "policy-blocked",
            state.resumeTarget
                ? "SpecOps could not reconstruct the exact action targeted by the pending resume request."
                : "SpecOps detected repeated scheduling for the same assurance epoch without implementation progress.",
            "workflow-stalled",
        );
    }

    await writeRun(directory, change, state);
    return directive;
}

/**
 * Run missing registered command validations after implementation binding and
 * before any downstream verification or review dispatch is issued.
 *
 * This barrier is controller-owned. Workers may still request optional command
 * evidence through the public validation tool, but required completion evidence
 * is never dependent on a model remembering to call that tool.
 *
 * @param directory - Repository root directory.
 * @param change - OpenSpec change id.
 * @param state - Mutable current run state.
 * @param config - Review configuration used by the confined command executor.
 * @returns A failure message when validation cannot complete, otherwise
 *   `undefined`.
 */
async function runValidationBarrier(
    directory: string,
    change: string,
    state: RunState,
    config: Pick<SpecOpsConfig, "review">,
): Promise<string | undefined> {
    if (
        state.status !== "running" ||
        state.pendingQuestions ||
        state.pendingCheckpoint ||
        state.artifacts.implementation?.validity !== "valid"
    ) {
        return undefined;
    }

    const registry = await readEvidenceRegistry(directory, change);
    const missing = missingCommandRequirements(directory, state, registry);
    if (missing.length === 0) return undefined;

    const sourceDispatch = latestImplementationDispatch(state);
    if (!sourceDispatch) {
        return "Registered validation evidence cannot be bound to an implementation dispatch.";
    }

    for (const requirement of missing) {
        let evidence: import("../types.js").CommandEvidence;
        try {
            evidence = await executeValidation(directory, config, {
                executable: requirement.executable,
                args: requirement.args,
                cwd: requirement.cwd,
                validationId: requirement.id,
                dispatchId: sourceDispatch.id,
                implementationDiffHash: state.implementationDiffHash,
                policyHash: state.requirements.policyHash,
            });
            await appendEvidence(directory, change, evidence);
        } catch (error) {
            return `Registered validation ${requirement.id} could not execute: ${String(error)}`;
        }

        if (evidence.exitCode !== 0) {
            return `Registered validation ${requirement.id} failed with exit code ${evidence.exitCode}.`;
        }
    }

    return undefined;
}

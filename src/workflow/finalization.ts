import { openSpecOrThrow, writeArtifact } from "../openspec.js"
import { readRun, writeRun, withRunLock } from "../state/store.js"
import { nextAction } from "./scheduler.js"
import { archiveCompletedRun } from "./archive.js"
import { refreshImplementationBinding, setOutcome } from "./run-state.js"
import { recordArtifact, writeArtifactIndex } from "./artifacts.js"
import { missingCommandRequirements, readEvidenceRegistry } from "../evidence/registry.js"
import type { SpecOpsConfig } from "../config.js"
import type { RunState } from "../types.js"

/**
 * Finalize only after every deterministic scheduling and artifact gate passes.
 *
 * For runs with a pending question, persist the paused state and return it
 * so the caller can render the stable CLI DTO. For running runs, asserts
 * no pending scheduler action, validates required artifacts and evidence, runs
 * OpenSpec validation, and assigns a terminal `passed` outcome on success.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param config - Full SpecOps configuration.
 * @returns The finalized {@link RunState}.
 * @throws When the completion gates are not yet satisfied.
 */
export async function finalizeRun(
    directory: string,
    change: string,
    config: SpecOpsConfig,
): Promise<RunState> {
    let state: RunState
    try {
        state = await withRunLock(directory, change, "finalize run", () =>
            finalizeRunLocked(directory, change, config),
        )
    } catch (error) {
        if (
            !(error instanceof Error) ||
            !error.message.startsWith(`SpecOps active run is missing: ${change}`)
        ) {
            throw error
        }
        return archiveCompletedRun(directory, change, config)
    }
    // Verification produced (or returned) a state whose finalization may still
    // require archiving. Run the archive policy outside the run lock so the
    // archive lock can serialize the directory move without nesting locks.
    return completeRunAfterVerification(directory, change, config, state)
}

/**
 * Apply the configured archive policy to a run that has reached the
 * finalization boundary.
 *
 * `passed` (verification done) transitions to `completed` directly when
 * auto-archive is disabled, or to `archiving → completed | archive_failed`
 * when enabled. `archiving` and `archive_failed` are retried or completed the
 * same way. `completed` and other terminal states are returned unchanged.
 */
async function completeRunAfterVerification(
    directory: string,
    change: string,
    config: SpecOpsConfig,
    state: RunState,
): Promise<RunState> {
    if (state.status === "completed") return state
    if (
        state.status === "passed" ||
        state.status === "archiving" ||
        state.status === "archive_failed"
    ) {
        if (config.openspec.autoArchive) {
            return archiveCompletedRun(directory, change, config)
        }
        return markCompletedSkippingArchive(directory, change)
    }
    // running/paused/blocked/failed/cancelled: return as-is.
    return state
}

/**
 * Transition a `passed` or `archive_failed` run to `completed` without
 * archiving, used when auto-archive is disabled.
 *
 * @param directory - Project root directory.
 * @param change - OpenSpec change identifier.
 * @returns The persisted `completed` state with no `archivedAt`.
 */
async function markCompletedSkippingArchive(directory: string, change: string): Promise<RunState> {
    return withRunLock(directory, change, "complete without archive", async () => {
        const current = await readRun(directory, change)
        const completedState: RunState = {
            ...current,
            status: "completed",
            archivedAt: undefined,
            archiveError: undefined,
        }
        await writeRun(directory, change, completedState)
        return completedState
    })
}

/** Finalize a run after the caller has acquired the run mutation lock. */
async function finalizeRunLocked(
    directory: string,
    change: string,
    config: SpecOpsConfig,
): Promise<RunState> {
    const state = await readRun(directory, change)

    if (state.status === "paused" && (state.pendingQuestions || state.pendingCheckpoint)) {
        await writeRun(directory, change, state)
        return state
    }

    if (state.status !== "running") {
        return state
    }

    if (await refreshImplementationBinding(directory, state, config.review.maxDiffBytes)) {
        await writeArtifactIndex(directory, change, state)
        await writeRun(directory, change, state)
        return state
    }

    if (nextAction(state)) {
        throw new Error("SpecOps completion gates are not satisfied")
    }

    const unresolvedRepairs = (state.repairTasks ?? []).filter(
        task => task.status !== "verified" && task.status !== "superseded",
    )
    if (unresolvedRepairs.length > 0) {
        setOutcome(
            state,
            "failed",
            "validation-failed",
            `Repair tasks are not verified: ${unresolvedRepairs
                .map(task => `${task.id} (${task.status})`)
                .join(", ")}`,
        )
        await writeRun(directory, change, state)
        return state
    }

    const missing = state.requirements.requiredArtifacts.filter(
        artifact => artifact !== "receipt" && state.artifacts[artifact]?.validity !== "valid",
    )
    if (missing.length) {
        setOutcome(
            state,
            "failed",
            "internal-error",
            `Completion artifacts are missing or stale: ${missing.join(", ")}`,
        )
        await writeRun(directory, change, state)
        return state
    }

    const missingEvidence = await missingEvidenceGates(directory, change, state)
    if (missingEvidence.length) {
        setOutcome(
            state,
            "failed",
            "validation-failed",
            `Registered validation evidence is missing or unsuccessful: ${missingEvidence.join(", ")}`,
        )
        await writeRun(directory, change, state)
        return state
    }

    try {
        await openSpecOrThrow(directory, config, ["status", "--change", change, "--json"])
        await openSpecOrThrow(directory, config, [
            "validate",
            change,
            "--type",
            "change",
            "--strict",
            "--no-interactive",
        ])
    } catch (error) {
        setOutcome(state, "failed", "validation-failed", String(error))
        await writeRun(directory, change, state)
        return state
    }

    state.status = "passed"
    state.outcome = {
        category: "completed",
        message: "All deterministic workflow, evidence, and review gates passed.",
        at: new Date().toISOString(),
    }
    const receipt = {
        version: 2,
        outcome: state.outcome,
        baseline: state.baseline,
        diffHash: state.implementationDiffHash,
        requirementsHash: state.requirements.policyHash,
        dispatches: state.dispatches,
        artifacts: state.artifacts,
        invalidations: state.invalidations,
        repairs: state.repairs,
        reviewSubmissions: state.reviewSubmissions,
        repairTasks: state.repairTasks,
        decisions: state.decisions,
        questionHistory: state.questionHistory,
        checkpointHistory: state.checkpointHistory,
        frontierUsage: state.frontierUsage,
        frontierHistory: state.frontierHistory,
    }
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`
    await writeArtifact(directory, change, "specops-receipt.json", serialized)
    recordArtifact(state, "receipt", "specops-engine", serialized, "workflow")
    await writeArtifactIndex(directory, change, state)
    await writeRun(directory, change, state)
    return state
}

/**
 * Return registered command validations that cannot satisfy the completion receipt.
 *
 * Cross-references `requiredValidations` of kind `command` against the
 * persisted `specops-evidence.json` registry and reports any requirement for
 * which no evidence row with matching id, executable, args, and exit code 0
 * exists.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param state - The current run state.
 * @returns The ids of required command validations lacking successful evidence.
 */
async function missingEvidenceGates(
    directory: string,
    change: string,
    state: RunState,
): Promise<string[]> {
    const registry = await readEvidenceRegistry(directory, change)
    return missingCommandRequirements(directory, state, registry).map(requirement => requirement.id)
}

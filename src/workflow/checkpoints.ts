import { createHash } from "node:crypto";
import type {
    ArtifactId,
    CapabilityId,
    CheckpointArtifactSnapshot,
    DispatchPurpose,
    PendingCheckpoint,
    RunState,
} from "../types.js";
import type { WorkflowAction } from "./actions.js";

/**
 * Return whether a persisted artifact is still usable by the scheduler.
 *
 * @param state - The current run state.
 * @param artifact - The artifact id to test.
 * @returns `true` when the artifact is recorded with `validity === "valid"`.
 */
const isComplete = (state: RunState, artifact: ArtifactId): boolean =>
    state.artifacts[artifact]?.validity === "valid";

/**
 * Checkpoint-eligible artifact groups produced by a single completed dispatch.
 *
 * Each entry maps a (capability, purpose, mode) tuple to the checkpoint
 * artifacts that were newly produced and remain valid after the dispatch
 * completes. An interactive run pauses once per group so the user may
 * continue or feed back before the next phase. Automatic runs never checkpoint.
 *
 * `purpose: "workflow"` is required so repair, consultation, independent
 * review, judgment, and frontier dispatches never checkpoint even when they
 * share a capability or mode with a workflow dispatch.
 */
const CHECKPOINT_ACTIONS: Array<{
    capability: CapabilityId;
    purpose: DispatchPurpose;
    mode?: string;
    artifacts: ArtifactId[];
}> = [
    // Lean planning produces tasks only.
    {
        capability: "planning",
        purpose: "workflow",
        mode: "lean-plan",
        artifacts: ["tasks"],
    },
    // Standard planning atomically produces proposal, specs, and tasks.
    {
        capability: "planning",
        purpose: "workflow",
        mode: "standard-bundle",
        artifacts: ["proposal", "tasks"],
    },
    // Full requirements bundle produces proposal (specs/design follow later).
    {
        capability: "planning",
        purpose: "workflow",
        mode: "requirements-bundle",
        artifacts: ["proposal"],
    },
    // Full designer produces the independent design artifact.
    { capability: "design", purpose: "workflow", artifacts: ["design"] },
    // Full task refinement produces tasks from proposal/specs/design.
    {
        capability: "planning",
        purpose: "workflow",
        mode: "task-refinement",
        artifacts: ["tasks"],
    },
    // Implementer produces the implementation diff.
    { capability: "implementation", purpose: "workflow", artifacts: ["implementation"] },
    // Verifier produces verification (Lean bundle also yields judgments/ledger
    // but those are assurance tail; the checkpoint is the verification phase).
    { capability: "verification", purpose: "workflow", artifacts: ["verification"] },
];

/**
 * Return the checkpoint-eligible artifacts a completed dispatch produced.
 *
 * Matches the dispatch's capability, purpose, and mode (if any) against the
 * configured checkpoint groups and returns only those artifacts that are
 * currently recorded with `validity === "valid"`. Returns an empty array when
 * the dispatch is not a checkpoint boundary (e.g. exploration, consultation,
 * independent review, judgment, repair, frontier).
 *
 * @param state - The current run state with persisted artifacts.
 * @param action - The action whose dispatch just completed.
 * @returns The checkpoint artifacts that remain valid, or an empty array.
 */
export function checkpointArtifactsFor(state: RunState, action: WorkflowAction): ArtifactId[] {
    return CHECKPOINT_ACTIONS.filter(
        entry =>
            entry.capability === action.capability &&
            entry.purpose === action.purpose &&
            (entry.mode === undefined || entry.mode === action.mode),
    ).flatMap(entry => entry.artifacts.filter(artifact => isComplete(state, artifact)));
}

/**
 * Build an immutable snapshot of the checkpoint artifacts and their current
 * output hashes. The snapshot is stored in the pending checkpoint and history
 * so duplicate detection and binding validation do not depend on the live
 * (mutable) artifact state.
 *
 * @param state - The current run state.
 * @param artifacts - The checkpoint artifact ids to snapshot.
 * @returns Immutable artifact/hash pairs.
 */
export function snapshotCheckpointArtifacts(
    state: RunState,
    artifacts: ArtifactId[],
): CheckpointArtifactSnapshot[] {
    return artifacts.map(artifact => ({
        artifact,
        outputHash: state.artifacts[artifact]?.outputHash ?? "",
    }));
}

/**
 * Return whether a checkpoint has already been recorded for a given dispatch
 * and set of artifact output hashes. The comparison uses the immutable
 * snapshot persisted in {@link CheckpointRecord.artifacts}, not the live
 * artifact state, so a regenerated artifact with a different output hash
 * produces a new checkpoint while a duplicate is suppressed.
 *
 * @param state - The current run state.
 * @param dispatchId - The completed dispatch id.
 * @param artifacts - The checkpoint artifact snapshot to compare against.
 * @returns `true` when an equivalent checkpoint already exists in history.
 */
export function hasCheckpointFor(
    state: RunState,
    dispatchId: string,
    artifacts: CheckpointArtifactSnapshot[],
): boolean {
    const hash = checkpointSnapshotHash(artifacts);
    return state.checkpointHistory.some(
        record =>
            record.dispatchId === dispatchId && checkpointSnapshotHash(record.artifacts) === hash,
    );
}

/**
 * Build a stable hash over an immutable artifact snapshot.
 *
 * @param artifacts - The checkpoint artifact snapshot.
 * @returns A SHA-256 hex digest of the artifact id/output-hash pairs.
 */
function checkpointSnapshotHash(artifacts: CheckpointArtifactSnapshot[]): string {
    return createHash("sha256")
        .update(
            JSON.stringify(
                [...artifacts]
                    .map(entry => [entry.artifact, entry.outputHash])
                    .sort(([left], [right]) => left.localeCompare(right)),
            ),
        )
        .digest("hex");
}

/**
 * Compute the stable binding hash for a checkpoint using the current run state.
 *
 * Binds the checkpoint to the policy hash, the dispatch input/output hashes,
 * the implementation diff hash, and the immutable artifact snapshot so a
 * regenerated phase produces a different binding and may checkpoint again.
 *
 * @param state - The current run state.
 * @param dispatch - The dispatch that produced the checkpoint artifacts.
 * @param artifacts - The immutable checkpoint artifact snapshot.
 * @returns A SHA-256 hex digest over authoritative inputs.
 */
export function computeCheckpointBindingHash(
    state: RunState,
    dispatch: { inputHash: string; outputHash?: string },
    artifacts: CheckpointArtifactSnapshot[],
): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                policyHash: state.requirements.policyHash,
                dispatchInputHash: dispatch.inputHash,
                dispatchOutputHash: dispatch.outputHash ?? "",
                implementationDiffHash: state.implementationDiffHash,
                artifacts: checkpointSnapshotHash(artifacts),
            }),
        )
        .digest("hex");
}

/**
 * Validate that a pending checkpoint's binding still matches the authoritative
 * run inputs. A stale checkpoint (e.g. after implementation diff or policy
 * changed between queueing and resolution) must not apply feedback against
 * outputs that were already invalidated.
 *
 * @param state - The current run state.
 * @param pending - The pending checkpoint to validate.
 * @returns `true` when the binding is still current; `false` when stale.
 */
export function isCheckpointBindingCurrent(state: RunState, pending: PendingCheckpoint): boolean {
    if (state.requirements.policyHash !== pending.policyHash) return false;
    if ((state.implementationDiffHash ?? "") !== (pending.implementationDiffHash ?? "")) {
        return false;
    }
    // Every snapshot artifact must still be valid with the recorded hash.
    for (const snapshot of pending.artifacts) {
        const provenance = state.artifacts[snapshot.artifact];
        if (!provenance || provenance.validity !== "valid") return false;
        if (provenance.outputHash !== snapshot.outputHash) return false;
    }
    const dispatch = state.dispatches.find(record => record.id === pending.dispatchId);
    if (!dispatch) return false;
    const recomputed = computeCheckpointBindingHash(state, dispatch, pending.artifacts);
    return recomputed === pending.bindingHash;
}

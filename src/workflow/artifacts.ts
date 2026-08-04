import { writeArtifact } from "../openspec.js"
import { writeMachine } from "../state/store.js"
import { hash } from "../artifacts/lifecycle.js"
import { redactSensitiveText } from "../security/redact.js"
import type { ArtifactId, DispatchRecord, RunState } from "../types.js"

/**
 * Maps persisted text artifacts to their on-disk file names under a change.
 *
 * Non-text artifacts (judgments, dispatches, receipt) are written by their own
 * code paths and are intentionally absent from this index.
 */
export const ARTIFACT_FILES: Partial<Record<ArtifactId, string>> = {
    routing: "routing.md",
    exploration: "exploration.md",
    proposal: "proposal.md",
    design: "design.md",
    tasks: "tasks.md",
    verification: "verification.md",
    "review-ledger": "review-ledger.json",
}

/**
 * Write a text artifact to disk and record its provenance in state.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param state - The current run state (mutated in place).
 * @param artifact - The artifact id to persist.
 * @param producer - The agent id that produced the content.
 * @param content - The raw artifact content.
 * @param purpose - The dispatch purpose that produced this artifact.
 * @throws When the artifact id is not in {@link ARTIFACT_FILES}.
 */
export async function persistArtifact(
    directory: string,
    change: string,
    state: RunState,
    artifact: ArtifactId,
    producer: string,
    content: string,
    purpose: DispatchRecord["purpose"],
): Promise<void> {
    const file = ARTIFACT_FILES[artifact]
    if (!file) {
        throw new Error(`artifact ${artifact} is not a text artifact`)
    }

    await writeArtifact(directory, change, file, content)
    recordArtifact(state, artifact, producer, content, purpose)
}

/**
 * Record artifact provenance in the run state without writing to disk.
 *
 * Provenance input hashes include the current policy hash, implementation diff
 * hash, and answer hashes from the question history, so a changed answer makes
 * dependent artifacts stale.
 *
 * @param state - The current run state (mutated in place).
 * @param artifact - The artifact id to record.
 * @param producer - The agent id that produced the content.
 * @param content - The raw artifact content (hashed for provenance).
 * @param purpose - The dispatch purpose that produced this artifact.
 */
export function recordArtifact(
    state: RunState,
    artifact: ArtifactId,
    producer: string,
    content: string,
    purpose: DispatchRecord["purpose"],
): void {
    const persistedContent = redactSensitiveText(content.trim())
    state.artifacts[artifact] = {
        artifact,
        producer,
        purpose,
        generatedAt: new Date().toISOString(),
        inputHashes: {
            policy: state.requirements.policyHash,
            diff: state.implementationDiffHash ?? "",
            ...answerHashes(state),
        },
        outputHash: hash(persistedContent),
        scopeTier: state.scopeTier,
        capabilities: state.requirements.requiredCapabilities,
        validity: "valid",
    }
}

/**
 * Persist the current artifact index to the `specops-artifacts.json` machine file.
 *
 * @param directory - Repository root directory.
 * @param change - The change name.
 * @param state - The current run state whose `artifacts` map is written.
 */
export async function writeArtifactIndex(
    directory: string,
    change: string,
    state: RunState,
): Promise<void> {
    await writeMachine(directory, change, "specops-artifacts.json", {
        version: 1,
        artifacts: state.artifacts,
    })
}

/**
 * Build a stable map of answered question ids to answer hashes.
 *
 * @param state - The current run state.
 * @returns Record of question id to answer hash.
 */
function answerHashes(state: RunState): Record<string, string> {
    const questionHashes = state.questionHistory
        .filter(record => record.outcome === "answered" && record.answerHash)
        .map(record => [record.id, record.answerHash] as [string, string])
    const checkpointHashes = state.checkpointHistory
        .filter(record => record.outcome === "feedback" && record.feedbackHash)
        .map(record => [record.dispatchId, record.feedbackHash] as [string, string])
    const result: Record<string, string> = {}
    for (const [k, v] of [...questionHashes, ...checkpointHashes]) {
        result[k] = v
    }
    return result
}

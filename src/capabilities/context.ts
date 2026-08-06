import type { RunState } from "../types.js";

/**
 * A bounded, provenance-preserving context view for a dispatched worker.
 *
 * Carries only the stable run metadata a worker needs to reason about its
 * scope: the goal, the selected tier, the requirements policy hash, the
 * active risk facets, a snapshot of artifact output hashes so workers
 * can detect drift without receiving the full run state, and the answer
 * hashes for any user-answered questions so downstream provenance can detect
 * answer-driven staleness.
 */
export type ContextPacket = {
    goal: string;
    scopeTier: RunState["scopeTier"];
    policyHash: string;
    riskFacets: RunState["riskFacets"];
    artifactHashes: Record<string, string>;
    /** Map of answered question id to answer hash, in resolution order. */
    answerHashes: Record<string, string>;
};

/**
 * Build stable context metadata shared by interactive and automatic dispatches.
 *
 * @param state - The persisted run state to derive the packet from.
 * @returns A {@link ContextPacket} containing the goal, tier, policy hash,
 *   active risk facets, artifact hashes, and answer hashes.
 */
export function contextPacket(state: RunState): ContextPacket {
    return {
        goal: state.goal,
        scopeTier: state.scopeTier,
        policyHash: state.requirements.policyHash,
        riskFacets: state.riskFacets,
        artifactHashes: Object.fromEntries(
            Object.entries(state.artifacts).flatMap(([id, provenance]) =>
                provenance ? [[id, provenance.outputHash]] : [],
            ),
        ),
        answerHashes: Object.fromEntries(
            state.questionHistory
                .filter(record => record.outcome === "answered" && record.answerHash)
                .map(record => [record.id, record.answerHash]),
        ),
    };
}

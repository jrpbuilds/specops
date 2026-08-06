import { createHash } from "node:crypto";
import type { ArtifactId, RunState } from "../types.js";
import { downstream } from "./graph.js";

/**
 * Produce a stable content hash for provenance and invalidation.
 *
 * @param content - The artifact bytes to hash.
 * @returns A lowercase hex SHA-256 digest of `content`.
 */
export const hash = (content: string): string => createHash("sha256").update(content).digest("hex");

/**
 * Mark a changed artifact and all of its dependents stale.
 *
 * Computes the downstream closure of `targets` via {@link downstream}, sets
 * `validity` to `stale` and records `reason` on every present provenance
 * record in the closure, appends a single invalidation entry to
 * `state.invalidations`, and returns the full affected set.
 *
 * @param state - The run state whose artifact provenances should be mutated.
 * @param targets - The artifact ids whose change triggered invalidation.
 * @param reason - Human-readable reason stored on each affected provenance.
 * @returns The full list of invalidated artifact ids (targets plus
 * transitively dependent artifacts).
 */
export function invalidate(state: RunState, targets: ArtifactId[], reason: string): ArtifactId[] {
    const affected = downstream(targets);
    for (const artifact of affected) {
        const current = state.artifacts[artifact];
        if (current) {
            current.validity = "stale";
            current.invalidationReason = reason;
        }
    }

    state.invalidations.push({ artifacts: affected, reason, at: new Date().toISOString() });
    return affected;
}

import type { ArtifactId } from "../types.js";

/**
 * Directed dependency graph used to invalidate stale derived artifacts.
 *
 * Each entry maps an artifact to the artifacts it consumes; when a dependency
 * is marked stale the {@link downstream} walk transitively invalidates the
 * consumer. `tasks` lists `design` even though standard-tier runs omit the
 * design artifact, because a missing dependency is harmless to the walk.
 */
const ARTIFACT_DEPENDENCIES: Record<ArtifactId, ArtifactId[]> = {
    routing: [],
    exploration: ["routing"],
    proposal: ["exploration"],
    specs: ["proposal"],
    design: ["exploration", "proposal", "specs"],
    // Standard work has no design artifact; a missing dependency is harmless.
    tasks: ["specs", "design"],
    implementation: ["tasks"],
    verification: ["implementation"],
    "correctness-judgment": ["implementation", "verification"],
    "compliance-judgment": ["implementation", "verification", "specs"],
    "review-ledger": ["implementation", "verification"],
    receipt: ["verification", "correctness-judgment", "review-ledger"],
};

/**
 * Return the input artifacts and every transitively dependent artifact.
 *
 * Performs a fixed-point reachability walk over
 * {@link ARTIFACT_DEPENDENCIES}: any artifact whose dependency set intersects
 * the affected set is added, repeated until the set stops growing.
 *
 * @param start - The artifact ids whose invalidation is being propagated.
 * @returns The closure of `start` plus all artifacts that transitively
 * depend on any element of `start`.
 */
export function downstream(start: ArtifactId[]): ArtifactId[] {
    const affected = new Set(start);
    let changed = true;

    while (changed) {
        changed = false;
        for (const [node, dependencies] of Object.entries(ARTIFACT_DEPENDENCIES) as Array<
            [ArtifactId, ArtifactId[]]
        >) {
            if (!affected.has(node) && dependencies.some(dependency => affected.has(dependency))) {
                affected.add(node);
                changed = true;
            }
        }
    }

    return [...affected];
}

import { createHash } from "node:crypto";
import {
    loadImplementationArtifacts,
    type ImplementationArtifacts,
    type ImplementationOpenSpecAdapter,
} from "./implementation.js";

/**
 * Deterministic identity over the exact current OpenSpec planning artifacts
 * (proposal, specs, design, tasks) that constitute the reviewer's requirements
 * context (B-02 architectural amendment).
 *
 * This is intentionally separate from the implementation repository identity,
 * which excludes OpenSpec planning artifacts. The two identities are never
 * merged. The planning identity excludes `.specops` evidence and review
 * output.
 */

/** The planning artifacts covered by the identity, in canonical order. */
const PLANNING_ARTIFACT_IDS = ["proposal", "specs", "design", "tasks"] as const;

/**
 * Compute the deterministic SHA-256 planning-artifact identity from the loaded
 * artifact contents (proposal, specs, design, tasks). This covers the exact
 * requirements context consumed by the reviewer. Exploration and `.specops`
 * evidence are excluded. The hash is order-stable and does not depend on
 * timestamps or conversational state.
 */
export function planningIdentityFromArtifacts(
    change: string,
    artifacts: Pick<ImplementationArtifacts, "proposal" | "specs" | "design" | "tasks">,
): string {
    const hash = createHash("sha256");
    for (const id of PLANNING_ARTIFACT_IDS) {
        hash.update(id, "utf8");
        hash.update("\0");
        hash.update(artifacts[id], "utf8");
        hash.update("\0");
    }
    hash.update(change, "utf8");
    return hash.digest("hex");
}

/** Minimal adapter surface needed to load the planning artifacts from disk. */
type PlanningArtifactAdapter = ImplementationOpenSpecAdapter;

/**
 * Load the approved planning artifacts through the same loader as
 * implementation and return their deterministic identity. Fails safely if an
 * expected artifact disappears, becomes unreadable, or is empty.
 */
export async function calculatePlanningArtifactIdentity(input: {
    directory: string;
    change: string;
    adapter: PlanningArtifactAdapter;
    /** Override the artifact loader (tests). */
    loadArtifacts?: (directory: string, change: string) => Promise<ImplementationArtifacts>;
}): Promise<string> {
    const artifacts = input.loadArtifacts
        ? await input.loadArtifacts(input.directory, input.change)
        : await loadImplementationArtifacts(input.directory, input.change, input.adapter);
    return planningIdentityFromArtifacts(input.change, artifacts);
}

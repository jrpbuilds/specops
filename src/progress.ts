/**
 * Lightweight deterministic-run progress publisher.
 *
 * Surfaces a compact summary of {@link RunState} to two channels — OpenCode's
 * metadata capability and a per-change `specops-progress.json` file — without
 * introducing a second canonical run-state format.
 */

import { writeFile } from "node:fs/promises"
import path from "node:path"
import type { RunState } from "./types.js"

/**
 * Minimal OpenCode metadata capability needed to surface deterministic
 * progress.
 */
export type MetadataContext = {
    /** Identifier of the OpenCode session this progress belongs to. */
    sessionID: string
    /**
     * Push a title and metadata blob into OpenCode's session surface.
     * @param input - Title and optional metadata record.
     */
    metadata(input: { title?: string; metadata?: Record<string, unknown> }): void
}

/**
 * Publish a compact UI status record without creating a second run-state
 * format. Updates OpenCode session metadata and writes a per-change
 * `specops-progress.json` snapshot.
 * @param context - OpenCode metadata capability used to surface the title.
 * @param directory - Project root directory.
 * @param change - Change identifier scoping the progress file.
 * @param state - The current deterministic run state to summarise.
 */
export async function publishProgress(
    context: MetadataContext,
    directory: string,
    change: string,
    state: RunState,
): Promise<void> {
    context.metadata({
        title: `SpecOps ${state.status} • ${change}`,
        metadata: {
            specops: {
                scopeTier: state.scopeTier,
                riskFacets: state.riskFacets,
                dispatches: state.dispatches.length,
                budgetUsage: state.budgetUsage,
            },
        },
    })
    await writeFile(
        path.join(directory, "openspec", "changes", change, "specops-progress.json"),
        `${JSON.stringify(
            {
                version: 1,
                state: state.status,
                scopeTier: state.scopeTier,
                dispatches: state.dispatches,
                updatedAt: state.updatedAt,
            },
            null,
            2,
        )}\n`,
    )
}

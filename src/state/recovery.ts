import { access, readdir } from "node:fs/promises";
import { calculateRepositoryIdentity, type RepositoryIdentity } from "../repository/identity.js";
import { invalidateValidationEvidence } from "../validation/evidence.js";
import { explorationPath, reviewPath, validationDirectory } from "./paths.js";
import { isTerminalRunStatus, type RunState } from "./schema.js";
import { readV1Run, updateV1Run } from "./store.js";

/** Adapter-shaped function used to inspect current OpenSpec change status during recovery. */
export type OpenSpecStatusReader<TStatus> = (change: string) => Promise<TStatus>;

/** Facts inspected at a coarse resume boundary. */
export type RecoveredRun<TStatus> = {
    state: RunState;
    repositoryIdentity: RepositoryIdentity;
    repositoryChanged: boolean;
    openSpecStatus: TStatus;
    artifacts: {
        exploration: boolean;
        review: boolean;
        validationEvidence: string[];
    };
};

/**
 * Recover a V1 run from its persisted stage without reconstructing model work.
 *
 * This checks current repository state, OpenSpec state, and already-written
 * artifacts. A mutation clears state identities and marks old evidence stale.
 */
export async function recoverV1Run<TStatus>(
    directory: string,
    change: string,
    readOpenSpecStatus: OpenSpecStatusReader<TStatus>,
): Promise<RecoveredRun<TStatus>> {
    const state = await readV1Run(directory, change);
    if (isTerminalRunStatus(state.status)) {
        throw new Error(`cannot resume terminal SpecOps V1 run (${state.status})`);
    }

    const [repositoryIdentity, openSpecStatus, artifacts] = await Promise.all([
        calculateRepositoryIdentity(directory),
        readOpenSpecStatus(change),
        inspectArtifacts(directory, change),
    ]);
    const repositoryChanged = repositoryIdentity !== state.currentRepositoryState;
    const recovered = repositoryChanged
        ? await updateV1Run(directory, change, current => ({
              ...current,
              currentRepositoryState: repositoryIdentity,
              validatedRepositoryState: null,
              reviewedRepositoryState: null,
          }))
        : state;

    if (repositoryChanged) {
        await invalidateValidationEvidence(directory, change, repositoryIdentity);
    }

    return {
        state: recovered,
        repositoryIdentity,
        repositoryChanged,
        openSpecStatus,
        artifacts,
    };
}

/** Inspect managed outputs without inferring or replaying their missing content. */
async function inspectArtifacts(
    directory: string,
    change: string,
): Promise<RecoveredRun<unknown>["artifacts"]> {
    const validation = await readdir(validationDirectory(directory, change)).catch(() => []);
    return {
        exploration: await exists(explorationPath(directory, change)),
        review: await exists(reviewPath(directory, change)),
        validationEvidence: validation.filter(file => file.endsWith(".json")).sort(),
    };
}

/** Return whether a managed artifact exists. */
async function exists(file: string): Promise<boolean> {
    return access(file).then(
        () => true,
        () => false,
    );
}

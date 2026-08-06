import { calculateRepositoryIdentity, type RepositoryIdentity } from "./identity.js";
import { summarizeChangedFiles, type ChangedFile } from "./changes.js";

/** Dirty-tree facts captured once when a V1 run begins. */
export type RepositoryBaseline = {
    identity: RepositoryIdentity;
    changedFiles: ChangedFile[];
    warning?: string;
};

/**
 * Capture the initial repository state without resetting, stashing, or
 * attributing pre-existing user changes to SpecOps.
 */
export async function captureRepositoryBaseline(directory: string): Promise<RepositoryBaseline> {
    const [identity, changedFiles] = await Promise.all([
        calculateRepositoryIdentity(directory),
        summarizeChangedFiles(directory),
    ]);
    return {
        identity,
        changedFiles,
        warning:
            changedFiles.length > 0
                ? "Repository has pre-existing changes. SpecOps will preserve them and will not claim they were created by this run."
                : undefined,
    };
}

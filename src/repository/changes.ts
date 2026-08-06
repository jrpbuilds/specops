import {
    calculateRepositoryIdentity,
    isRelevantPath,
    parseRepositoryStatus,
    type RepositoryIdentity,
    type RepositoryIdentityOptions,
} from "./identity.js"
import { runProcess } from "../process.js"

/** A changed implementation path grouped by Git's index and worktree status. */
export type ChangedFile = {
    path: string
    staged: boolean
    modified: boolean
    deleted: boolean
    untracked: boolean
}

/** Observed repository mutation at a coarse workflow boundary. */
export type RepositoryMutation = {
    previous: RepositoryIdentity
    current: RepositoryIdentity
    changed: boolean
    files: ChangedFile[]
}

/** Summarize relevant changed files without reading or modifying their contents. */
export async function summarizeChangedFiles(
    directory: string,
    options: RepositoryIdentityOptions = {},
): Promise<ChangedFile[]> {
    const run = options.run ?? runProcess
    const result = await run(
        "git",
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        directory,
        undefined,
        { PATH: process.env.PATH ?? "", NO_COLOR: "1" },
    )
    if (result.code !== 0) throw new Error(`git status failed: ${result.stderr}`)
    return parseRepositoryStatus(result.stdout)
        .filter(entry => isRelevantPath(entry.path, options.includeOpenSpecPlanning === true))
        .map(entry => ({
            path: entry.path,
            staged: entry.indexStatus !== " " && entry.indexStatus !== "?",
            modified:
                entry.indexStatus === "M" ||
                entry.worktreeStatus === "M" ||
                entry.worktreeStatus === "T",
            deleted: entry.indexStatus === "D" || entry.worktreeStatus === "D",
            untracked: entry.indexStatus === "?" && entry.worktreeStatus === "?",
        }))
        .sort((left, right) => left.path.localeCompare(right.path))
}

/** Compare a prior identity with the current boundary and include a file summary. */
export async function detectRepositoryMutation(
    directory: string,
    previous: RepositoryIdentity,
    options: RepositoryIdentityOptions = {},
): Promise<RepositoryMutation> {
    const current = await calculateRepositoryIdentity(directory, options)
    return {
        previous,
        current,
        changed: current !== previous,
        files: current === previous ? [] : await summarizeChangedFiles(directory, options),
    }
}

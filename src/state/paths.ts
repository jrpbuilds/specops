import path from "node:path"

/** Return the canonical root containing all SpecOps-owned V1 run state. */
export function runsRoot(directory: string): string {
    return path.resolve(directory, ".specops", "runs")
}

/** Validate a change name before it becomes part of a managed filesystem path. */
export function assertSafeChangeName(change: string): void {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(change)) {
        throw new Error(`unsafe SpecOps change name: ${change}`)
    }
}

/** Return the canonical state directory for one change without allowing traversal. */
export function runDirectory(directory: string, change: string): string {
    assertSafeChangeName(change)
    return resolveManagedPath(runsRoot(directory), change)
}

/** Return the canonical path for the explorer-owned report. */
export function explorationPath(directory: string, change: string): string {
    return resolveManagedPath(runDirectory(directory, change), "exploration.md")
}

/** Return the canonical path for the reviewer-owned report. */
export function reviewPath(directory: string, change: string): string {
    return resolveManagedPath(runDirectory(directory, change), "review.md")
}

/** Return the canonical path for the coarse run state. */
export function runStatePath(directory: string, change: string): string {
    return resolveManagedPath(runDirectory(directory, change), "run.json")
}

/** Return the canonical directory holding one validation command's evidence. */
export function validationDirectory(directory: string, change: string): string {
    return resolveManagedPath(runDirectory(directory, change), "validation")
}

/** Return the canonical path for a validation evidence record. */
export function validationEvidencePath(
    directory: string,
    change: string,
    commandId: string,
): string {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(commandId)) {
        throw new Error(`unsafe validation command id: ${commandId}`)
    }
    return resolveManagedPath(validationDirectory(directory, change), `${commandId}.json`)
}

/** Resolve a relative managed path and reject any attempt to escape its root. */
function resolveManagedPath(root: string, relative: string): string {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
        throw new Error("unsafe SpecOps managed path")
    }
    const target = path.resolve(root, relative)
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error("SpecOps managed path escaped its root")
    }
    return target
}

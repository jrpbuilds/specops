import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { RunState } from "../types.js"

/**
 * Return the controller-owned directory for one OpenSpec change.
 *
 * @param directory - The repository root.
 * @param change - The OpenSpec change id.
 * @returns The path `<directory>/openspec/changes/<change>`.
 */
export const changeRoot = (directory: string, change: string): string =>
    path.join(directory, "openspec", "changes", change)

/**
 * Atomically replace one text file after its parent directory exists.
 *
 * Creates the parent directory recursively, writes to a `.tmp` sibling, then
 * renames over the destination so concurrent readers never see a partial
 * file.
 *
 * @param destination - Absolute path of the final file.
 * @param content - UTF-8 text to write.
 * @returns Resolves when the rename has completed.
 */
async function atomicWrite(destination: string, content: string): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true })
    const temporary = `${destination}.tmp`
    await writeFile(temporary, content, "utf8")
    await rename(temporary, destination)
}

/**
 * Persist final-format state as the sole run-state record.
 *
 * Stamps `updatedAt` with the current ISO timestamp and writes the state as
 * pretty-printed JSON with a trailing newline to `specops-run.json` inside
 * the change directory.
 *
 * @param directory - The repository root.
 * @param change - The OpenSpec change id.
 * @param state - The run state to persist; mutated to set `updatedAt`.
 * @returns Resolves when the atomic write has completed.
 */
export async function writeRun(directory: string, change: string, state: RunState): Promise<void> {
    state.updatedAt = new Date().toISOString()
    await atomicWrite(
        path.join(changeRoot(directory, change), "specops-run.json"),
        `${JSON.stringify(state, null, 2)}\n`,
    )
}

/**
 * Read and validate the only supported run-state format.
 *
 * Reads `specops-run.json` from the change directory, parses it, and validates
 * all current state invariants including consistency between `status`,
 * `pauseReason`, `resumable`, `pendingQuestions`, and `outcome`. Only the
 * current run-state version is accepted; superseded versions and legacy field
 * shapes are rejected rather than migrated.
 *
 * @param directory - The repository root.
 * @param change - The OpenSpec change id.
 * @returns The parsed and validated {@link RunState}.
 * @throws If the file is missing or contains JSON that fails any invariant.
 */
export async function readRun(directory: string, change: string): Promise<RunState> {
    const raw: unknown = JSON.parse(
        await readFile(path.join(changeRoot(directory, change), "specops-run.json"), "utf8"),
    )

    if (
        !isCurrentRunStateShape(raw) ||
        raw.version !== 3 ||
        (raw.mode !== "interactive" && raw.mode !== "automatic") ||
        typeof raw.status !== "string" ||
        !["running", "paused", "passed", "blocked", "failed", "cancelled"].includes(raw.status)
    ) {
        throw new Error("invalid SpecOps run state")
    }
    const value = raw as RunState

    const validPauseReasons = new Set(["pending-question", "question-dismissed", "checkpoint"])

    switch (value.status) {
        case "running":
            if (value.pauseReason !== undefined) {
                throw new Error("running state must not have a pause reason")
            }
            if (value.resumable === true) {
                throw new Error("running state must not be resumable")
            }
            if (value.outcome !== undefined) {
                throw new Error("running state must not have a terminal outcome")
            }
            if (value.pendingCheckpoint) {
                throw new Error("running state must not have a pending checkpoint")
            }
            if (value.pendingQuestions) {
                throw new Error("running state must not have pending questions")
            }
            break

        case "paused":
            if (!value.pauseReason || !validPauseReasons.has(value.pauseReason)) {
                throw new Error(
                    "paused state requires a valid pause reason: " +
                        "pending-question, question-dismissed, or checkpoint",
                )
            }
            if (value.resumable !== true) {
                throw new Error("paused state must be resumable")
            }
            if (value.outcome !== undefined) {
                throw new Error("paused state must not have a terminal outcome")
            }
            if (value.pauseReason === "checkpoint") {
                if (!value.pendingCheckpoint) {
                    throw new Error("checkpoint-paused state requires a pending checkpoint")
                }
                if (value.pendingQuestions) {
                    throw new Error("checkpoint-paused state must not also have pending questions")
                }
            } else {
                if (!value.pendingQuestions || value.pendingQuestions.length === 0) {
                    throw new Error("question-paused state requires pending questions")
                }
                if (value.pendingCheckpoint) {
                    throw new Error("question-paused state must not also have a pending checkpoint")
                }
            }
            break

        case "passed":
        case "cancelled":
            if (value.pendingQuestions) {
                throw new Error(`terminal state (${value.status}) must not have pending questions`)
            }
            if (value.pendingCheckpoint) {
                throw new Error(
                    `terminal state (${value.status}) must not have a pending checkpoint`,
                )
            }
            if (value.resumable === true) {
                throw new Error(`terminal state (${value.status}) must not be resumable`)
            }
            if (!value.outcome) {
                throw new Error(`terminal state (${value.status}) requires an outcome`)
            }
            if (value.status === "passed" && value.outcome.category !== "completed") {
                throw new Error("passed state requires outcome category 'completed'")
            }
            if (value.status === "cancelled" && value.outcome.category !== "cancelled") {
                throw new Error("cancelled state requires outcome category 'cancelled'")
            }
            if (value.status === "passed" || value.status === "cancelled") break
        // fall through for blocked/failed:
        // eslint-disable-next-line no-fallthrough
        case "blocked":
        case "failed":
            if (value.pendingQuestions) {
                throw new Error(`terminal state (${value.status}) must not have pending questions`)
            }
            if (value.pendingCheckpoint) {
                throw new Error(
                    `terminal state (${value.status}) must not have a pending checkpoint`,
                )
            }
            if (value.resumable === true) {
                throw new Error(`terminal state (${value.status}) must not be resumable`)
            }
            if (!value.outcome) {
                throw new Error(`terminal state (${value.status}) requires an outcome`)
            }
            if (value.status === "blocked" && value.outcome.category !== "policy-blocked") {
                throw new Error("blocked state requires outcome category 'policy-blocked'")
            }
            if (
                value.status === "failed" &&
                !["validation-failed", "review-failed", "internal-error"].includes(
                    value.outcome.category as string,
                )
            ) {
                throw new Error(
                    "failed state requires outcome category " +
                        "'validation-failed', 'review-failed', or 'internal-error'",
                )
            }
            break
    }

    return value
}

/** Return whether a parsed run record has every required current-format collection and snapshot. */
function isCurrentRunStateShape(value: unknown): value is Record<string, unknown> {
    if (!isRecord(value)) return false
    if (
        !Array.isArray(value.reviewSubmissions) ||
        !Array.isArray(value.repairTasks) ||
        !Array.isArray(value.frontierHistory) ||
        !Array.isArray(value.questionHistory) ||
        !Array.isArray(value.checkpointHistory) ||
        !isRecord(value.frontierPolicy) ||
        !isRecord(value.frontierUsage) ||
        !isRecord(value.questionBudgetUsage)
    ) {
        return false
    }
    const policy = value.frontierPolicy
    const usage = value.frontierUsage
    const questionUsage = value.questionBudgetUsage
    return (
        (policy.mode === "disabled" || policy.mode === "adaptive") &&
        isNonNegativeInteger(policy.maxEscalationsPerRun) &&
        isNonNegativeInteger(policy.maxDispatchesPerRun) &&
        isNonNegativeInteger(policy.maxHighDispatchesPerRun) &&
        isNonNegativeInteger(usage.escalations) &&
        isNonNegativeInteger(usage.dispatches) &&
        isNonNegativeInteger(usage.highDispatches) &&
        isNonNegativeInteger(questionUsage.questionsRaised) &&
        isRecord(questionUsage.questionsByDispatch) &&
        isRecord(questionUsage.fingerprintCounts)
    )
}

/** Return whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Return whether a value is an integer counter that cannot be negative. */
function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0
}

/**
 * Persist a controller machine record with the same atomic-write boundary.
 *
 * Used for the context, evidence, and artifacts sidecar records that
 * accompany a run. Writes pretty-printed JSON with a trailing newline.
 *
 * @param directory - The repository root.
 * @param change - The OpenSpec change id.
 * @param file - The sidecar filename to write.
 * @param value - The record to serialise.
 * @returns Resolves when the atomic write has completed.
 */
export async function writeMachine(
    directory: string,
    change: string,
    file: "specops-context.json" | "specops-evidence.json" | "specops-artifacts.json",
    value: unknown,
): Promise<void> {
    await atomicWrite(
        path.join(changeRoot(directory, change), file),
        `${JSON.stringify(value, null, 2)}\n`,
    )
}

/**
 * Read a machine record, using a caller-provided empty value when absent.
 *
 * Returns the parsed contents of the sidecar file, or `fallback` if the file
 * is missing or unreadable. Unlike {@link readRun} this does no schema
 * validation — callers are responsible for the shape of `T`.
 *
 * @param directory - The repository root.
 * @param change - The OpenSpec change id.
 * @param file - The sidecar filename to read.
 * @param fallback - Value returned when the file is absent or unparseable.
 * @returns The parsed record typed as `T`, or `fallback`.
 */
export async function readMachine<T>(
    directory: string,
    change: string,
    file: "specops-context.json" | "specops-evidence.json" | "specops-artifacts.json",
    fallback: T,
): Promise<T> {
    try {
        return JSON.parse(
            await readFile(path.join(changeRoot(directory, change), file), "utf8"),
        ) as T
    } catch {
        return fallback
    }
}

/**
 * Persist a relative artifact path while rejecting every escape attempt.
 *
 * Guards against absolute paths, `..` segments, and any resolved target that
 * falls outside the change root before atomically writing the trimmed
 * content with a trailing newline.
 *
 * @param directory - The repository root.
 * @param change - The OpenSpec change id.
 * @param relative - The artifact path relative to the change root.
 * @param content - The artifact text to persist.
 * @returns Resolves when the atomic write has completed.
 * @throws If `relative` is absolute, contains a `..` segment, or resolves
 * outside the change root.
 */
export async function writeTextAtomic(
    directory: string,
    change: string,
    relative: string,
    content: string,
): Promise<void> {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
        throw new Error("unsafe artifact path")
    }
    const root = changeRoot(directory, change)
    const target = path.resolve(root, relative)
    if (!target.startsWith(`${root}${path.sep}`)) {
        throw new Error("artifact escaped change root")
    }
    await atomicWrite(target, `${content.trim()}\n`)
}

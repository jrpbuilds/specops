import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
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
async function atomicWritePhysical(destination: string, content: string): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true })
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(temporary, "wx")
    try {
        await handle.writeFile(content, "utf8")
        await handle.sync()
    } finally {
        await handle.close()
    }
    try {
        await rename(temporary, destination)
    } finally {
        await unlink(temporary).catch(() => undefined)
    }
}

/** Write through the active transaction when a controller mutation is running. */
async function atomicWrite(destination: string, content: string): Promise<void> {
    const transaction = transactionStorage.getStore()
    if (transaction) {
        await stageTransactionWrite(transaction, destination, content)
        return
    }
    await atomicWritePhysical(destination, content)
}

/** Hash persisted text for transaction integrity checks. */
function contentHash(content: string): string {
    return createHash("sha256").update(content).digest("hex")
}

/** Metadata persisted while a controller owns a run mutation lock. */
type RunLock = { token: string; pid: number; operation: string; acquiredAt: string }

const LOCK_STALE_MS = 30_000
const TRANSACTION_DIR = "specops-transaction"
const RUN_STATE_FILE = "specops-run.json"

type TransactionEntry = {
    destination: string
    staged: string
    hash: string
}

type TransactionManifest = {
    version: 1
    id: string
    status: "open" | "prepared"
    entries: TransactionEntry[]
}

type RunTransaction = {
    root: string
    directory: string
    manifest: TransactionManifest
    entries: Map<string, TransactionEntry>
}

const transactionStorage = new AsyncLocalStorage<RunTransaction>()

/** Execute one run mutation under an exclusive, recoverable filesystem lock. */
export async function withRunLock<T>(
    directory: string,
    change: string,
    operation: string,
    callback: () => Promise<T>,
): Promise<T> {
    const root = changeRoot(directory, change)
    await mkdir(root, { recursive: true })
    const lockPath = path.join(root, "specops-run.lock")
    const lock: RunLock = {
        token: randomUUID(),
        pid: process.pid,
        operation,
        acquiredAt: new Date().toISOString(),
    }
    let acquired = false
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await mkdir(lockPath)
            acquired = true
            await atomicWrite(path.join(lockPath, "owner.json"), `${JSON.stringify(lock)}\n`)
            break
        } catch (error) {
            if (acquired) {
                await rm(lockPath, { recursive: true, force: true })
                acquired = false
            }
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
            if (attempt === 1 || !(await reclaimDeadLock(lockPath))) {
                throw new Error(
                    `SpecOps run is busy: ${change} is being mutated; retry after ${operation}`,
                )
            }
        }
    }
    if (!acquired) throw new Error(`SpecOps could not acquire the run lock for ${change}`)
    try {
        await recoverTransactions(root)
        const transaction = await beginTransaction(root)
        return await transactionStorage.run(transaction, async () => {
            try {
                const result = await callback()
                await finishTransaction(transaction)
                return result
            } catch (error) {
                await finishTransaction(transaction)
                throw error
            }
        })
    } finally {
        try {
            const current = JSON.parse(
                await readFile(path.join(lockPath, "owner.json"), "utf8"),
            ) as Partial<RunLock>
            if (current.token === lock.token) await rm(lockPath, { recursive: true, force: true })
        } catch {
            // A recovered lock has already been removed; the mutation is still complete.
        }
    }
}

/**
 * Execute an archive mutation under a lock that is not inside the change
 * directory. OpenSpec moves that directory during archive, so a normal run
 * lock would move away from its owner and could not serialize concurrent
 * archive attempts safely.
 *
 * @param directory - The repository root.
 * @param change - The OpenSpec change id.
 * @param callback - Archive operation to execute exclusively.
 * @returns The callback result.
 */
export async function withArchiveLock<T>(
    directory: string,
    change: string,
    callback: () => Promise<T>,
): Promise<T> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(change)) {
        throw new Error("invalid OpenSpec change id")
    }
    const lockRoot = path.join(directory, "openspec", ".specops-archive-locks")
    const lockPath = path.join(lockRoot, `${change}.lock`)
    const lock: RunLock = {
        token: randomUUID(),
        pid: process.pid,
        operation: "archive change",
        acquiredAt: new Date().toISOString(),
    }
    await mkdir(lockRoot, { recursive: true })
    let acquired = false
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await mkdir(lockPath)
            acquired = true
            await atomicWritePhysical(
                path.join(lockPath, "owner.json"),
                `${JSON.stringify(lock)}\n`,
            )
            break
        } catch (error) {
            if (acquired) {
                await rm(lockPath, { recursive: true, force: true })
                acquired = false
            }
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
            if (attempt === 1 || !(await reclaimDeadLock(lockPath))) {
                throw new Error(`SpecOps archive is busy: ${change} is being archived`)
            }
        }
    }
    if (!acquired) throw new Error(`SpecOps could not acquire the archive lock for ${change}`)
    try {
        return await callback()
    } finally {
        try {
            const current = JSON.parse(
                await readFile(path.join(lockPath, "owner.json"), "utf8"),
            ) as Partial<RunLock>
            if (current.token === lock.token) await rm(lockPath, { recursive: true, force: true })
        } catch {
            // A recovered lock has already been removed; the archive remains complete.
        }
    }
}

/** Start a transaction whose writes remain invisible until the callback ends. */
async function beginTransaction(root: string): Promise<RunTransaction> {
    const id = randomUUID()
    const transactionRoot = path.join(root, TRANSACTION_DIR, id)
    const manifest: TransactionManifest = { version: 1, id, status: "open", entries: [] }
    await mkdir(transactionRoot, { recursive: true })
    await atomicWritePhysical(
        path.join(transactionRoot, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
    )
    return {
        root,
        directory: transactionRoot,
        manifest,
        entries: new Map(),
    }
}

/** Stage one destination write and keep the manifest durable as work progresses. */
async function stageTransactionWrite(
    transaction: RunTransaction,
    destination: string,
    content: string,
): Promise<void> {
    const relative = path.relative(transaction.root, destination)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("transaction destination escaped change root")
    }
    const staged = path.join(transaction.directory, "files", relative)
    await atomicWritePhysical(staged, content)
    const entry: TransactionEntry = {
        destination: relative,
        staged: path.relative(transaction.directory, staged),
        hash: contentHash(content),
    }
    transaction.entries.set(relative, entry)
    transaction.manifest.entries = [...transaction.entries.values()].sort((left, right) =>
        left.destination.localeCompare(right.destination),
    )
    await atomicWritePhysical(
        path.join(transaction.directory, "manifest.json"),
        `${JSON.stringify(transaction.manifest, null, 2)}\n`,
    )
}

/** Publish a prepared transaction idempotently, with run state last. */
async function publishTransaction(
    manifest: TransactionManifest,
    transactionRoot: string,
    root: string,
): Promise<void> {
    if (manifest.version !== 1 || !Array.isArray(manifest.entries)) {
        throw new Error("invalid SpecOps transaction manifest")
    }
    const entries = [...manifest.entries].sort(
        (left, right) =>
            Number(left.destination === RUN_STATE_FILE) -
                Number(right.destination === RUN_STATE_FILE) ||
            left.destination.localeCompare(right.destination),
    )
    for (const entry of entries) {
        const destination = path.join(root, entry.destination)
        const staged = path.join(transactionRoot, entry.staged)
        let currentHash: string | undefined
        try {
            currentHash = contentHash(await readFile(destination, "utf8"))
        } catch {
            // The destination may not have been published yet.
        }
        if (currentHash === entry.hash) continue
        let stagedContent: string
        try {
            stagedContent = await readFile(staged, "utf8")
        } catch {
            throw new Error(`transaction entry is missing: ${entry.destination}`)
        }
        if (contentHash(stagedContent) !== entry.hash) {
            throw new Error(`transaction entry hash mismatch: ${entry.destination}`)
        }
        await atomicWritePhysical(destination, stagedContent)
    }
}

/** Complete a transaction or discard an empty/uncommitted transaction. */
async function finishTransaction(transaction: RunTransaction): Promise<void> {
    if (transaction.entries.size === 0) {
        await rm(transaction.directory, { recursive: true, force: true })
        return
    }
    transaction.manifest.status = "prepared"
    await atomicWritePhysical(
        path.join(transaction.directory, "manifest.json"),
        `${JSON.stringify(transaction.manifest, null, 2)}\n`,
    )
    await publishTransaction(transaction.manifest, transaction.directory, transaction.root)
    await rm(transaction.directory, { recursive: true, force: true })
}

/** Recover prepared transactions left by a process that died during publication. */
async function recoverTransactions(root: string): Promise<void> {
    const transactionsRoot = path.join(root, TRANSACTION_DIR)
    let names: string[]
    try {
        names = await readdir(transactionsRoot)
    } catch {
        return
    }
    for (const name of names.sort()) {
        const transactionRoot = path.join(transactionsRoot, name)
        const manifestPath = path.join(transactionRoot, "manifest.json")
        let manifest: TransactionManifest
        try {
            manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TransactionManifest
        } catch {
            const stagedFiles = await readdir(path.join(transactionRoot, "files")).catch(() => [])
            if (stagedFiles.length === 0) {
                await rm(transactionRoot, { recursive: true, force: true })
                continue
            }
            throw new Error(`SpecOps transaction manifest is unreadable: ${name}`)
        }
        if (manifest.status === "open") {
            await rm(transactionRoot, { recursive: true, force: true })
            continue
        }
        await publishTransaction(manifest, transactionRoot, root)
        await rm(transactionRoot, { recursive: true, force: true })
    }
    await rm(transactionsRoot, { recursive: true, force: true })
}

/** Reclaim only a sufficiently old lock whose owner is gone or malformed. */
async function reclaimDeadLock(lockPath: string): Promise<boolean> {
    let lockStat
    try {
        lockStat = await stat(lockPath)
    } catch {
        return false
    }

    if (Date.now() - lockStat.mtimeMs < LOCK_STALE_MS) return false

    let owner: Partial<RunLock> | undefined
    try {
        owner = JSON.parse(
            await readFile(path.join(lockPath, "owner.json"), "utf8"),
        ) as Partial<RunLock>
    } catch {
        // An owner file may be absent or malformed if the process died during acquisition.
    }

    if (owner?.pid !== undefined) {
        try {
            process.kill(owner.pid, 0)
            return false
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false
        }
    }

    const quarantine = `${lockPath}.reclaim-${randomUUID()}`
    try {
        await rename(lockPath, quarantine)
    } catch {
        return false
    }
    await rm(quarantine, { recursive: true, force: true })
    return true
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
    state.schedulerHistory ??= []
    const destination = path.join(changeRoot(directory, change), "specops-run.json")
    let currentRevision = -1
    try {
        const current = JSON.parse(await readFile(destination, "utf8")) as { revision?: unknown }
        if (typeof current.revision === "number") currentRevision = current.revision
    } catch {
        // A newly-created run has no persisted revision yet.
    }
    if (currentRevision >= 0 && state.revision !== currentRevision) {
        throw new Error(
            `SpecOps run revision conflict: expected ${state.revision}, found ${currentRevision}`,
        )
    }
    state.revision = currentRevision < 0 ? (state.revision ?? 0) : currentRevision + 1
    state.updatedAt = new Date().toISOString()
    await atomicWrite(destination, `${JSON.stringify(state, null, 2)}\n`)
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
        raw.version !== 7 ||
        !isNonNegativeInteger(raw.revision) ||
        (raw.mode !== "interactive" && raw.mode !== "automatic") ||
        typeof raw.status !== "string" ||
        !["running", "paused", "passed", "blocked", "failed", "cancelled"].includes(raw.status)
    ) {
        const version = isRecord(raw) ? String(raw.version ?? "missing") : "unreadable"
        throw new Error(
            `invalid SpecOps run state (expected version 7 with a numeric revision; found ${version})`,
        )
    }
    const value = raw as RunState

    if (value.archivePending !== undefined) {
        const pending = value.archivePending
        if (
            !isRecord(pending) ||
            typeof pending.id !== "string" ||
            !UUID_PATTERN.test(pending.id) ||
            !isScopeTier(pending.scopeTier) ||
            !isIsoTimestamp(pending.raisedAt)
        ) {
            throw new Error("invalid SpecOps archive confirmation state")
        }
        if (value.status !== "passed") {
            throw new Error("archive confirmation may only be pending for a passed run")
        }
    }
    if (value.archiveError !== undefined) {
        const failure = value.archiveError
        if (
            !isRecord(failure) ||
            !isPositiveInteger(failure.attempt) ||
            typeof failure.message !== "string" ||
            !failure.message.trim() ||
            failure.message.length > 2_000 ||
            !isIsoTimestamp(failure.at)
        ) {
            throw new Error("invalid SpecOps archive error state")
        }
        if (value.status !== "passed") {
            throw new Error("archive errors may only be recorded for a passed run")
        }
    }

    const issuedCount = value.dispatches.filter(dispatch => dispatch.status === "issued").length
    if (issuedCount > 1) {
        throw new Error(
            `invalid SpecOps run state: ${issuedCount} issued dispatches found; maximum is 1`,
        )
    }
    if (value.status !== "running" && value.status !== "paused" && issuedCount > 0) {
        throw new Error(`invalid SpecOps run state: terminal state ${value.status} has issued work`)
    }

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
        !Array.isArray(value.schedulerHistory) ||
        !isRecord(value.budgetUsage) ||
        !isConfidenceProfile(value.confidence) ||
        !isRecord(value.frontierPolicy) ||
        !isRecord(value.frontierUsage)
    ) {
        return false
    }
    const policy = value.frontierPolicy
    const usage = value.frontierUsage
    const budgets = value.budgetUsage
    return (
        Object.values(budgets).every(isNonNegativeInteger) &&
        Array.isArray(value.dispatches) &&
        value.dispatches.every(
            item =>
                isRecord(item) &&
                typeof item.id === "string" &&
                typeof item.inputHash === "string" &&
                ["issued", "completed", "failed"].includes(String(item.status)),
        ) &&
        (policy.mode === "disabled" || policy.mode === "adaptive") &&
        isNonNegativeInteger(policy.maxEscalationsPerRun) &&
        isNonNegativeInteger(policy.maxDispatchesPerRun) &&
        isNonNegativeInteger(policy.maxHighDispatchesPerRun) &&
        isNonNegativeInteger(usage.escalations) &&
        isNonNegativeInteger(usage.dispatches) &&
        isNonNegativeInteger(usage.highDispatches)
    )
}

/** Return whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Return whether a persisted run has the complete current confidence profile. */
function isConfidenceProfile(value: unknown): boolean {
    if (!isRecord(value)) return false
    return ["requirements", "repository", "design", "implementation", "verification"].every(
        key => value[key] === "low" || value[key] === "medium" || value[key] === "high",
    )
}

/** Return whether a value is an integer counter that cannot be negative. */
function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0
}

/** UUID format used for persisted confirmation ids. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Return whether a persisted scope tier is one of the supported values. */
function isScopeTier(value: unknown): value is RunState["scopeTier"] {
    return value === "lean" || value === "standard" || value === "full"
}

/** Return whether a value is an ISO-8601 timestamp. */
function isIsoTimestamp(value: unknown): value is string {
    return typeof value === "string" && !Number.isNaN(Date.parse(value))
}

/** Return whether a value is a strictly positive integer. */
function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0
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

import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { RunState } from "../types.js"
import { writeFileAtomic } from "./atomic.js"

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
/** Write through the active transaction when a controller mutation is running. */
async function atomicWrite(destination: string, content: string): Promise<void> {
    const transaction = transactionStorage.getStore()
    if (transaction) {
        await stageTransactionWrite(transaction, destination, content)
        return
    }
    await writeFileAtomic(destination, content)
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
const RUN_LOCK_DIR = ".specops-run-locks"

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

/** Execute a callback under the stable lock shared by run and archive mutations. */
async function withExternalRunLock<T>(
    directory: string,
    change: string,
    operation: string,
    callback: () => Promise<T>,
): Promise<T> {
    const lockRoot = path.join(directory, "openspec", RUN_LOCK_DIR)
    const lockPath = path.join(lockRoot, `${change}.lock`)
    await mkdir(lockRoot, { recursive: true })
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
        return await callback()
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

/** Execute an existing-run mutation with transactional writes and no root creation. */
export async function withRunLock<T>(
    directory: string,
    change: string,
    operation: string,
    callback: () => Promise<T>,
): Promise<T> {
    const root = changeRoot(directory, change)
    return withExternalRunLock(directory, change, operation, async () => {
        try {
            const rootStat = await stat(root)
            if (!rootStat.isDirectory())
                throw new Error(`SpecOps active run is not a directory: ${change}`)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                throw new Error(`SpecOps active run is missing: ${change}`)
            }
            throw error
        }

        await recoverTransactions(root)
        const transaction = await beginTransaction(root)
        return transactionStorage.run(transaction, async () => {
            try {
                const result = await callback()
                await finishTransaction(transaction)
                return result
            } catch (error) {
                await finishTransaction(transaction)
                throw error
            }
        })
    })
}

/** Execute an archive mutation while excluding all normal run transactions. */
export async function withRunMutationLock<T>(
    directory: string,
    change: string,
    callback: () => Promise<T>,
): Promise<T> {
    return withExternalRunLock(directory, change, "archive mutation", async () => {
        await recoverTransactions(changeRoot(directory, change))
        return callback()
    })
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
            await writeFileAtomic(path.join(lockPath, "owner.json"), `${JSON.stringify(lock)}\n`)
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

/**
 * Stable recovery record written before invoking `openspec archive`.
 *
 * The state file moves with the change directory during archive, so it cannot
 * serve as its own recovery source. This sidecar lives at a fixed path under
 * `openspec/` (independent of the change directory) and records the exact run
 * identity expected in the moved state so crash recovery can verify a
 * candidate archive unambiguously rather than selecting by filename alone.
 */
export type ArchiveAttemptRecord = {
    /** The expected archive entry name (a hint; the CLI does not accept a target). */
    expectedArchivedAs: string
    /** Run revision expected in the moved state file. */
    runRevision: number
    /** Run creation timestamp expected in the moved state file. */
    runCreatedAt: string
    /** Run baseline expected in the moved state file. */
    runBaseline: string
    /** When the archive attempt was recorded. */
    attemptAt: string
}

const ARCHIVE_ATTEMPT_DIR = ".specops-archive-attempt"

function archiveAttemptPath(directory: string, change: string): string {
    return path.join(directory, "openspec", ARCHIVE_ATTEMPT_DIR, `${change}.json`)
}

/**
 * Atomically persist the archive-attempt recovery record before archiving.
 *
 * @param directory - Repository root containing the `openspec/` tree.
 * @param change - OpenSpec change identifier about to be archived.
 * @param record - Recovery identity for this attempt.
 */
export async function writeArchiveAttemptSidecar(
    directory: string,
    change: string,
    record: ArchiveAttemptRecord,
): Promise<void> {
    const destination = archiveAttemptPath(directory, change)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFileAtomic(destination, `${JSON.stringify(record, null, 2)}\n`)
}

/**
 * Read the archive-attempt recovery record, or `undefined` if absent.
 *
 * @param directory - Repository root containing the `openspec/` tree.
 * @param change - OpenSpec change identifier.
 * @returns The persisted record, or `undefined` when no attempt is in flight.
 */
export async function readArchiveAttemptSidecar(
    directory: string,
    change: string,
): Promise<ArchiveAttemptRecord | undefined> {
    try {
        const content = await readFile(archiveAttemptPath(directory, change), "utf8")
        const value = JSON.parse(content) as Partial<ArchiveAttemptRecord>
        if (
            typeof value.expectedArchivedAs !== "string" ||
            typeof value.runRevision !== "number" ||
            typeof value.runCreatedAt !== "string" ||
            typeof value.runBaseline !== "string" ||
            typeof value.attemptAt !== "string"
        ) {
            throw new Error("invalid SpecOps archive attempt sidecar")
        }
        return value as ArchiveAttemptRecord
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        return undefined
    }
}

/**
 * Best-effort removal of the archive-attempt recovery record.
 *
 * Called after a terminal archive outcome. Deletion failure is tolerated: a
 * stale record is harmless to a completed archive and is cleaned up by a later
 * recovery or maintenance pass.
 *
 * @param directory - Repository root containing the `openspec/` tree.
 * @param change - OpenSpec change identifier.
 */
export async function deleteArchiveAttemptSidecar(
    directory: string,
    change: string,
): Promise<void> {
    try {
        await unlink(archiveAttemptPath(directory, change))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
}

/** Start a transaction whose writes remain invisible until the callback ends. */
async function beginTransaction(root: string): Promise<RunTransaction> {
    const id = randomUUID()
    const transactionRoot = path.join(root, TRANSACTION_DIR, id)
    const manifest: TransactionManifest = { version: 1, id, status: "open", entries: [] }
    await mkdir(transactionRoot, { recursive: true })
    await writeFileAtomic(
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
    await writeFileAtomic(staged, content)
    const entry: TransactionEntry = {
        destination: relative,
        staged: path.relative(transaction.directory, staged),
        hash: contentHash(content),
    }
    transaction.entries.set(relative, entry)
    transaction.manifest.entries = [...transaction.entries.values()].sort((left, right) =>
        left.destination.localeCompare(right.destination),
    )
    await writeFileAtomic(
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
        await writeFileAtomic(destination, stagedContent)
    }
}

/** Complete a transaction or discard an empty/uncommitted transaction. */
async function finishTransaction(transaction: RunTransaction): Promise<void> {
    if (transaction.entries.size === 0) {
        await rm(transaction.directory, { recursive: true, force: true })
        return
    }
    transaction.manifest.status = "prepared"
    await writeFileAtomic(
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
    await writeRunIn(changeRoot(directory, change), state)
}

/**
 * Persist final-format state to an explicit change directory.
 *
 * Used after `openspec archive` moves the change directory: the active path is
 * gone and the state file now lives under the archived directory, so the
 * caller passes the directory returned by the archive command.
 *
 * @param changeDir - Absolute change directory containing `specops-run.json`.
 * @param state - The run state to persist; mutated to set `updatedAt`.
 * @returns Resolves when the atomic write has completed.
 */
export async function writeRunIn(changeDir: string, state: RunState): Promise<void> {
    state.schedulerHistory ??= []
    const destination = path.join(changeDir, "specops-run.json")
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
    validateRunState(state)
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
    return readRunIn(changeRoot(directory, change))
}

/**
 * Read and validate run state from an explicit change directory.
 *
 * Used by archive recovery after `openspec archive` moves the change directory;
 * the caller passes the active or archived directory it has resolved.
 *
 * @param changeDir - Absolute change directory containing `specops-run.json`.
 * @returns The parsed and validated {@link RunState}.
 * @throws If the file is missing or contains JSON that fails any invariant.
 */
export async function readRunIn(changeDir: string): Promise<RunState> {
    const raw: unknown = JSON.parse(
        await readFile(path.join(changeDir, "specops-run.json"), "utf8"),
    )

    return validateRunState(raw)
}

/** Validate the current persisted run-state shape and all status invariants. */
function validateRunState(raw: unknown): RunState {
    if (
        !isCurrentRunStateShape(raw) ||
        raw.version !== 7 ||
        !isNonNegativeInteger(raw.revision) ||
        (raw.mode !== "interactive" && raw.mode !== "automatic") ||
        typeof raw.status !== "string" ||
        ![
            "running",
            "paused",
            "passed",
            "archiving",
            "completed",
            "archive_failed",
            "blocked",
            "failed",
            "cancelled",
        ].includes(raw.status)
    ) {
        const version = isRecord(raw) ? String(raw.version ?? "missing") : "unreadable"
        throw new Error(
            `invalid SpecOps run state (expected version 7 with a numeric revision; found ${version})`,
        )
    }
    const value = raw as RunState

    if (value.archivedAt !== undefined) {
        if (!isIsoTimestamp(value.archivedAt)) {
            throw new Error("invalid SpecOps archive timestamp")
        }
        if (value.status !== "completed") {
            throw new Error("archivedAt may only be set on a completed run")
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
            !isIsoTimestamp(failure.at) ||
            typeof failure.kind !== "string" ||
            !ARCHIVE_ERROR_KINDS.has(failure.kind)
        ) {
            throw new Error("invalid SpecOps archive error state")
        }
        if (value.status !== "archive_failed") {
            throw new Error("archive errors may only be recorded for an archive_failed run")
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
        case "archiving":
        case "completed":
        case "archive_failed":
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
            if (value.outcome.category !== "completed" && value.status !== "cancelled") {
                throw new Error(`${value.status} state requires outcome category 'completed'`)
            }
            if (value.status === "cancelled" && value.outcome.category !== "cancelled") {
                throw new Error("cancelled state requires outcome category 'cancelled'")
            }
            if (value.status === "archiving" && value.archiveError !== undefined) {
                throw new Error("archiving state must not carry an archive error")
            }
            if (value.status === "archiving" && value.archivedAt !== undefined) {
                throw new Error("archiving state must not be marked archived")
            }
            if (value.status === "completed" && value.archiveError !== undefined) {
                throw new Error("completed state must not carry an archive error")
            }
            if (value.status === "archive_failed" && value.archiveError === undefined) {
                throw new Error("archive_failed state requires an archive error")
            }
            if (value.status === "archive_failed" && value.archivedAt !== undefined) {
                throw new Error("archive_failed state must not be marked archived")
            }
            if (value.status === "passed" && value.archiveError !== undefined) {
                throw new Error("passed state must not carry an archive error")
            }
            if (value.status === "passed" && value.archivedAt !== undefined) {
                throw new Error("passed state must not be marked archived")
            }
            if (
                value.status === "passed" ||
                value.status === "archiving" ||
                value.status === "completed" ||
                value.status === "archive_failed" ||
                value.status === "cancelled"
            )
                break
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

/** Allowed structured archive failure categories. */
const ARCHIVE_ERROR_KINDS = new Set([
    "incomplete_tasks",
    "invalid_tasks_artifact",
    "invalid_artifact",
    "invalid_archive_result",
    "command_failed",
    "path_conflict",
    "missing_change",
    "already_archived",
])

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

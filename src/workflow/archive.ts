import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { SpecOpsConfig } from "../config.js";
import { collectDiff } from "../git.js";
import { archiveChange, countIncompleteTasks } from "../openspec.js";
import {
    changeRoot,
    withArchiveLock,
    withRunMutationLock,
    readRunIn,
    writeRunIn,
    deleteArchiveAttemptSidecar,
    readArchiveAttemptSidecar,
    writeArchiveAttemptSidecar,
    type ArchiveAttemptRecord,
} from "../state/store.js";
import { hash } from "../artifacts/lifecycle.js";
import { redactSensitiveText } from "../security/redact.js";
import { ARTIFACT_FILES } from "./artifacts.js";
import type { ArtifactId, RunState } from "../types.js";

/**
 * Structured archive failure category, mirroring {@link RunState}'s
 * `archiveError.kind`.
 */
type ArchiveErrorKind = NonNullable<NonNullable<RunState["archiveError"]>["kind"]>;

/**
 * Archive a completed (verified) OpenSpec change as a first-class finalization
 * operation, governed by the resolved config.
 *
 * Acquires the archive lock (a stable, change-named lock that is not inside the
 * change directory, so it survives the OpenSpec directory move), resolves
 * whether the change is still active or already archived (crash recovery),
 * validates the deterministic preconditions, then writes a stable recovery
 * sidecar before persisting `archiving` and invoking `openspec archive`.
 *
 * The state file lives inside the change directory and moves with it; after a
 * successful archive the completed state is written to the archived path
 * returned by the OpenSpec CLI. A crash between the move and that write is
 * recovered on the next call by resolving the archived candidate from the
 * sidecar and verifying run identity from the moved `specops-run.json`.
 *
 * @param directory - Project root directory.
 * @param change - OpenSpec change identifier to archive.
 * @param config - Resolved config used to locate the OpenSpec binary.
 * @returns The finalized {@link RunState} (`completed` on success,
 *   `archive_failed` with a retryable `archiveError` on failure).
 */
export async function archiveCompletedRun(
    directory: string,
    change: string,
    config: SpecOpsConfig,
): Promise<RunState> {
    return withArchiveLock(directory, change, () =>
        withRunMutationLock(directory, change, async () => {
            const activeDir = changeRoot(directory, change);
            const archiveDir = path.join(directory, "openspec", "changes", "archive");

            let activeState: RunState;
            try {
                activeState = await readRunIn(activeDir);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
                return recoverArchivedRun(directory, change, archiveDir);
            }

            if (activeState.status === "completed" && activeState.archivedAt) {
                return activeState;
            }

            assertArchiveEligible(change, activeState);
            const archiveCandidates = await listArchiveCandidates(archiveDir, change);
            if (archiveCandidates.length > 0) {
                return recordArchiveFailureAt(
                    activeDir,
                    "path_conflict",
                    `Change '${change}' has both an active directory and an existing archive entry; resolve the conflict before archiving.`,
                );
            }
            return archiveFromActive(directory, change, config, activeDir, activeState);
        }),
    );
}

/**
 * Perform the archive from the still-present active change directory.
 *
 * Validates preconditions, writes the recovery sidecar, persists `archiving`,
 * invokes the OpenSpec archive command, and writes the final `completed` state
 * at the archived path on success or `archive_failed` at the active path on
 * failure.
 */
async function archiveFromActive(
    directory: string,
    change: string,
    config: SpecOpsConfig,
    activeDir: string,
    state: RunState,
): Promise<RunState> {
    assertArchiveEligible(change, state);

    const incompleteTasks = await countIncompleteTasks(directory, change);
    if (incompleteTasks > 0) {
        return recordArchiveFailureAt(
            activeDir,
            "incomplete_tasks",
            `SpecOps archive: ${incompleteTasks} incomplete task(s) remain; complete them before archiving`,
        );
    }

    const artifactFailure = await validateArchiveArtifacts(
        directory,
        change,
        state,
        config.review.maxDiffBytes,
    );
    if (artifactFailure) {
        return recordArchiveFailureAt(activeDir, "invalid_artifact", artifactFailure);
    }

    const priorSidecar =
        state.status === "archiving"
            ? await readArchiveAttemptSidecar(directory, change)
            : undefined;
    const expectedArchivedAs =
        priorSidecar?.expectedArchivedAs ?? computeExpectedArchiveName(change);
    const now = new Date().toISOString();
    const nextRevision = state.revision + 1;

    // Strict write order: sidecar first (the independent identity record), then
    // the `archiving` state, then the archive command. The sidecar stores the
    // exact identity of the state that will be persisted, so crash recovery can
    // verify a moved candidate by identity rather than by filename alone.
    const sidecar: ArchiveAttemptRecord = {
        expectedArchivedAs,
        runRevision: nextRevision,
        runCreatedAt: state.createdAt,
        runBaseline: state.baseline,
        attemptAt: now,
    };
    await writeArchiveAttemptSidecar(directory, change, sidecar);

    const archivingState: RunState = { ...state, status: "archiving", archiveError: undefined };
    await writeRunIn(activeDir, archivingState);

    let result;
    try {
        result = await archiveChange(directory, config, change, state.scopeTier === "lean");
    } catch (error) {
        return handleArchiveAttemptFailure(
            directory,
            change,
            activeDir,
            "command_failed",
            String(error),
            sidecar,
            state.archiveError?.attempt ?? 0,
        );
    }

    if (result.code !== 0) {
        const output =
            result.stderr || result.stdout || `OpenSpec archive exited with code ${result.code}`;
        const kind = /already exists|archive_target_exists/i.test(output)
            ? "path_conflict"
            : "command_failed";
        return handleArchiveAttemptFailure(
            directory,
            change,
            activeDir,
            kind,
            output,
            sidecar,
            state.archiveError?.attempt ?? 0,
        );
    }

    const archiveResult = parseArchiveResult(result.stdout);
    if (!archiveResult) {
        return handleArchiveAttemptFailure(
            directory,
            change,
            activeDir,
            "invalid_archive_result",
            "OpenSpec archive succeeded but returned no archive location",
            sidecar,
            state.archiveError?.attempt ?? 0,
        );
    }

    try {
        const archivePath = await validateArchiveResultPath(
            directory,
            change,
            archiveResult,
            sidecar,
        );
        return completeArchivedCandidate(directory, change, archivePath, sidecar);
    } catch (error) {
        return handleArchiveAttemptFailure(
            directory,
            change,
            activeDir,
            "invalid_archive_result",
            String(error),
            sidecar,
            state.archiveError?.attempt ?? 0,
        );
    }
}

/**
 * Recover an `archiving` run whose active directory was already moved by a
 * crash before its `completed` state was written.
 *
 * Selects an archived candidate only when the recovery sidecar verifies the
 * moved state identity. The current run-state schema has no persisted change
 * identifier, so a missing sidecar cannot be replaced by filename matching.
 */
async function recoverArchivedRun(
    directory: string,
    change: string,
    archiveDir: string,
): Promise<RunState> {
    const sidecar = await readArchiveAttemptSidecar(directory, change);
    const candidates = await listArchiveCandidates(archiveDir, change);

    if (!sidecar) {
        throw new Error(
            `SpecOps archive: recovery identity is unavailable for '${change}'; no archived archiving state was changed`,
        );
    }

    const matches: Array<{ path: string; state: RunState }> = [];
    for (const candidate of candidates) {
        if (path.basename(candidate) !== sidecar.expectedArchivedAs) continue;
        let state: RunState;
        try {
            const canonical = await canonicalArchiveCandidate(archiveDir, candidate);
            state = await readRunIn(canonical);
            if (!matchesIdentity(state, sidecar)) continue;
            matches.push({ path: canonical, state });
        } catch {
            // A candidate directory without a valid run state cannot be this run.
            continue;
        }
    }

    if (matches.length === 0) {
        throw new Error(
            `SpecOps archive: no archived candidate matches the recovery identity for '${change}'; inspect the archive before retrying`,
        );
    }
    if (matches.length > 1) {
        return throwPathConflict(
            `SpecOps archive: multiple archived candidates match run '${change}'; resolve manually before completing`,
        );
    }

    return completeArchivedCandidate(directory, change, matches[0]!.path, sidecar);
}

/** Return whether a run state is a valid source for an archive attempt. */
function isArchiveEligible(state: RunState): boolean {
    return (
        state.status === "passed" ||
        state.status === "archiving" ||
        state.status === "archive_failed" ||
        (state.status === "completed" && state.archivedAt === undefined)
    );
}

/** Reject archive attempts that would mutate an active workflow state. */
function assertArchiveEligible(change: string, state: RunState): void {
    if (isArchiveEligible(state)) return;
    throw new Error(
        `SpecOps archive: run '${change}' is ${state.status}, not archivable; only passed, archiving, archive_failed, or completed-unarchived runs can be archived.`,
    );
}

/** Verify the moved run still represents the sidecar's archive attempt. */
function matchesIdentity(state: RunState, sidecar: ArchiveAttemptRecord): boolean {
    return (
        state.revision === sidecar.runRevision &&
        state.createdAt === sidecar.runCreatedAt &&
        state.baseline === sidecar.runBaseline
    );
}

/** Complete one identity-verified archived candidate and clean the sidecar best-effort. */
async function completeArchivedCandidate(
    directory: string,
    change: string,
    archivePath: string,
    sidecar: ArchiveAttemptRecord,
): Promise<RunState> {
    const archivedState = await readRunIn(archivePath);
    if (!matchesIdentity(archivedState, sidecar)) {
        throw new Error(`SpecOps archive: archived state identity does not match '${change}'`);
    }
    if (archivedState.status === "completed" && archivedState.archivedAt) {
        await deleteArchiveAttemptSidecar(directory, change).catch(() => {});
        return archivedState;
    }
    if (archivedState.status !== "archiving") {
        throw new Error(
            `SpecOps archive: archived candidate for '${change}' is ${archivedState.status}`,
        );
    }
    const completedState: RunState = {
        ...archivedState,
        status: "completed",
        archivedAt: new Date().toISOString(),
        archiveError: undefined,
    };
    await writeRunIn(archivePath, completedState);
    await deleteArchiveAttemptSidecar(directory, change).catch(() => {});
    return completedState;
}

/** Complete a failure only when the active source remains available. */
async function handleArchiveAttemptFailure(
    directory: string,
    change: string,
    activeDir: string,
    kind: ArchiveErrorKind,
    message: string,
    sidecar: ArchiveAttemptRecord,
    previousAttempt: number,
): Promise<RunState> {
    const recovered = await tryRecoverArchivedCandidate(directory, change, sidecar);
    if (recovered) return recovered;

    try {
        await stat(path.join(activeDir, "specops-run.json"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(
                `SpecOps archive: archive outcome is ambiguous for '${change}'; recovery sidecar retained for retry`,
            );
        }
        throw error;
    }

    const failed = await recordArchiveFailureAt(activeDir, kind, message, previousAttempt);
    await deleteArchiveAttemptSidecar(directory, change).catch(() => {});
    return failed;
}

/** Find and complete an exact sidecar-identified candidate after an uncertain command result. */
async function tryRecoverArchivedCandidate(
    directory: string,
    change: string,
    sidecar: ArchiveAttemptRecord,
): Promise<RunState | undefined> {
    const archiveDir = path.join(directory, "openspec", "changes", "archive");
    const candidates = await listArchiveCandidates(archiveDir, change);
    for (const candidate of candidates) {
        if (path.basename(candidate) !== sidecar.expectedArchivedAs) continue;
        try {
            const canonical = await canonicalArchiveCandidate(archiveDir, candidate);
            const state = await readRunIn(canonical);
            if (!matchesIdentity(state, sidecar)) continue;
            return completeArchivedCandidate(directory, change, canonical, sidecar);
        } catch {
            // Continue searching without mutating a candidate that failed identity checks.
        }
    }
    return undefined;
}

/** Ensure a candidate resolves inside the canonical archive directory. */
async function canonicalArchiveCandidate(archiveDir: string, candidate: string): Promise<string> {
    const root = await realpath(archiveDir);
    const resolved = await realpath(candidate);
    if (!isContainedPath(root, resolved) || path.dirname(resolved) !== root) {
        throw new Error("SpecOps archive: archive candidate escaped the archive directory");
    }
    return resolved;
}

/** Verify that a resolved path is within a directory without accepting the directory itself. */
function isContainedPath(root: string, target: string): boolean {
    return target.startsWith(`${root}${path.sep}`);
}

/**
 * Record an `archive_failed` state at the active path and return it.
 *
 * @param activeDir - Active change directory (still present).
 * @param kind - Structured failure category.
 * @param message - Human-readable failure detail.
 * @param prevAttempt - Previous attempt counter for incrementing.
 * @returns The persisted `archive_failed` state.
 */
async function recordArchiveFailureAt(
    activeDir: string,
    kind: ArchiveErrorKind,
    message: string,
    prevAttempt = 0,
): Promise<RunState> {
    const state = await readRunIn(activeDir);
    const previousAttempt = Math.max(prevAttempt, state.archiveError?.attempt ?? 0);
    state.status = "archive_failed";
    state.archiveError = {
        attempt: previousAttempt + 1,
        kind,
        message: redactSensitiveText(message).slice(0, 2_000),
        at: new Date().toISOString(),
    };
    await writeRunIn(activeDir, state);
    return state;
}

/** Validate the CLI path and archive name before any moved state is accessed. */
async function validateArchiveResultPath(
    directory: string,
    change: string,
    result: { path: string; archivedAs: string },
    sidecar: ArchiveAttemptRecord,
): Promise<string> {
    if (result.archivedAs !== sidecar.expectedArchivedAs) {
        throw new Error(
            `SpecOps archive: archivedAs '${result.archivedAs}' does not match expected '${sidecar.expectedArchivedAs}' for '${change}'`,
        );
    }
    if (result.path.split(/[\\/]/).includes("..")) {
        throw new Error("SpecOps archive: archive result path contains traversal");
    }

    const archiveDir = path.resolve(directory, "openspec", "changes", "archive");
    const canonicalRoot = await realpath(archiveDir);
    const requested = path.isAbsolute(result.path)
        ? path.resolve(result.path)
        : path.resolve(directory, result.path);
    if (!isContainedPath(canonicalRoot, requested)) {
        throw new Error("SpecOps archive: archive result path escaped the archive directory");
    }
    const canonical = await realpath(requested);
    if (!isContainedPath(canonicalRoot, canonical) || path.dirname(canonical) !== canonicalRoot) {
        throw new Error("SpecOps archive: archive result path escaped the archive directory");
    }
    if (path.basename(canonical) !== result.archivedAs) {
        throw new Error("SpecOps archive: archive result basename disagrees with archivedAs");
    }
    return canonical;
}

/** Resolve and hash every required artifact immediately before archive movement. */
async function validateArchiveArtifacts(
    directory: string,
    change: string,
    state: RunState,
    maxDiffBytes: number,
): Promise<string | undefined> {
    const root = changeRoot(directory, change);
    const files: Partial<Record<ArtifactId, string>> = {
        ...ARTIFACT_FILES,
        "correctness-judgment": "judgment-correctness.json",
        "compliance-judgment": "judgment-compliance.json",
        receipt: "specops-receipt.json",
    };

    for (const artifact of state.requirements.requiredArtifacts) {
        const provenance = state.artifacts[artifact];
        if (!provenance || provenance.validity !== "valid") {
            return `SpecOps archive: required artifact '${artifact}' is not marked valid`;
        }

        try {
            let content: string;
            if (artifact === "implementation") {
                const diffHash = hash(await collectDiff(directory, maxDiffBytes));
                if (state.implementationDiffHash !== diffHash) {
                    return "SpecOps archive: implementation diff changed after verification";
                }
                content = diffHash;
            } else if (artifact === "specs") {
                content = await currentSpecsArtifactContent(root);
            } else {
                const relative = files[artifact];
                if (!relative) return `SpecOps archive: no file mapping exists for '${artifact}'`;
                content = await readFile(path.join(root, relative), "utf8");
            }

            const persisted = redactSensitiveText(content.trim());
            if (hash(persisted) !== provenance.outputHash) {
                return `SpecOps archive: required artifact '${artifact}' changed after verification`;
            }
        } catch {
            return `SpecOps archive: required artifact '${artifact}' is missing or unreadable`;
        }
    }
    return undefined;
}

/** Serialize the current specs bundle using the same stable shape as provenance. */
async function currentSpecsArtifactContent(root: string): Promise<string> {
    const specsRoot = path.join(root, "specs");
    const entries = (await readdir(specsRoot, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name),
    );
    const specs: Record<string, string> = {};
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        specs[entry.name] = (
            await readFile(path.join(specsRoot, entry.name, "spec.md"), "utf8")
        ).trim();
    }
    return JSON.stringify(specs);
}

/** Compute the expected archive entry name for a change (a recovery hint only). */
function computeExpectedArchiveName(change: string): string {
    if (/^\d{4}-\d{2}-\d{2}-/.test(change)) return change;
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return `${date}-${change}`;
}

/**
 * Parse the OpenSpec archive command JSON result.
 *
 * @param stdout - The `--json` stdout from a successful `openspec archive`.
 * @returns The archive path and archived-as name, or `undefined` when absent.
 */
function parseArchiveResult(stdout: string): { path: string; archivedAs: string } | undefined {
    try {
        const value = JSON.parse(stdout) as {
            archive?: { path?: string; archivedAs?: string } | null;
        };
        if (
            !value.archive ||
            typeof value.archive.path !== "string" ||
            typeof value.archive.archivedAs !== "string"
        ) {
            return undefined;
        }
        return { path: value.archive.path, archivedAs: value.archive.archivedAs };
    } catch {
        return undefined;
    }
}

/**
 * List archived directory candidates whose name could correspond to a change.
 *
 * Matches the exact change name (when it already carried a date prefix) and
 * entries ending in `-${change}` (the date-prefixed form). Selection is only a
 * hint for recovery; identity is verified from each candidate's state file.
 */
async function listArchiveCandidates(archiveDir: string, change: string): Promise<string[]> {
    let entries: string[];
    try {
        entries = await readdir(archiveDir);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return [];
    }
    return entries
        .filter(name => name === change || name.endsWith(`-${change}`))
        .map(name => path.join(archiveDir, name));
}

/** Throw a controlled path-conflict diagnostic. */
function throwPathConflict(message: string): never {
    throw new Error(message);
}

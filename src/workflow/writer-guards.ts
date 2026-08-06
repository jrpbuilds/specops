import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { hash } from "../artifacts/lifecycle.js";
import { changeRoot } from "../state/store.js";
import { baseCommit, stashFingerprint } from "../git.js";
import { ARTIFACT_FILES } from "./artifacts.js";
import type { ArtifactId, DispatchRecord, RunState } from "../types.js";

/**
 * Reject writer completion when Git history or controller-owned artifacts changed.
 *
 * This guard is an integrity check, not an automatic recovery mechanism. It
 * intentionally leaves the unexpected worktree state available for diagnosis.
 */
export async function assertWriterGuards(
    directory: string,
    change: string,
    state: RunState,
    dispatch: DispatchRecord,
): Promise<void> {
    if (!dispatch.writerGuard) return;
    if (dispatch.writerGuard.baseline !== state.baseline) {
        throw new Error("Writer guard found modified run baseline");
    }
    if (/^[0-9a-f]{40}$/i.test(dispatch.writerGuard.baseline)) {
        const head = await baseCommit(directory);
        if (head !== dispatch.writerGuard.baseline) {
            throw new Error("Writer guard rejected a changed Git HEAD");
        }
    }
    if (
        dispatch.writerGuard.stashFingerprint !== undefined &&
        (await stashFingerprint(directory)) !== dispatch.writerGuard.stashFingerprint
    ) {
        throw new Error(
            "Writer guard detected a changed Git stash list; workers must not stash changes",
        );
    }

    const currentArtifacts = await protectedControllerTree(directory, change);
    const expectedFiles = Object.keys(dispatch.writerGuard.artifacts).sort();
    const currentFiles = Object.keys(currentArtifacts).sort();
    if (JSON.stringify(currentFiles) !== JSON.stringify(expectedFiles)) {
        throw new Error("Writer guard found a changed controller artifact tree");
    }
    for (const [file, expectedHash] of Object.entries(dispatch.writerGuard.artifacts)) {
        if (currentArtifacts[file] !== expectedHash) {
            throw new Error(`Writer guard found modified controller artifact: ${file}`);
        }
    }
}

/** Capture controller-owned artifact hashes when a writer dispatch is issued. */
export async function captureWriterGuard(
    directory: string,
    change: string,
    state: RunState,
): Promise<NonNullable<DispatchRecord["writerGuard"]>> {
    const artifacts = await protectedControllerTree(directory, change);
    for (const [artifact, file] of Object.entries(ARTIFACT_FILES) as Array<[ArtifactId, string]>) {
        if (artifact === "implementation" || state.artifacts[artifact]?.validity !== "valid") {
            continue;
        }
        if (!(file in artifacts) && /^[0-9a-f]{40}$/i.test(state.baseline)) {
            throw new Error(`Writer guard cannot issue with missing controller artifact: ${file}`);
        }
    }
    if (state.artifacts.specs?.validity === "valid") {
        const specifications = Object.keys(artifacts).filter(
            relative => relative.startsWith("specs/") && relative.endsWith("/spec.md"),
        );
        if (specifications.length === 0 && /^[0-9a-f]{40}$/i.test(state.baseline)) {
            throw new Error("Writer guard cannot issue with missing controller specifications");
        }
    }
    return {
        baseline: state.baseline,
        artifacts,
        stashFingerprint: /^[0-9a-f]{40}$/i.test(state.baseline)
            ? await stashFingerprint(directory)
            : undefined,
    };
}

/**
 * Hash the complete immutable portion of one controller-owned change tree.
 *
 * Run, progress, and evidence records are excluded because controller tools may
 * legitimately update them while a writer dispatch is active. Every other file
 * and directory is protected, including unknown additions and symbolic links.
 */
async function protectedControllerTree(
    directory: string,
    change: string,
): Promise<Record<string, string>> {
    const root = changeRoot(directory, change);
    const excluded = new Set([
        "specops-run.json",
        "specops-progress.json",
        "specops-evidence.json",
        "specops-run.lock",
        "specops-transaction",
    ]);
    const entries: Record<string, string> = {};

    async function visit(current: string): Promise<void> {
        for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) =>
            left.name.localeCompare(right.name),
        )) {
            const absolute = path.join(current, entry.name);
            const relative = path.relative(root, absolute).split(path.sep).join("/");
            if (excluded.has(relative)) continue;
            if (entry.isSymbolicLink()) {
                throw new Error(
                    `Writer guard rejected symbolic link in controller tree: ${relative}`,
                );
            }
            if (entry.isDirectory()) {
                entries[`${relative}/`] = hash("directory");
                await visit(absolute);
                continue;
            }
            if (!entry.isFile()) {
                throw new Error(
                    `Writer guard rejected special file in controller tree: ${relative}`,
                );
            }
            entries[relative] = hash((await readFile(absolute, "utf8")).trim());
        }
    }

    await visit(root);
    return entries;
}

import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { runProcess, type ProcessResult } from "../process.js";

/** SHA-256 identity for one exact implementation repository state. */
export type RepositoryIdentity = string;

/** One changed path reported by Git's porcelain status output. */
export type RepositoryStatusEntry = {
    indexStatus: string;
    worktreeStatus: string;
    path: string;
};

/** Injectable direct process runner for deterministic identity tests. */
type RepositoryProcessRunner = (
    command: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    environment?: Record<string, string>,
    maxOutputBytes?: number,
) => Promise<ProcessResult>;

/** Options for calculating the implementation-only repository identity. */
export type RepositoryIdentityOptions = {
    run?: RepositoryProcessRunner;
    includeOpenSpecPlanning?: boolean;
};

/**
 * Calculate a deterministic implementation identity from HEAD plus current
 * tracked, staged, deleted, and non-ignored untracked state.
 *
 * Each entry records its index/worktree status, path, POSIX mode (so a
 * chmod is detected), and content. Symlinks are captured by their link
 * target string rather than by following the link, so a symlink pointing
 * outside the repository can never pull outside content into the identity
 * (B-10 symlink containment).
 */
export async function calculateRepositoryIdentity(
    directory: string,
    options: RepositoryIdentityOptions = {},
): Promise<RepositoryIdentity> {
    const run = options.run ?? runProcess;
    const [head, status] = await Promise.all([
        git(run, directory, ["rev-parse", "HEAD"]),
        git(run, directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    const entries = parseRepositoryStatus(status).filter(entry =>
        isRelevantPath(entry.path, options.includeOpenSpecPlanning === true),
    );
    const records = await Promise.all(
        entries.map(async entry => {
            const content = await readTrackedContent(directory, entry.path);
            return JSON.stringify([
                entry.indexStatus,
                entry.worktreeStatus,
                entry.path,
                content === undefined ? "deleted" : content,
            ]);
        }),
    );
    const canonical = [`head\t${head.trim()}`, ...records.sort()].join("\n") + "\n";
    return hash(canonical);
}

/** Parse NUL-delimited Git porcelain v1 status into stable path entries. */
export function parseRepositoryStatus(status: string): RepositoryStatusEntry[] {
    const fields = status.split("\0");
    const entries: RepositoryStatusEntry[] = [];
    for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        if (!field) continue;
        if (field.length < 4 || field[2] !== " ") {
            throw new Error("unexpected git status --porcelain=v1 -z output");
        }
        const indexStatus = field[0];
        const worktreeStatus = field[1];
        const currentPath = field.slice(3);
        if ((indexStatus === "R" || indexStatus === "C") && fields[index + 1] !== undefined) {
            const originalPath = fields[index + 1];
            entries.push({ indexStatus, worktreeStatus, path: originalPath });
            index += 1;
        }
        entries.push({ indexStatus, worktreeStatus, path: currentPath });
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path));
}

/** Return whether a path belongs in an implementation-only identity. */
export function isRelevantPath(pathname: string, includeOpenSpecPlanning: boolean): boolean {
    const normalized = pathname.replaceAll("\\", "/");
    return (
        normalized !== ".git" &&
        !normalized.startsWith(".git/") &&
        normalized !== ".specops" &&
        !normalized.startsWith(".specops/") &&
        (includeOpenSpecPlanning ||
            (normalized !== "openspec/changes" && !normalized.startsWith("openspec/changes/")))
    );
}

/**
 * Read a current path's bytes, treating deleted paths as a stable marker.
 *
 * Symlinks are captured by their link target string (not followed) so a link
 * pointing outside the repository cannot pull outside content into the
 * identity. The POSIX mode is included so a chmod is detected even when the
 * content is unchanged. Both are contained to the repository root: a
 * resolved symlink target outside the root is recorded as "outside" rather
 * than followed.
 */
async function readTrackedContent(
    directory: string,
    relative: string,
): Promise<string | undefined> {
    const root = path.resolve(directory);
    const target = path.resolve(directory, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`git status returned an unsafe repository path: ${relative}`);
    }
    let stats;
    try {
        stats = await lstat(target);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    }
    const mode = stats.mode & 0o777;
    if (stats.isSymbolicLink()) {
        let linkTarget: string;
        try {
            linkTarget = await readlink(target);
        } catch {
            return JSON.stringify({ kind: "symlink", mode, target: "unreadable" });
        }
        const resolved = path.resolve(path.dirname(target), linkTarget);
        const contained = resolved === root || resolved.startsWith(`${root}${path.sep}`);
        return JSON.stringify({
            kind: "symlink",
            mode,
            target: contained ? linkTarget : "outside",
        });
    }
    if (!stats.isFile()) {
        return JSON.stringify({ kind: "special", mode });
    }
    try {
        const content = await readFile(target);
        return JSON.stringify({ kind: "file", mode, hash: hash(content) });
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    }
}

/** Execute Git with its direct executable interface and return stdout. */
async function git(
    run: RepositoryProcessRunner,
    directory: string,
    args: string[],
): Promise<string> {
    const result = await run("git", args, directory, undefined, {
        PATH: process.env.PATH ?? "",
        NO_COLOR: "1",
    });
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
}

/** Return a SHA-256 hex digest for deterministic canonical data. */
function hash(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

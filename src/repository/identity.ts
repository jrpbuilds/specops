import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
                content === undefined ? "deleted" : hash(content),
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

/** Read a current path's bytes, treating deleted paths as a stable marker. */
async function readTrackedContent(
    directory: string,
    relative: string,
): Promise<Buffer | undefined> {
    const root = path.resolve(directory);
    const target = path.resolve(directory, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`git status returned an unsafe repository path: ${relative}`);
    }
    try {
        return await readFile(target);
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

/**
 * Low-level git and process helpers for SpecOps.
 *
 * All child-process invocations are shell-free. The git wrapper sets
 * `NO_COLOR` and a narrow `PATH` to minimise environment leakage.
 */

import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"

/** Result from a direct executable invocation; no shell is ever involved. */
export type ProcessResult = {
    stdout: string
    stderr: string
    code: number
    outputTruncated: boolean
    stdoutTruncated: boolean
    stderrTruncated: boolean
}

/**
 * Run an executable with an argument array. Supplying an environment replaces
 * inherited variables, allowing callers to use a deliberately narrow runtime.
 *
 * @param command - Path or name of the executable to spawn.
 * @param args - Arguments passed to the child process.
 * @param cwd - Working directory for the child process.
 * @param signal - Optional `AbortSignal` to cancel the running process.
 * @param environment - Optional env vars (replaces, not merges, `process.env`).
 * @param maxOutputBytes - Optional cap on combined stdout/stderr buffering;
 * exceeding this kills the child with `SIGTERM`.
 * @returns A {@link ProcessResult} with captured output streams and exit code.
 */
export async function runProcess(
    command: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    environment?: Record<string, string>,
    maxOutputBytes?: number,
): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            shell: false,
            env: environment ?? process.env,
            stdio: ["ignore", "pipe", "pipe"],
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let outputBytes = 0
        let stdoutTruncated = false
        let stderrTruncated = false

        /** Accumulate a chunk of output, truncating at `maxOutputBytes` if set. */
        const collect =
            (target: Buffer[], stream: "stdout" | "stderr") =>
            (chunk: Buffer): void => {
                const remaining =
                    maxOutputBytes === undefined ? chunk.length : maxOutputBytes - outputBytes
                if (remaining > 0) {
                    target.push(chunk.subarray(0, remaining))
                    outputBytes += Math.min(chunk.length, remaining)
                }
                if (maxOutputBytes !== undefined && chunk.length > remaining) {
                    if (stream === "stdout") stdoutTruncated = true
                    else stderrTruncated = true
                }
            }

        child.stdout.on("data", collect(stdout, "stdout"))
        child.stderr.on("data", collect(stderr, "stderr"))
        child.on("error", reject)
        /** Kill the child process on abort signal. */
        const abort = (): boolean => child.kill("SIGTERM")
        signal?.addEventListener("abort", abort, { once: true })
        child.on("close", code => {
            signal?.removeEventListener("abort", abort)
            resolve({
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
                code: code ?? 1,
                outputTruncated: stdoutTruncated || stderrTruncated,
                stdoutTruncated,
                stderrTruncated,
            })
        })
    })
}

/**
 * Read the current implementation baseline commit.
 * @param directory - Repository working directory.
 * @returns The trimmed `HEAD` commit SHA.
 * @throws If the underlying `git rev-parse HEAD` invocation fails.
 */
export async function baseCommit(directory: string): Promise<string> {
    return (await git(directory, ["rev-parse", "HEAD"])).trim()
}

/**
 * Refuse automation if user code changes already exist outside OpenSpec
 * metadata.
 * @param directory - Repository working directory.
 * @throws If any non-`openspec/` tracked or untracked paths are present in the worktree.
 */
export async function assertCleanWorktree(directory: string): Promise<void> {
    const status = await git(directory, ["status", "--porcelain=v1", "--untracked-files=all"])
    const changes = status
        .split("\n")
        .filter(Boolean)
        .filter(line => !line.slice(3).replace(/^"|"$/g, "").startsWith("openspec/"))
    if (changes.length) {
        throw new Error(`SpecOps requires a clean implementation worktree.\n${changes.join("\n")}`)
    }
}

/**
 * Collect the repository diff while excluding controller-owned OpenSpec
 * files.
 * @param directory - Repository working directory.
 * @param maxBytes - Hard ceiling on the assembled diff size.
 * @returns The combined tracked plus untracked implementation diff.
 * @throws If the assembled diff exceeds `maxBytes`.
 */
export async function collectDiff(directory: string, maxBytes: number): Promise<string> {
    const tracked = await git(directory, [
        "diff",
        "--no-ext-diff",
        "--binary",
        "HEAD",
        "--",
        ".",
        ":(exclude)openspec/**",
    ])
    const untracked = (
        await git(directory, [
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ".",
            ":(exclude)openspec/**",
        ])
    )
        .split("\0")
        .filter(Boolean)
        .sort()
    const sections = [tracked]
    for (const relative of untracked) {
        const data = await readFile(path.join(directory, relative))
        sections.push(
            `\ndiff --git a/${relative} b/${relative}\nnew file mode 100644\n--- /dev/null\n+++ b/${relative}\n${data
                .toString("utf8")
                .split("\n")
                .map(line => `+${line}`)
                .join("\n")}`,
        )
    }

    const diff = sections.join("") || "(no implementation diff)"
    if (Buffer.byteLength(diff) > maxBytes) {
        throw new Error(`review diff exceeds configured maximum of ${maxBytes} bytes`)
    }
    return diff
}

/**
 * Collect changed implementation paths while excluding controller-owned OpenSpec files.
 *
 * Tracked paths come from Git's NUL-delimited name list and untracked paths
 * from the matching untracked-file query. Results are normalized, deduplicated,
 * and sorted; rename detection contributes the destination path once.
 *
 * @param directory - Repository working directory.
 * @returns Changed paths relative to the repository root.
 */
export async function collectChangedPaths(directory: string): Promise<string[]> {
    const tracked = await git(directory, [
        "diff",
        "--name-only",
        "--find-renames",
        "-z",
        "HEAD",
        "--",
        ".",
        ":(exclude)openspec/**",
    ])
    const untracked = await git(directory, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ".",
        ":(exclude)openspec/**",
    ])
    return [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort()
}

/**
 * Internal git wrapper: runs `git` with `NO_COLOR` and a narrowed `PATH`.
 * @param directory - Repository working directory.
 * @param args - Arguments passed to `git`.
 * @returns The stdout of the git invocation.
 * @throws If git exits with a non-zero code, attaching stderr to the message.
 */
async function git(directory: string, args: string[]): Promise<string> {
    const result = await runProcess("git", args, directory, undefined, {
        PATH: process.env.PATH ?? "",
        NO_COLOR: "1",
    })
    if (result.code !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
    }
    return result.stdout
}

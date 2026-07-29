import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { runProcess } from "../git.js"
import type { SpecOpsConfig } from "../config.js"
import type { CommandEvidence } from "../types.js"

/**
 * Resolve a command working directory without allowing path traversal.
 *
 * Ensures the resolved path is a child of (or equal to) `root`, rejecting
 * any `..` traversal outside the project root.
 *
 * @param root - The project root directory.
 * @param cwd - An optional relative working directory; defaults to `"."`.
 * @returns The resolved absolute path, guaranteed to be under `root`.
 * @throws If the resolved path escapes `root`.
 */
function confined(root: string, cwd: string | undefined): string {
    const target = path.resolve(root, cwd ?? ".")
    if (!target.startsWith(root + path.sep) && target !== root) {
        throw new Error("validation cwd escapes project root")
    }
    return target
}

/**
 * Run a registered project validation with a sanitized environment and bounded output.
 *
 * Validates the command string and arguments (rejecting null bytes), resolves
 * the working directory under `root`, forwards an optional abort signal, sets
 * a hard timeout from `config.review.commandTimeoutSeconds`, and collects
 * bounded stdout/stderr with truncation detection. Returns a complete
 * {@link CommandEvidence} record with hashes, excerpts, and timestamps.
 *
 * @param root - The project root directory.
 * @param config - SpecOps configuration containing timeout and output limits.
 * @param input - The validation descriptor: executable, arguments, optional
 * working directory, and the ids linking this execution back to the run.
 * @param signal - Optional external abort signal forwarded to the child
 * process.
 * @returns A fully populated {@link CommandEvidence} record.
 * @throws If `input.executable` or any argument contains a null byte, or if
 * the resolved working directory escapes `root`.
 */
export async function executeValidation(
    root: string,
    config: SpecOpsConfig,
    input: {
        executable: string
        args: string[]
        cwd?: string
        validationId: string
        dispatchId: string
    },
    signal?: AbortSignal,
): Promise<CommandEvidence> {
    if (
        !input.executable ||
        input.executable.includes("\0") ||
        input.args.some(arg => typeof arg !== "string" || arg.includes("\0"))
    ) {
        throw new Error("invalid validation command")
    }

    const cwd = confined(root, input.cwd)
    const startedAt = new Date().toISOString()
    const controller = new AbortController()
    const forwardCancellation = (): void => controller.abort(signal?.reason)
    signal?.addEventListener("abort", forwardCancellation, { once: true })
    const timer = setTimeout(() => controller.abort(), config.review.commandTimeoutSeconds * 1_000)
    let result: Awaited<ReturnType<typeof runProcess>>
    try {
        result = await runProcess(
            input.executable,
            input.args,
            cwd,
            controller.signal,
            {
                PATH: process.env.PATH ?? "",
                CI: "1",
                NO_COLOR: "1",
                OPENSPEC_TELEMETRY: "0",
            },
            config.review.commandOutputBytes,
        )
    } finally {
        clearTimeout(timer)
        signal?.removeEventListener("abort", forwardCancellation)
    }

    const stdoutMarker = result.stdoutTruncated ? "\n[SpecOps output limit reached]" : ""
    const stderrMarker = result.stderrTruncated ? "\n[SpecOps output limit reached]" : ""
    return {
        id: randomUUID(),
        executable: input.executable,
        args: input.args,
        cwd,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: result.code,
        stdoutHash: createHash("sha256").update(result.stdout).digest("hex"),
        stderrHash: createHash("sha256").update(result.stderr).digest("hex"),
        stdoutExcerpt: result.stdout + stdoutMarker,
        stderrExcerpt: result.stderr + stderrMarker,
        validationId: input.validationId,
        dispatchId: input.dispatchId,
    }
}

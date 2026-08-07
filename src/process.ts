import { spawn } from "node:child_process";

/** Result from a direct executable invocation; no shell is ever involved. */
export type ProcessResult = {
    stdout: string;
    stderr: string;
    code: number;
    outputTruncated: boolean;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
};

/** Grace period before escalating SIGTERM to SIGKILL on timeout or abort. */
const KILL_GRACE_MS = 2_000;

/**
 * Run an executable with an argument array and optional bounded output capture.
 *
 * Spawns the child in its own process group so a timeout or abort can terminate
 * the whole tree. On timeout or abort the group receives SIGTERM; if it has not
 * exited after a short grace period, the group receives SIGKILL so a runaway
 * child can never outlive the caller.
 *
 * @param command - Executable name or absolute path.
 * @param args - Individual argv elements passed without shell interpolation.
 * @param cwd - Process working directory.
 * @param signal - Optional cancellation signal.
 * @param environment - Optional complete child environment.
 * @param maxOutputBytes - Optional combined stdout/stderr capture limit.
 * @param timeoutMs - Optional wall-clock timeout after which the group is terminated.
 * @returns Captured process result.
 */
export async function runProcess(
    command: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    environment?: Record<string, string>,
    maxOutputBytes?: number,
    timeoutMs?: number,
): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            shell: false,
            env: environment ?? process.env,
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let settled = false;

        const collect =
            (target: Buffer[], stream: "stdout" | "stderr") =>
            (chunk: Buffer): void => {
                const remaining =
                    maxOutputBytes === undefined ? chunk.length : maxOutputBytes - outputBytes;
                if (remaining > 0) {
                    target.push(chunk.subarray(0, remaining));
                    outputBytes += Math.min(chunk.length, remaining);
                }
                if (maxOutputBytes !== undefined && chunk.length > remaining) {
                    if (stream === "stdout") stdoutTruncated = true;
                    else stderrTruncated = true;
                }
            };

        child.stdout.on("data", collect(stdout, "stdout"));
        child.stderr.on("data", collect(stderr, "stderr"));
        child.on("error", error => {
            if (!settled) {
                settled = true;
                reject(error);
            }
        });

        /** Send SIGTERM then SIGKILL to the child's process group after a grace period. */
        const terminateGroup = (reason: "abort" | "timeout"): void => {
            try {
                if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
            } catch {
                /* process group may already be gone */
            }
            setTimeout(() => {
                if (!settled) {
                    try {
                        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
                    } catch {
                        /* process group may already be gone */
                    }
                }
            }, KILL_GRACE_MS).unref();
            void reason;
        };

        const abort = (): void => terminateGroup("abort");
        signal?.addEventListener("abort", abort, { once: true });

        const timer =
            timeoutMs !== undefined
                ? setTimeout(() => terminateGroup("timeout"), timeoutMs)
                : undefined;
        if (timer) timer.unref();

        child.on("close", code => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", abort);
            if (timer) clearTimeout(timer);
            resolve({
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
                code: code ?? 1,
                outputTruncated: stdoutTruncated || stderrTruncated,
                stdoutTruncated,
                stderrTruncated,
            });
        });
    });
}

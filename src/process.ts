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

/**
 * Run an executable with an argument array and optional bounded output capture.
 *
 * @param command - Executable name or absolute path.
 * @param args - Individual argv elements passed without shell interpolation.
 * @param cwd - Process working directory.
 * @param signal - Optional cancellation signal.
 * @param environment - Optional complete child environment.
 * @param maxOutputBytes - Optional combined stdout/stderr capture limit.
 * @returns Captured process result.
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
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let stdoutTruncated = false;
        let stderrTruncated = false;

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
        child.on("error", reject);
        const abort = (): boolean => child.kill("SIGTERM");
        signal?.addEventListener("abort", abort, { once: true });
        child.on("close", code => {
            signal?.removeEventListener("abort", abort);
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

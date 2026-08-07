import { createHash } from "node:crypto";
import path from "node:path";
import { runProcess, type ProcessResult } from "../process.js";
import type { RepositoryIdentity } from "../repository/identity.js";
import type { ValidationCommand } from "./registry.js";
import { canonicalCommandHash } from "./registry.js";

/** Durable, identity-bound result from a single required validation command. */
export type ValidationEvidence = {
    commandId: string;
    executable: string;
    args: string[];
    cwd: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    outputTruncated: boolean;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    repositoryIdentity: RepositoryIdentity;
    outputHash: string;
    /**
     * SHA-256 over the complete canonical command definition accepted when
     * this evidence was recorded. Gates reject evidence whose definition no
     * longer matches the accepted set.
     */
    commandDefinitionHash: string;
    executionError?: string;
    invalidatedAt?: string;
    invalidatedBy?: RepositoryIdentity;
};

/** Injectable direct process runner used by the shell-free validation executor. */
export type ValidationProcessRunner = (
    command: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    environment?: Record<string, string>,
    maxOutputBytes?: number,
) => Promise<ProcessResult>;

/** Execute one configured command with bounded output and a hard timeout. */
export async function executeValidationCommand(
    directory: string,
    command: ValidationCommand,
    repositoryIdentity: RepositoryIdentity,
    run: ValidationProcessRunner = runProcess,
): Promise<ValidationEvidence> {
    const cwd = resolveValidationCwd(directory, command.cwd);
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, command.timeoutMs);

    try {
        const result = await run(
            command.executable,
            command.args,
            cwd,
            controller.signal,
            { PATH: process.env.PATH ?? "", NO_COLOR: "1" },
            command.maxOutputBytes,
        );
        return createEvidence(
            command,
            repositoryIdentity,
            cwd,
            startedAt,
            started,
            timedOut,
            result,
        );
    } catch (error) {
        const endedAt = new Date().toISOString();
        const executionError = error instanceof Error ? error.message : String(error);
        return {
            commandId: command.id,
            executable: command.executable,
            args: [...command.args],
            cwd,
            startedAt,
            endedAt,
            durationMs: Math.max(0, Date.now() - started),
            exitCode: null,
            timedOut,
            stdout: "",
            stderr: "",
            outputTruncated: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            repositoryIdentity,
            outputHash: hashOutput("", ""),
            commandDefinitionHash: canonicalCommandHash(command),
            executionError,
        };
    } finally {
        clearTimeout(timeout);
    }
}

/** Build a complete evidence record from a completed direct process invocation. */
function createEvidence(
    command: ValidationCommand,
    repositoryIdentity: RepositoryIdentity,
    cwd: string,
    startedAt: string,
    started: number,
    timedOut: boolean,
    result: ProcessResult,
): ValidationEvidence {
    return {
        commandId: command.id,
        executable: command.executable,
        args: [...command.args],
        cwd,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - started),
        exitCode: timedOut ? null : result.code,
        timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        outputTruncated: result.outputTruncated,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        repositoryIdentity,
        outputHash: hashOutput(result.stdout, result.stderr),
        commandDefinitionHash: canonicalCommandHash(command),
    };
}

/** Resolve a repository-relative configured cwd without allowing traversal. */
function resolveValidationCwd(directory: string, relative = "."): string {
    const root = path.resolve(directory);
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error("validation working directory escaped repository root");
    }
    return target;
}

/** Hash captured streams with an explicit separator. */
function hashOutput(stdout: string, stderr: string): string {
    return createHash("sha256").update(stdout).update("\0").update(stderr).digest("hex");
}

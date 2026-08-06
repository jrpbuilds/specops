import { createRequire } from "node:module";
import path from "node:path";
import { parseOpenSpecArchive, type OpenSpecArchiveResult } from "./archive.js";
import { OpenSpecOperationalError } from "./errors.js";
import { parseOpenSpecInstructions, type OpenSpecInstructions } from "./instructions.js";
import { assertStandardSchemaName, parseOpenSpecSchemas, type OpenSpecSchema } from "./schema.js";
import { parseOpenSpecStatus, type OpenSpecChangeStatus } from "./status.js";
import { parseOpenSpecValidation, type OpenSpecValidationResult } from "./validation.js";
import { parseOpenSpecVersion } from "./version.js";
import { runProcess, type ProcessResult } from "../process.js";

const require = createRequire(import.meta.url);

type ProcessRunner = (
    command: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    environment?: Record<string, string>,
) => Promise<ProcessResult>;

export type OpenSpecAdapterOptions = {
    directory: string;
    command?: readonly string[] | null;
    run?: ProcessRunner;
};

/** Typed, shell-free facade over supported OpenSpec 1.7 operations. */
export class OpenSpecAdapter {
    readonly #run: ProcessRunner;

    constructor(private readonly options: OpenSpecAdapterOptions) {
        this.#run = options.run ?? runProcess;
    }

    /** Detect and enforce the supported OpenSpec version. */
    async version(): Promise<string> {
        const result = await this.execute(["--version"]);
        return parseOpenSpecVersion(result.stdout);
    }

    /** List upstream schemas available to the project. */
    async schemas(): Promise<OpenSpecSchema[]> {
        return parseOpenSpecSchemas((await this.execute(["schemas", "--json"])).stdout);
    }

    /** Query typed status for one standard OpenSpec change. */
    async status(change: string): Promise<OpenSpecChangeStatus> {
        return parseOpenSpecStatus(
            (await this.execute(["status", "--change", change, "--json"])).stdout,
        );
    }

    /** Confirm upstream `spec-driven` availability and the active change schema. */
    async assertStandardSchema(change: string): Promise<string> {
        const schemas = await this.schemas();
        if (!schemas.some(schema => schema.name === "spec-driven")) {
            assertStandardSchemaName("unavailable");
        }
        const status = await this.status(change);
        assertStandardSchemaName(status.schemaName);
        return status.schemaName;
    }

    /** Get current upstream instructions for one change artifact. */
    async instructions(artifact: string, change: string): Promise<OpenSpecInstructions> {
        return parseOpenSpecInstructions(
            (await this.execute(["instructions", artifact, "--change", change, "--json"])).stdout,
        );
    }

    /** Validate one change or artifact, returning invalid artifact results without throwing. */
    async validate(item?: string, strict = false): Promise<OpenSpecValidationResult> {
        const args = [
            "validate",
            ...(item ? [item] : []),
            ...(strict ? ["--strict"] : []),
            "--json",
        ];
        const result = await this.run(args);
        try {
            return parseOpenSpecValidation(result.stdout);
        } catch (error) {
            if (error instanceof OpenSpecOperationalError) {
                throw this.failure(args, result, error.message);
            }
            throw error;
        }
    }

    /** Archive through OpenSpec without reproducing archive semantics. */
    async archive(change: string): Promise<OpenSpecArchiveResult> {
        const result = await this.run(["archive", change, "--json", "--yes"]);
        return parseOpenSpecArchive(result.stdout, result.stderr, result.code);
    }

    /** Initialise a project using upstream OpenCode integration assets. */
    async initialize(): Promise<void> {
        await this.execute(["init", "--tools", "opencode"]);
    }

    /** Create a standard upstream `spec-driven` change. */
    async createChange(change: string, goal: string): Promise<void> {
        await this.execute([
            "new",
            "change",
            change,
            "--schema",
            "spec-driven",
            "--goal",
            goal,
            "--json",
        ]);
    }

    /** Execute a supported command and surface operational failures consistently. */
    async execute(args: string[]): Promise<ProcessResult> {
        const result = await this.run(args);
        if (result.code !== 0) throw this.failure(args, result);
        return result;
    }

    private async run(args: string[]): Promise<ProcessResult> {
        const command = this.options.command?.[0] ?? process.execPath;
        const prefix = this.options.command?.slice(1) ?? [openSpecBinary()];
        return this.#run(
            command,
            [...prefix, ...args, "--no-color"],
            this.options.directory,
            undefined,
            {
                PATH: process.env.PATH ?? "",
                NO_COLOR: "1",
                OPENSPEC_TELEMETRY: "0",
            },
        );
    }

    private failure(
        args: string[],
        result: ProcessResult,
        detail?: string,
    ): OpenSpecOperationalError {
        return new OpenSpecOperationalError(
            detail ?? `OpenSpec ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
            result.stderr || result.stdout,
        );
    }
}

/** Resolve the launcher bundled with the installed OpenSpec dependency. */
function openSpecBinary(): string {
    const entry = require.resolve("@fission-ai/openspec");
    return path.resolve(path.dirname(entry), "..", "bin", "openspec.js");
}

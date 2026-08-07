import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./atomic.js";
import { runStatePath } from "./paths.js";
import {
    assertRunState,
    createRunState,
    isTerminalRunStatus,
    parseRunState,
    type CreateRunStateInput,
    type RunState,
} from "./schema.js";

/** Clear incompatibility raised when pre-V1 run metadata is encountered. */
export class LegacyRunStateError extends Error {
    constructor() {
        super("legacy SpecOps run state cannot resume in SpecOps 1.0");
        this.name = "LegacyRunStateError";
    }
}

/** Atomically create one coarse V1 run without overwriting existing metadata. */
export async function createV1Run(
    directory: string,
    input: CreateRunStateInput,
): Promise<RunState> {
    const state = createRunState(input);
    const destination = runStatePath(directory, input.change);
    await mkdir(runStatePath(directory, input.change).replace(/[/\\]run\.json$/, ""), {
        recursive: true,
    });
    try {
        await readFile(destination, "utf8");
        throw new Error(`SpecOps V1 run already exists for change ${input.change}`);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${destination}.${randomUUID()}.create`;
    await writeFileAtomic(temporary, `${JSON.stringify(state, null, 2)}\n`);
    try {
        await readFile(destination, "utf8");
        throw new Error(`SpecOps V1 run already exists for change ${input.change}`);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFileAtomic(destination, `${JSON.stringify(state, null, 2)}\n`);
    return state;
}

/** Read a current coarse run while refusing to reinterpret legacy state. */
export async function readV1Run(directory: string, change: string): Promise<RunState> {
    let raw: unknown;
    try {
        raw = JSON.parse(await readFile(runStatePath(directory, change), "utf8"));
    } catch (error) {
        if (error instanceof SyntaxError)
            throw new Error(`invalid SpecOps V1 run state JSON: ${change}`);
        throw error;
    }
    if (!isRecord(raw) || raw.version !== 1) throw new LegacyRunStateError();
    return parseRunState(raw);
}

/** Atomically update a nonterminal V1 run and refresh its timestamp. */
export async function updateV1Run(
    directory: string,
    change: string,
    update: (state: RunState) => RunState,
): Promise<RunState> {
    const current = await readV1Run(directory, change);
    if (
        isTerminalRunStatus(current.status) &&
        !(current.status === "failed" && current.failure?.kind === "archive")
    ) {
        throw new Error(`cannot continue terminal SpecOps V1 run (${current.status})`);
    }
    const next = assertRunState({
        ...update(current),
        change: current.change,
        startedAt: current.startedAt,
        updatedAt: new Date().toISOString(),
    });
    await writeFileAtomic(runStatePath(directory, change), `${JSON.stringify(next, null, 2)}\n`);
    return next;
}

/** Persist cancellation without deleting artifacts, evidence, or repository work. */
export async function cancelV1Run(directory: string, change: string): Promise<RunState> {
    return updateV1Run(directory, change, state => ({
        ...state,
        status: "cancelled",
        failure: null,
    }));
}

/** Narrow JSON values to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

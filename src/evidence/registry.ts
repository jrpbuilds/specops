import path from "node:path";
import type { CommandEvidence, DispatchRecord, RunState, ValidationRequirement } from "../types.js";
import { readMachine, writeMachine } from "../state/store.js";

/**
 * Shape of a registered `command` validation requirement.
 *
 * The barrier and the public validation tool both execute only this kind of
 * requirement; `openspec-strict` and `traceability` are enforced elsewhere.
 */
export type CommandRequirement = Extract<ValidationRequirement, { kind: "command" }>;

/**
 * On-disk shape of the evidence sidecar persisted under each change.
 */
export type EvidenceRegistry = {
    version: number;
    commands: CommandEvidence[];
};

/** Create an empty registry without sharing mutable command arrays. */
function emptyRegistry(): EvidenceRegistry {
    return { version: 2, commands: [] };
}

/** Return whether a value has the minimal persisted evidence registry shape. */
function isEvidenceRegistry(value: unknown): value is EvidenceRegistry {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return record.version === 2 && Array.isArray(record.commands);
}

/** Return whether a sidecar row has the fields required for safe matching. */
function isCommandEvidence(value: unknown): value is CommandEvidence {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return (
        typeof record.id === "string" &&
        typeof record.executable === "string" &&
        Array.isArray(record.args) &&
        record.args.every(argument => typeof argument === "string") &&
        typeof record.cwd === "string" &&
        typeof record.exitCode === "number" &&
        typeof record.validationId === "string" &&
        typeof record.dispatchId === "string"
    );
}

/**
 * Normalize a working directory so equivalent cwds match regardless of the
 * trailing separator or the default-`"."` form. Returns the absolute resolved
 * path under `root` so evidence recorded with one cwd form satisfies a
 * requirement declared with another.
 */
function normalizeCwd(root: string, cwd: string | undefined): string {
    return path.resolve(root, cwd ?? ".");
}

/**
 * Return whether a persisted evidence row satisfies a command requirement
 * against the current implementation diff and requirements policy.
 *
 * The match is exact on validation id, executable, argument array, and
 * resolved working directory, and requires a successful exit code with
 * evidence bound to the supplied diff and policy hashes.
 */
function evidenceSatisfiesRequirement(
    root: string,
    evidence: CommandEvidence,
    requirement: CommandRequirement,
    implementationDiffHash: string | undefined,
    policyHash: string,
): boolean {
    return (
        isCommandEvidence(evidence) &&
        evidence.validationId === requirement.id &&
        evidence.executable === requirement.executable &&
        evidence.args.length === requirement.args.length &&
        evidence.args.every((arg, index) => arg === requirement.args[index]) &&
        normalizeCwd(root, evidence.cwd) === normalizeCwd(root, requirement.cwd) &&
        evidence.exitCode === 0 &&
        evidence.implementationDiffHash === implementationDiffHash &&
        evidence.policyHash === policyHash
    );
}

/**
 * Read the evidence sidecar for a change, returning an empty registry when it
 * is absent or unparseable. The shape is trusted as-is; callers validate any
 * row they consume.
 */
export async function readEvidenceRegistry(
    directory: string,
    change: string,
): Promise<EvidenceRegistry> {
    const value = await readMachine<unknown>(directory, change, "specops-evidence.json", undefined);
    if (!isEvidenceRegistry(value)) return emptyRegistry();
    return { version: 2, commands: value.commands.filter(isCommandEvidence) };
}

/**
 * Persist the evidence sidecar atomically. Pretty-printed JSON with a trailing
 * newline, matching the existing sidecar format.
 */
async function writeEvidenceRegistry(
    directory: string,
    change: string,
    registry: EvidenceRegistry,
): Promise<void> {
    await writeMachine(directory, change, "specops-evidence.json", registry);
}

/**
 * Append one evidence row to the sidecar and persist it atomically.
 *
 * Reads the current registry, pushes the row, and rewrites the file so an
 * interrupted barrier can recognize already-recorded commands on resume.
 */
export async function appendEvidence(
    directory: string,
    change: string,
    evidence: CommandEvidence,
): Promise<void> {
    const registry = await readEvidenceRegistry(directory, change);
    registry.version = 2;
    registry.commands.push(evidence);
    await writeEvidenceRegistry(directory, change, registry);
}

/**
 * Resolve a registered command requirement by validation id.
 *
 * Returns `undefined` for non-`command` requirements so callers can ignore
 * `openspec-strict` and `traceability` kinds, which are not executed here.
 */
export function findCommandRequirement(
    state: RunState,
    validationId: string,
): CommandRequirement | undefined {
    return state.requirements.requiredValidations.find(
        (requirement): requirement is CommandRequirement =>
            requirement.id === validationId && requirement.kind === "command",
    );
}

/**
 * Return the command requirements lacking successful evidence bound to the
 * current implementation diff and requirements policy.
 *
 * Stable order follows the requirement declaration order so barrier execution
 * is deterministic across runs.
 */
export function missingCommandRequirements(
    root: string,
    state: RunState,
    registry: EvidenceRegistry,
): CommandRequirement[] {
    const diffHash = state.implementationDiffHash;
    const policyHash = state.requirements.policyHash;
    return state.requirements.requiredValidations
        .filter((requirement): requirement is CommandRequirement => requirement.kind === "command")
        .filter(
            requirement =>
                !registry.commands.some(row =>
                    evidenceSatisfiesRequirement(root, row, requirement, diffHash, policyHash),
                ),
        );
}

/**
 * Select the latest completed implementation or repair dispatch for use as
 * the provenance id on controller-executed validation evidence.
 *
 * The implementation dispatch establishes the diff being validated; when none
 * exists yet (e.g. a run that reached finalization without one) returns
 * `undefined` and the caller decides whether to fail closed or skip.
 */
export function latestImplementationDispatch(state: RunState): DispatchRecord | undefined {
    const completed = state.dispatches.filter(
        dispatch =>
            dispatch.status === "completed" &&
            (dispatch.capability === "implementation" || dispatch.capability === "repair"),
    );
    if (completed.length === 0) return undefined;
    return completed.reduce((latest, dispatch) =>
        (dispatch.finishedAt ?? dispatch.at) > (latest.finishedAt ?? latest.at) ? dispatch : latest,
    );
}

/**
 * Re-export the executor so callers can import barrier helpers and the
 * confined runner from one module surface.
 */
export { executeValidation } from "./commands.js";

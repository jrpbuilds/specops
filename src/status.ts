import { readFile } from "node:fs/promises";
import { parseReview, type ParsedReview } from "./review/parser.js";
import { reviewPath } from "./state/paths.js";
import type { RunState } from "./state/schema.js";
import { readV1Run } from "./state/store.js";
import { readValidationEvidence } from "./validation/evidence.js";
import type { ValidationEvidence } from "./validation/executor.js";

/** OpenSpec status subset displayed without exposing workflow internals. */
export type StatusOpenSpec = {
    schemaName: string;
    complete: boolean;
    artifacts: Array<{ id: string; status: string }>;
};

/** Adapter contract needed to gather bounded, presentation-safe run status. */
export type StatusOpenSpecAdapter = {
    status(change: string): Promise<{
        schemaName: string;
        isComplete: boolean;
        artifacts: Array<{ id: string; status: string }>;
    }>;
};

/** Complete display model used by both the status command and workflow tool. */
export type V1StatusSnapshot = {
    goal: string;
    change: string;
    status: RunState["status"];
    stage: RunState["stage"];
    openSpec: StatusOpenSpec | { error: string };
    correctionAttempts: RunState["artifactCorrectionAttempts"];
    identities: {
        baseline: string;
        current: string;
        validated: string | null;
        reviewed: string | null;
    };
    validation: Array<{
        commandId: string;
        result: "passed" | "failed" | "stale";
        timedOut: boolean;
    }>;
    review: { verdict: ParsedReview["verdict"]; currentIdentity: string | undefined };
    repairAttempts: number;
    checkpoint: string;
    reason: string | null;
};

/** Read all bounded V1 run facts required to explain its current state. */
export async function getV1Status(
    directory: string,
    change: string,
    adapter: StatusOpenSpecAdapter,
): Promise<V1StatusSnapshot> {
    const state = await readV1Run(directory, change);
    const [openSpec, evidence, review] = await Promise.all([
        resolveOpenSpec(
            adapter.status(change).then<StatusOpenSpec>(result => ({
                schemaName: result.schemaName,
                complete: result.isComplete,
                artifacts: result.artifacts.map(artifact => ({
                    id: artifact.id,
                    status: artifact.status,
                })),
            })),
        ),
        readValidationEvidence(directory, change),
        readReview(directory, change),
    ]);

    return {
        goal: state.goal,
        change: state.change,
        status: state.status,
        stage: state.stage,
        openSpec,
        correctionAttempts: state.artifactCorrectionAttempts,
        identities: {
            baseline: state.baselineRepositoryState,
            current: state.currentRepositoryState,
            validated: state.validatedRepositoryState,
            reviewed: state.reviewedRepositoryState,
        },
        validation: evidence.map(item => validationSummary(item, state.currentRepositoryState)),
        review: { verdict: review?.verdict, currentIdentity: review?.reviewedRepositoryState },
        repairAttempts: state.repairAttempts,
        checkpoint: checkpointState(state),
        reason: state.failure?.message ?? state.archiveError?.message ?? null,
    };
}

/** Format a status snapshot into concise human-readable command output. */
export function formatV1Status(snapshot: V1StatusSnapshot): string {
    const artifacts =
        "error" in snapshot.openSpec
            ? `unavailable (${snapshot.openSpec.error})`
            : snapshot.openSpec.artifacts.length
              ? snapshot.openSpec.artifacts
                    .map(artifact => `${artifact.id}: ${artifact.status}`)
                    .join(", ")
              : "none reported";
    const validation = snapshot.validation.length
        ? snapshot.validation
              .map(
                  item => `${item.commandId}: ${item.result}${item.timedOut ? " (timed out)" : ""}`,
              )
              .join(", ")
        : "no recorded commands";
    const corrections = Object.entries(snapshot.correctionAttempts).length
        ? Object.entries(snapshot.correctionAttempts)
              .map(([stage, attempts]) => `${stage}: ${attempts}`)
              .join(", ")
        : "none";

    return [
        `SpecOps run: ${snapshot.change}`,
        `Goal: ${snapshot.goal}`,
        `Status: ${snapshot.status}`,
        `Stage: ${snapshot.stage}`,
        `OpenSpec artifacts: ${artifacts}`,
        `Correction attempts: ${corrections}`,
        `Repository identities: baseline ${shortIdentity(snapshot.identities.baseline)}, current ${shortIdentity(snapshot.identities.current)}, validated ${shortIdentity(snapshot.identities.validated)}, reviewed ${shortIdentity(snapshot.identities.reviewed)}`,
        `Validation: ${validation}`,
        `Review verdict: ${snapshot.review.verdict ?? "not recorded"}`,
        `Repair attempts: ${snapshot.repairAttempts}`,
        `Checkpoint: ${snapshot.checkpoint}`,
        ...(snapshot.reason ? [`Reason: ${snapshot.reason}`] : []),
    ].join("\n");
}

/** Avoid hiding an adapter failure behind an otherwise useful status response. */
async function resolveOpenSpec(
    openSpec: Promise<StatusOpenSpec>,
): Promise<StatusOpenSpec | { error: string }> {
    try {
        return await openSpec;
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

/** Read an optional reviewer-owned artifact without treating its absence as operational failure. */
async function readReview(directory: string, change: string): Promise<ParsedReview | undefined> {
    try {
        return parseReview(await readFile(reviewPath(directory, change), "utf8"));
    } catch {
        return undefined;
    }
}

/** Reduce one evidence record to its current gate-relevant result. */
function validationSummary(
    evidence: ValidationEvidence,
    currentIdentity: string,
): V1StatusSnapshot["validation"][number] {
    const stale = evidence.invalidatedAt || evidence.repositoryIdentity !== currentIdentity;
    return {
        commandId: evidence.commandId,
        result:
            stale || evidence.timedOut || evidence.exitCode !== 0 || evidence.executionError
                ? stale
                    ? "stale"
                    : "failed"
                : "passed",
        timedOut: evidence.timedOut,
    };
}

/** Explain the currently persisted user checkpoint without adding a new state. */
function checkpointState(state: RunState): string {
    if (state.status === "verified") return "verified-open; resume may archive";
    if (state.status === "completed") return "completed";
    if (state.status === "cancelled") return "cancelled";
    if (state.status === "blocked") return "blocked; user remediation required";
    if (state.status === "failed" && state.stage === "archive")
        return "archive retry available through /specops";
    if (state.status === "awaiting-user" && state.stage === "implementation")
        return "planning checkpoint or artifact correction pause";
    if (state.status === "awaiting-user" && state.stage === "archive")
        return "completion checkpoint";
    return "no user checkpoint pending";
}

/** Present identities compactly while retaining enough data to compare status output. */
function shortIdentity(identity: string | null): string {
    return identity ? identity.slice(0, 12) : "not recorded";
}

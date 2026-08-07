/** Current on-disk schema version for coarse SpecOps V1 run state. */
export const RUN_STATE_VERSION = 1 as const;

/** Lifecycle status for a coarse SpecOps run. */
export type RunStatus =
    "active" | "awaiting-user" | "verified" | "completed" | "blocked" | "failed" | "cancelled";

/** Persisted boundary at which a run may safely resume. */
export type RunStage =
    | "exploration"
    | "proposal"
    | "specs"
    | "design"
    | "tasks"
    | "implementation"
    | "validation"
    | "review"
    | "repair"
    | "archive";

/** Details retained when a run cannot continue normally. */
export type RunFailure = {
    kind: "blocked" | "validation" | "operational" | "archive";
    message: string;
    at: string;
};

/** Retryable archive failure recorded when OpenSpec archival fails. */
export type ArchiveError = {
    message: string;
    attemptedAt: string;
    repositoryIdentity: string;
};

/**
 * The complete, intentionally coarse persisted state for one V1 run.
 *
 * OpenSpec remains authoritative for artifact readiness. This record stores
 * only the data needed to resume, diagnose, and gate the SpecOps workflow.
 */
export type RunState = {
    version: typeof RUN_STATE_VERSION;
    change: string;
    goal: string;
    status: RunStatus;
    stage: RunStage;
    startedAt: string;
    updatedAt: string;
    baselineRepositoryState: string;
    currentRepositoryState: string;
    validatedRepositoryState: string | null;
    reviewedRepositoryState: string | null;
    acceptedValidationRecommendationIds: string[];
    artifactCorrectionAttempts: Partial<Record<"proposal" | "specs" | "design" | "tasks", number>>;
    repairAttempts: number;
    failure: RunFailure | null;
    archiveError: ArchiveError | null;
    archivedAt: string | null;
};

/** Arguments used to construct the initial persisted run state. */
export type CreateRunStateInput = {
    change: string;
    goal: string;
    baselineRepositoryState: string;
    startedAt?: string;
};

const RUN_STATUSES = new Set<RunStatus>([
    "active",
    "awaiting-user",
    "verified",
    "completed",
    "blocked",
    "failed",
    "cancelled",
]);

const RUN_STAGES = new Set<RunStage>([
    "exploration",
    "proposal",
    "specs",
    "design",
    "tasks",
    "implementation",
    "validation",
    "review",
    "repair",
    "archive",
]);

const ARTIFACT_STAGES = new Set(["proposal", "specs", "design", "tasks"]);

const RUN_STATE_FIELDS = new Set([
    "version",
    "change",
    "goal",
    "status",
    "stage",
    "startedAt",
    "updatedAt",
    "baselineRepositoryState",
    "currentRepositoryState",
    "validatedRepositoryState",
    "reviewedRepositoryState",
    "acceptedValidationRecommendationIds",
    "artifactCorrectionAttempts",
    "repairAttempts",
    "failure",
    "archiveError",
    "archivedAt",
]);

const TERMINAL_STATUSES = new Set<RunStatus>(["completed", "blocked", "failed", "cancelled"]);

/** Return whether the run status cannot be continued. */
export function isTerminalRunStatus(status: RunStatus): boolean {
    return TERMINAL_STATUSES.has(status);
}

/** Construct an initial active run at the exploration boundary. */
export function createRunState(input: CreateRunStateInput): RunState {
    const now = input.startedAt ?? new Date().toISOString();
    const state: RunState = {
        version: RUN_STATE_VERSION,
        change: input.change,
        goal: input.goal,
        status: "active",
        stage: "exploration",
        startedAt: now,
        updatedAt: now,
        baselineRepositoryState: input.baselineRepositoryState,
        currentRepositoryState: input.baselineRepositoryState,
        validatedRepositoryState: null,
        reviewedRepositoryState: null,
        acceptedValidationRecommendationIds: [],
        artifactCorrectionAttempts: {},
        repairAttempts: 0,
        failure: null,
        archiveError: null,
        archivedAt: null,
    };
    return assertRunState(state);
}

/** Validate an unknown persisted value as the current coarse V1 state shape. */
export function parseRunState(value: unknown): RunState {
    if (!isRecord(value)) throw new Error("invalid SpecOps V1 run state: expected an object");
    if (Object.keys(value).some(key => !RUN_STATE_FIELDS.has(key))) {
        throw new Error("invalid SpecOps V1 run state: unsupported field");
    }
    return assertRunState(value as RunState);
}

/** Validate run-state invariants and return the typed state. */
export function assertRunState(state: RunState): RunState {
    if (state.version !== RUN_STATE_VERSION) {
        throw new Error(`invalid SpecOps V1 run state version: expected ${RUN_STATE_VERSION}`);
    }
    if (!isChange(state.change)) throw new Error("invalid SpecOps V1 run change name");
    if (!isNonEmptyString(state.goal)) throw new Error("invalid SpecOps V1 run goal");
    if (!RUN_STATUSES.has(state.status)) throw new Error("invalid SpecOps V1 run status");
    if (!RUN_STAGES.has(state.stage)) throw new Error("invalid SpecOps V1 run stage");
    if (!isTimestamp(state.startedAt) || !isTimestamp(state.updatedAt)) {
        throw new Error("invalid SpecOps V1 run timestamp");
    }
    if (!isIdentity(state.baselineRepositoryState) || !isIdentity(state.currentRepositoryState)) {
        throw new Error("invalid SpecOps V1 repository identity");
    }
    if (
        !isNullableIdentity(state.validatedRepositoryState) ||
        !isNullableIdentity(state.reviewedRepositoryState)
    ) {
        throw new Error("invalid SpecOps V1 evidence repository identity");
    }
    if (!isCorrectionAttempts(state.artifactCorrectionAttempts)) {
        throw new Error("invalid SpecOps V1 artifact correction attempts");
    }
    if (!isRecommendationIds(state.acceptedValidationRecommendationIds)) {
        throw new Error("invalid SpecOps V1 accepted validation recommendations");
    }
    if (!isNonNegativeInteger(state.repairAttempts)) {
        throw new Error("invalid SpecOps V1 repair attempts");
    }
    if (!isFailure(state.failure)) throw new Error("invalid SpecOps V1 failure details");
    if (!isArchiveError(state.archiveError)) {
        throw new Error("invalid SpecOps V1 archive error");
    }
    if (state.archivedAt !== null && !isTimestamp(state.archivedAt)) {
        throw new Error("invalid SpecOps V1 archivedAt timestamp");
    }
    if ((state.status === "blocked" || state.status === "failed") && state.failure === null) {
        throw new Error(`${state.status} SpecOps V1 run requires failure details`);
    }
    if (state.status !== "blocked" && state.status !== "failed" && state.failure !== null) {
        throw new Error("only blocked or failed SpecOps V1 runs may retain failure details");
    }
    return state;
}

/** Return whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Return whether a value is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

/** Return whether a name is a safe canonical OpenSpec change name. */
function isChange(value: unknown): value is string {
    return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value);
}

/** Return whether a value is a valid ISO timestamp. */
function isTimestamp(value: unknown): value is string {
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Return whether a value is a SHA-256 repository identity. */
function isIdentity(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Return whether a value is a SHA-256 repository identity or null. */
function isNullableIdentity(value: unknown): value is string | null {
    return value === null || isIdentity(value);
}

/** Return whether a value is a non-negative integer. */
function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Return whether correction counters contain only supported artifact stages. */
function isCorrectionAttempts(value: unknown): boolean {
    return (
        isRecord(value) &&
        Object.entries(value).every(
            ([stage, attempts]) => ARTIFACT_STAGES.has(stage) && isNonNegativeInteger(attempts),
        )
    );
}

/** Return whether accepted recommendation ids are unique safe command ids. */
function isRecommendationIds(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.every(id => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(id)) &&
        new Set(value).size === value.length
    );
}

/** Return whether terminal failure details are valid. */
function isFailure(value: unknown): value is RunFailure | null {
    return (
        value === null ||
        (isRecord(value) &&
            ["blocked", "validation", "operational", "archive"].includes(String(value.kind)) &&
            isNonEmptyString(value.message) &&
            isTimestamp(value.at))
    );
}

/** Return whether archive error details are valid. */
function isArchiveError(value: unknown): value is ArchiveError | null {
    return (
        value === null ||
        (isRecord(value) &&
            isNonEmptyString(value.message) &&
            isTimestamp(value.attemptedAt) &&
            isIdentity(value.repositoryIdentity))
    );
}

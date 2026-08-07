/** Current on-disk schema version for coarse SpecOps V1 run state. */
const RUN_STATE_VERSION = 1 as const;

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
type RunFailure = {
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
    /**
     * Planning-artifact identity (proposal/specs/design/tasks) bound by the
     * last passing review (B-02). Separate from the implementation repository
     * identity; never merged into one generic identity.
     */
    reviewedPlanningArtifactIdentity: string | null;
    acceptedValidationRecommendationIds: string[];
    /** Canonical accepted validation command definitions accepted at the planning checkpoint. */
    acceptedValidationCommands: AcceptedValidationCommand[];
    artifactCorrectionAttempts: Partial<Record<"proposal" | "specs" | "design" | "tasks", number>>;
    repairAttempts: number;
    failure: RunFailure | null;
    archiveError: ArchiveError | null;
    archivedAt: string | null;
    /** Set immediately before invoking OpenSpec archive; cleared on completion. Crash-safe resume probe. */
    archiveAttemptedAt: string | null;
};

/** Canonical accepted validation command definition persisted at the planning checkpoint. */
export type AcceptedValidationCommand = {
    id: string;
    executable: string;
    args: string[];
    cwd?: string;
    timeoutMs: number;
    maxOutputBytes: number;
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
    "reviewedPlanningArtifactIdentity",
    "acceptedValidationRecommendationIds",
    "acceptedValidationCommands",
    "artifactCorrectionAttempts",
    "repairAttempts",
    "failure",
    "archiveError",
    "archivedAt",
    "archiveAttemptedAt",
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
        reviewedPlanningArtifactIdentity: null,
        acceptedValidationRecommendationIds: [],
        acceptedValidationCommands: [],
        artifactCorrectionAttempts: {},
        repairAttempts: 0,
        failure: null,
        archiveError: null,
        archivedAt: null,
        archiveAttemptedAt: null,
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
        !isNullableIdentity(state.reviewedRepositoryState) ||
        !isNullableIdentity(state.reviewedPlanningArtifactIdentity)
    ) {
        throw new Error("invalid SpecOps V1 evidence repository identity");
    }
    if (!isCorrectionAttempts(state.artifactCorrectionAttempts)) {
        throw new Error("invalid SpecOps V1 artifact correction attempts");
    }
    if (!isRecommendationIds(state.acceptedValidationRecommendationIds)) {
        throw new Error("invalid SpecOps V1 accepted validation recommendations");
    }
    if (!isAcceptedValidationCommands(state.acceptedValidationCommands)) {
        throw new Error("invalid SpecOps V1 accepted validation commands");
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
    if (state.archiveAttemptedAt !== null && !isTimestamp(state.archiveAttemptedAt)) {
        throw new Error("invalid SpecOps V1 archiveAttemptedAt timestamp");
    }
    if ((state.status === "blocked" || state.status === "failed") && state.failure === null) {
        throw new Error(`${state.status} SpecOps V1 run requires failure details`);
    }
    if (state.status !== "blocked" && state.status !== "failed" && state.failure !== null) {
        throw new Error("only blocked or failed SpecOps V1 runs may retain failure details");
    }
    assertRunInvariants(state);
    return state;
}

/**
 * Enforce legal status/stage/evidence/archive cross-invariants so a corrupted
 * `run.json` cannot satisfy a workflow gate (B-06). These are checked on
 * every read so corruption is rejected rather than silently honoured.
 */
function assertRunInvariants(state: RunState): void {
    if (state.status === "completed") {
        if (state.archivedAt === null) {
            throw new Error("completed SpecOps V1 run requires an archivedAt timestamp");
        }
    }
    if (state.status === "verified" && state.stage !== "archive") {
        throw new Error("verified SpecOps V1 run must be at the archive stage");
    }
    if (state.validatedRepositoryState !== null && !hasReachedValidation(state.stage)) {
        throw new Error("validated repository identity recorded before the validation boundary");
    }
    if (state.reviewedRepositoryState !== null && !hasReachedReview(state.stage)) {
        throw new Error("reviewed repository identity recorded before the review boundary");
    }
    if (state.reviewedPlanningArtifactIdentity !== null && !hasReachedReview(state.stage)) {
        throw new Error("reviewed planning artifact identity recorded before the review boundary");
    }
}

/** Return whether a stage is at or beyond the validation boundary. */
function hasReachedValidation(stage: RunStage): boolean {
    const order: readonly RunStage[] = [
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
    ];
    return order.indexOf(stage) >= order.indexOf("validation");
}

/** Return whether a stage is at or beyond the review boundary. */
function hasReachedReview(stage: RunStage): boolean {
    const order: readonly RunStage[] = [
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
    ];
    return order.indexOf(stage) >= order.indexOf("review");
}

/** Validate persisted accepted validation command definitions. */
function isAcceptedValidationCommands(value: unknown): value is AcceptedValidationCommand[] {
    if (!Array.isArray(value)) return false;
    const ids = new Set<string>();
    return value.every(item => {
        if (!isRecord(item)) return false;
        if (
            typeof item.id !== "string" ||
            !/^[a-z0-9][a-z0-9-]{0,127}$/.test(item.id) ||
            ids.has(item.id)
        )
            return false;
        ids.add(item.id);
        return (
            typeof item.executable === "string" &&
            item.executable.trim().length > 0 &&
            Array.isArray(item.args) &&
            item.args.every(arg => typeof arg === "string") &&
            (item.cwd === undefined || typeof item.cwd === "string") &&
            typeof item.timeoutMs === "number" &&
            Number.isInteger(item.timeoutMs) &&
            item.timeoutMs > 0 &&
            typeof item.maxOutputBytes === "number" &&
            Number.isInteger(item.maxOutputBytes) &&
            item.maxOutputBytes > 0
        );
    });
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

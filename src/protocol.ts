/**
 * The complete V1 workflow tool catalogue.
 *
 * These names are intentionally the only workflow-specific tools exposed to
 * OpenCode. Native tasks and questions handle model delegation and user
 * interaction; no tool carries dispatch, scheduler, or provenance state.
 */
export const TOOL_IDS = {
    startOrResume: "specops_start_or_resume",
    reconcileStage: "specops_reconcile_stage",
    getStatus: "specops_get_status",
    runValidation: "specops_run_validation",
    finalize: "specops_finalize",
    cancel: "specops_cancel",
} as const;

/** Union of the six V1 workflow tool identifiers. */
export type ToolId = (typeof TOOL_IDS)[keyof typeof TOOL_IDS];

/** Immutable exact-set catalogue used by registration and drift tests. */
export const ALL_TOOL_IDS: readonly ToolId[] = Object.values(TOOL_IDS);

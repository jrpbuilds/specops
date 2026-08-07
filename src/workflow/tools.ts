/** Exact six-tool V1 workflow catalogue used by commands and plugin registration. */
export const WORKFLOW_TOOL_IDS = {
    startOrResume: "specops_start_or_resume",
    reconcileStage: "specops_reconcile_stage",
    getStatus: "specops_get_status",
    runValidation: "specops_run_validation",
    finalize: "specops_finalize",
    cancel: "specops_cancel",
} as const;

/** Immutable exact set used to detect public-surface drift. */
export const ALL_WORKFLOW_TOOL_IDS = Object.values(WORKFLOW_TOOL_IDS);

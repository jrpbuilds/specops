/**
 * Human-readable, one-line summaries of SpecOps run state for tool output.
 *
 * The orchestrator tools call {@link summarize} instead of dumping raw
 * `RunState` JSON to the user. The full state remains available via
 * `specops_get_status` for anyone who needs it.
 */
import type { RunState } from "./types.js"

/**
 * Render a compact status line for a run state.
 *
 * The summary includes:
 *
 * - a status icon derived from {@link RunState.status};
 * - an optional caller-supplied label (e.g. the completed action);
 * - the change id and scope tier;
 * - the count of completed or total dispatches when the run is active;
 * - a pointer to `specops_get_status` for the full JSON.
 *
 * @param state - The current run state.
 * @param change - The OpenSpec change identifier.
 * @param label - Optional one-word action label (e.g. `Action completed`).
 * @returns A single multi-line string suitable for a tool result.
 */
export function summarize(state: RunState, change: string, label?: string): string {
    const icon = statusIcon(state.status)
    const prefix = label ? `${icon} ${label} —` : icon
    const tier = `tier=${state.scopeTier}`
    const dispatches =
        state.status === "running" || state.status === "paused"
            ? `dispatches=${state.dispatches.filter(d => d.status === "completed").length}/${state.dispatches.length}`
            : undefined

    let line = `${prefix} ${change} (${tier}`
    if (dispatches) {
        line += `, ${dispatches}`
    }
    if (state.outcome) {
        line += `, outcome=${state.outcome.category}`
    }
    if (state.pendingRepair?.taskId) {
        line += `, repair=${state.pendingRepair.taskId.slice(0, 8)}`
    }
    line += ")"

    if ((state.status === "failed" || state.status === "blocked") && state.outcome?.message) {
        line += `\nFailed: ${state.outcome.message}`
    } else if (state.status === "completed") {
        if (state.archivedAt) {
            line += `\nOpenSpec change archived to openspec/changes/archive/.`
        } else {
            line += `\nOpenSpec auto-archive disabled; change remains in openspec/changes/.`
        }
    } else if (state.status === "archive_failed" && state.archiveError) {
        line += `\nArchival failed (${state.archiveError.kind}, attempt ${state.archiveError.attempt}): ${state.archiveError.message}`
        line += `\nRetry via specops_finalize or specops_archive_run after addressing the failure.`
    } else if (state.status === "passed" && state.outcome?.message) {
        line += `\n${state.outcome.message}`
    }

    return `${line}\nFull state: specops_get_status(change="${change}")`
}

/**
 * Pick a compact Unicode status icon for a run state.
 *
 * @param status - The run status.
 * @returns A single-character marker.
 */
function statusIcon(status: RunState["status"]): string {
    switch (status) {
        case "completed":
        case "passed":
            return "✓"
        case "failed":
            return "✗"
        case "archive_failed":
            return "⚠"
        case "cancelled":
            return "⊘"
        case "paused":
            return "⏸"
        case "running":
        case "archiving":
        default:
            return "○"
    }
}

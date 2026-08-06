import type { Config } from "@opencode-ai/plugin";
import { AGENT_IDS } from "./capabilities/ids.js";
import { AGENT_IDS as V1_AGENT_IDS } from "./agents/ids.js";
import { TOOL_IDS } from "./protocol.js";

/**
 * User-facing entry points; every execution path is routed through the
 * scheduler.
 *
 * Keys are OpenCode command names. Each command delegates to a controller
 * agent or invokes a deterministic tool, so users never bypass the workflow.
 */
export const COMMANDS: NonNullable<Config["command"]> = {
    /**
     * Visible deterministic SpecOps workflow. Routes the user prompt to the
     * automatic controller agent which runs end-to-end without checkpoints.
     */
    "specops-auto": {
        agent: AGENT_IDS.controller.automatic,
        subtask: false,
        description: "Run visible deterministic SpecOps workflow",
        template: "Start the deterministic SpecOps workflow for: $ARGUMENTS",
    },
    /**
     * Interactive deterministic SpecOps workflow with checkpoints. Routes the
     * user prompt to the interactive controller agent which pauses at each
     * checkpoint for confirmation.
     */
    specops: {
        agent: V1_AGENT_IDS.coordinator,
        subtask: false,
        description: "Start or resume the interactive SpecOps coordinator run",
        template: "Start or resume the SpecOps coordinator run for: $ARGUMENTS",
    },
    /** Install final SpecOps OpenSpec assets in the current directory. */
    "specops-onboard": {
        description: "Install final SpecOps OpenSpec assets",
        template: `Call ${TOOL_IDS.onboard}.`,
    },
    /** Show the final SpecOps run status for the active change. */
    "specops-status": {
        description: "Show final SpecOps run status",
        template: `Call ${TOOL_IDS.getStatus} for the active change.`,
    },
    /** Maintenance: archive or retry-archive a verified or completed-unarchived change. */
    "specops-archive": {
        agent: AGENT_IDS.controller.interactive,
        subtask: false,
        description: "Archive a verified or completed-unarchived change (maintenance)",
        template: `Call ${TOOL_IDS.archive} for the active change to perform maintenance archival.`,
    },
    /** Diagnose the final SpecOps installation and configuration. */
    "specops-doctor": {
        description: "Diagnose final SpecOps installation",
        template: `Call ${TOOL_IDS.doctor}.`,
    },
};

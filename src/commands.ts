import type { Config } from "@opencode-ai/plugin"
import { AGENT_IDS } from "./capabilities/ids.js"
import { TOOL_IDS } from "./protocol.js"

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
        agent: AGENT_IDS.controller.interactive,
        subtask: false,
        description: "Run deterministic SpecOps workflow with checkpoints",
        template: "Start the interactive deterministic SpecOps workflow for: $ARGUMENTS",
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
    /** Archive a passed SpecOps run's OpenSpec change after confirmation. */
    "specops-archive": {
        agent: AGENT_IDS.controller.interactive,
        subtask: false,
        description: "Archive a passed SpecOps run's OpenSpec change",
        template:
            `Request archive confirmation with ${TOOL_IDS.archive}, ask the user with the native question tool, ` +
            `then submit the decision through ${TOOL_IDS.confirmArchive}.`,
    },
    /** Diagnose the final SpecOps installation and configuration. */
    "specops-doctor": {
        description: "Diagnose final SpecOps installation",
        template: `Call ${TOOL_IDS.doctor}.`,
    },
}

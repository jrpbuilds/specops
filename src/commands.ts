import type { Config } from "@opencode-ai/plugin";
import { AGENT_IDS } from "./agents/ids.js";
import { WORKFLOW_TOOL_IDS } from "./workflow/tools.js";

/**
 * The complete public SpecOps command catalogue.
 *
 * Commands deliberately provide only the interactive V1 workflow entrypoints.
 * They route work through the coordinator or a deterministic maintenance tool;
 * no command exposes automatic execution or a separate archive path.
 */
export const COMMANDS: NonNullable<Config["command"]> = {
    specops: {
        agent: AGENT_IDS.coordinator,
        subtask: false,
        description: "Start or resume an interactive SpecOps run",
        template: "Start or resume SpecOps coordinator run for: $ARGUMENTS",
    },
    "specops-status": {
        description: "Show the current SpecOps run status",
    template: `Call ${WORKFLOW_TOOL_IDS.getStatus} for the active change.`,
    },
    "specops-cancel": {
        description: "Cancel the current SpecOps run and preserve its work",
    template: `Call ${WORKFLOW_TOOL_IDS.cancel} for the active change.`,
    },
    "specops-doctor": {
        description: "Diagnose the SpecOps installation and current project",
        template: "Run SpecOps installation diagnostics for the current project.",
    },
    "specops-onboard": {
        description: "Set up standard OpenSpec support for this project",
        template: "Initialize or verify standard OpenSpec support for the current project.",
    },
};

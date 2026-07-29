/**
 * OpenCode command definitions registered by the SpecOps plugin.
 *
 * Commands are user-invoked entry points (e.g. `/specops-auto <goal>`). The
 * plugin registers these programmatically via its `config()` hook so no
 * `opencode.json` mutation is required to use them.
 */

import type { Config } from "@opencode-ai/plugin"

/**
 * The complete SpecOps command table. Includes the two controller-driven
 * automatic modes, the interactive mode, the onboarding/status/doctor
 * utilities, the standalone judgment and review-panel commands, and the nine
 * granular stage commands (`/sdd-init`, `/sdd-explore`, etc.).
 */
export const COMMANDS: NonNullable<Config["command"]> = {
  "specops-auto": {
    agent: "specops-auto",
    subtask: false,
    description: "Run visible, inspectable SpecOps workers without phase checkpoints",
    template:
      "Run the adaptive visible SpecOps automatic workflow for this invocation: $ARGUMENTS. Assess and select the smallest safe tier, auto-escalate on new evidence, and launch every named specialist through the built-in task tool. Do not call specops_run_auto.",
  },
  "specops-auto-headless": {
    description: "Run compact headless SpecOps automation for CI or non-interactive use",
    template:
      "Call the specops_run_auto tool exactly once with goal set to $ARGUMENTS. This is the compact headless runner, so child sessions may not appear in OpenCode's native subagent pane. Configured MCP tools remain optional. Do not perform an external write, commit, push, or other Git mutation. Report its final marker and do not claim success if the tool fails.",
  },
  specops: {
    agent: "specops",
    subtask: false,
    description: "Run SpecOps interactively with approval checkpoints",
    template:
      "Run the adaptive interactive SpecOps workflow for this invocation: $ARGUMENTS. Automatically select and announce the minimum safe tier; do not ask the user to choose it. Use native task workers, auto-escalate when evidence requires it, and retain approval checkpoints after each phase and before implementation and archive. Never invoke specops_run_auto.",
  },
  "sdd-onboard": {
    description: "Install or refresh repo-local SpecOps/OpenSpec project memory",
    template:
      "Call specops_onboard with context set to $ARGUMENTS. Report the durable openspec/onboarding.md path and the setup result.",
  },
  "specops-status": {
    description: "Show active OpenSpec changes and SpecOps evidence status",
    template:
      "Call specops_openspec with args [\"list\",\"--json\"], then summarize active changes. Read specops-run.json and routing.md to report selected tier, schema, rationale, and escalation history. Read any specops-progress.json for phase, elapsed time, remediation cycle, workers, retries, and errors. Inspect specops-receipt.json for tier gates and freshness.",
  },
  "specops-doctor": {
    description: "Diagnose SpecOps, Git, OpenSpec, schema, and integration readiness",
    template: "Call specops_doctor and report every check exactly.",
  },
  "specops-judgment-day": {
    description: "Run both independent judges and prepare remediation when needed",
    template:
      "Collect the complete current implementation diff excluding openspec/, then call specops_judgment_day with the diff and task description: $ARGUMENTS",
  },
  "specops-review-panel": {
    description: "Run four specialist reviewers and the refuter",
    template:
      "Collect the complete current implementation diff excluding openspec/, then call specops_review_panel with that diff.",
  },
}

/**
 * Register the nine granular stage commands (`/sdd-init`, `/sdd-explore`, etc.)
 * onto the {@link COMMANDS} table. Each delegates to its named subagent and
 * instructs it to re-read current OpenSpec instructions from disk.
 */
for (const [stage, agent] of [
  ["init", "sdd-init"],
  ["explore", "sdd-explore"],
  ["propose", "sdd-propose"],
  ["spec", "sdd-spec"],
  ["design", "sdd-design"],
  ["tasks", "sdd-tasks"],
  ["apply", "sdd-apply"],
  ["verify", "sdd-verify"],
  ["archive", "sdd-archive"],
] as const) {
  COMMANDS[`sdd-${stage}`] = {
    description: `Run the SpecOps ${stage} stage`,
    template: `Run the ${stage} phase for the active SpecOps change using the ${agent} subagent. Re-read current OpenSpec instructions and dependencies from disk. Scope/context: $ARGUMENTS`,
  }
}

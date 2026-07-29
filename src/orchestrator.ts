/**
 * SpecOps plugin entry: command and tool registration.
 *
 * This slimmed orchestrator wires the 17 commands and 13 tools onto the
 * OpenCode plugin hook. All heavy logic lives in the split modules; this file
 * is intentionally thin so the plugin surface is easy to audit.
 */

import type { Config, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import path from "node:path"
import { stat } from "node:fs/promises"
import {
  WORKFLOW_PLANS,
  type WorkflowPlan,
} from "./core.js"
import {
  linkedWorkerReporter,
  ProgressTracker,
  type AgentRunner,
  type MetadataContext,
} from "./progress.js"
import { stripFence } from "./parsing.js"
import { implementationFootprint, footprintEscalation, collectDiff } from "./git.js"
import {
  onboard,
  onboardWithContext,
  openSpecOrThrow,
  readConfig,
  READ_ONLY_OPENSPEC_COMMANDS,
  writeArtifact,
} from "./openspec.js"
import {
  judgmentDayWithRunner,
  reviewPanelWithRunner,
} from "./judgment.js"
import {
  escalateVisibleRun,
  finalizeVisibleRun,
  prepareVisibleRun,
  readAdaptiveRun,
} from "./runs.js"
import { runAutomatic } from "./automation.js"
import { doctor } from "./doctor.js"
import { COMMANDS } from "./commands.js"
import { SPECOPS_CONTROLLER_PROMPT, SPECOPS_INTERACTIVE_PROMPT } from "./prompts-controller.js"
import { waitForProvider } from "./runner.js"

/**
 * The SpecOps plugin. Registered by `index.ts` via the default export.
 *
 * The plugin:
 * 1. Reads the project's `.opencode/specops.json` configuration.
 * 2. Creates an {@link AgentRunner} bound to the current session.
 * 3. Exposes the `config()` hook to register commands and the two controllers.
 * 4. Exposes 13 tools used by the controllers and standalone commands.
 */
export const SpecOpsPlugin: Plugin = async (input) => {
  const config = await readConfig(input.directory)
  const runner = await createRunner(input, config)
  return {
    config: async (openCodeConfig) => {
      openCodeConfig.command ??= {}
      for (const [name, command] of Object.entries(COMMANDS)) {
        openCodeConfig.command[name] ??= command
      }
      openCodeConfig.agent ??= {}
      openCodeConfig.agent["specops-auto"] ??= {
        mode: "primary",
        model: "opencode/deepseek-v4-flash-free",
        steps: 1000,
        prompt: SPECOPS_CONTROLLER_PROMPT,
        tools: {
          question: false,
          todowrite: false,
          task: true,
        },
      }
      openCodeConfig.agent.specops ??= {
        mode: "primary",
        model: "opencode/deepseek-v4-flash-free",
        steps: 1000,
        prompt: SPECOPS_INTERACTIVE_PROMPT,
        tools: {
          question: true,
          todowrite: false,
          task: true,
        },
      }
    },
    tool: {
      specops_prepare_auto: tool({
        description:
          "Validate an sdd-assess result, select the minimum safe workflow, prepare its OpenSpec change, and return the authoritative tier plan.",
        args: {
          goal: tool.schema.string().min(1),
          assessment: tool.schema.string().min(1),
          requestedTier: tool.schema.enum(["auto", "lean", "standard", "full"]),
        },
        async execute(args, context) {
          return JSON.stringify(
            await prepareVisibleRun(
              context.directory,
              await readConfig(context.directory),
              args.goal,
              args.assessment,
              args.requestedTier,
            ),
            null,
            2,
          )
        },
      }),
      specops_escalate_auto: tool({
        description:
          "Monotonically escalate an adaptive SpecOps change, update its OpenSpec schema, and return the newly authoritative workflow plan.",
        args: {
          change: tool.schema.string().regex(/^[a-z0-9][a-z0-9-]*$/),
          target: tool.schema.enum(["standard", "full"]),
          reason: tool.schema.string().min(1),
        },
        async execute(args, context) {
          return JSON.stringify(
            await escalateVisibleRun(context.directory, args.change, args.target, args.reason),
            null,
            2,
          )
        },
      }),
      specops_wait_for_provider: tool({
        description:
          "Wait before retrying the same native worker after a transient provider capacity or streaming failure. This does not change workflow state.",
        args: {
          agent: tool.schema.string().min(1),
          attempt: tool.schema.number().int().min(1),
        },
        async execute(args, context) {
          const seconds = Math.min(30, 5 * 2 ** Math.min(args.attempt - 1, 3))
          await waitForProvider(seconds, context.abort)
          return `Provider retry wait completed for ${args.agent} after ${seconds}s. Relaunch the same task with unchanged arguments.`
        },
      }),
      specops_save_onboarding: tool({
        description:
          "Persist complete sdd-onboard Markdown as the repo-local OpenSpec project memory.",
        args: {
          content: tool.schema.string().min(1),
        },
        async execute(args, context) {
          await onboard(context.directory)
          const destination = path.join(context.directory, "openspec", "onboarding.md")
          const { writeFile } = await import("node:fs/promises")
          await writeFile(destination, stripFence(args.content), "utf-8")
          return "Stored project memory at openspec/onboarding.md"
        },
      }),
      specops_save_artifact: tool({
        description:
          "Persist one native worker output beneath an existing OpenSpec change using a safe relative path.",
        args: {
          change: tool.schema.string().regex(/^[a-z0-9][a-z0-9-]*$/),
          path: tool.schema.string().min(1),
          content: tool.schema.string().min(1),
        },
        async execute(args, context) {
          if (
            ![
              "init.md",
              "exploration.md",
              "proposal.md",
              "design.md",
              "tasks.md",
              "verification.md",
            ].includes(args.path) &&
            !/^specs\/[a-z0-9][a-z0-9-]*\/spec\.md$/.test(args.path)
          ) {
            throw new Error(`Artifact path is not controller-writable: ${args.path}`)
          }
          await stat(
            path.join(
              context.directory,
              "openspec",
              "changes",
              args.change,
              ".openspec.yaml",
            ),
          )
          await writeArtifact(context.directory, args.change, args.path, args.content)
          return `Stored openspec/changes/${args.change}/${args.path}`
        },
      }),
      specops_diff: tool({
        description:
          "Collect the complete bounded implementation diff for visible judges and reviewers, excluding OpenSpec memory and evidence.",
        args: {},
        async execute(_args, context) {
          const current = await readConfig(context.directory)
          return collectDiff(context.directory, current.review.max_diff_bytes)
        },
      }),
      specops_check_scope: tool({
        description:
          "Measure the actual implementation footprint and automatically escalate when configured file/module thresholds exceed the active tier.",
        args: {
          change: tool.schema.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        },
        async execute(args, context) {
          const current = await readConfig(context.directory)
          const changeDirectory = path.join(
            context.directory,
            "openspec",
            "changes",
            args.change,
          )
          const run = await readAdaptiveRun(changeDirectory)
          const footprint = await implementationFootprint(context.directory)
          const target = footprintEscalation(run.tier, footprint, current)
          if (!target) {
            return JSON.stringify({
              escalated: false,
              plan: WORKFLOW_PLANS[run.tier],
              footprint,
            })
          }
          return JSON.stringify(
            {
              ...(await escalateVisibleRun(
                context.directory,
                args.change,
                target,
                `Actual implementation footprint is ${footprint.files} files across ${footprint.modules} modules.`,
              )),
              footprint,
            },
            null,
            2,
          )
        },
      }),
      specops_finalize_auto: tool({
        description:
          "Persist final visible judge/review evidence, enforce gates and freshness, strictly validate, and archive a passing change.",
        args: {
          change: tool.schema.string().regex(/^[a-z0-9][a-z0-9-]*$/),
          goal: tool.schema.string().min(1),
          cycle: tool.schema.number().int().min(0).max(10),
          judgeA: tool.schema.string().min(1),
          judgeB: tool.schema.string().optional(),
          ledger: tool.schema.string().min(1),
          panelEvidence: tool.schema.string().min(1),
          completedReviewers: tool.schema.array(
            tool.schema.enum([
              "review-risk",
              "review-readability",
              "review-reliability",
              "review-resilience",
            ]),
          ),
          refuterUsed: tool.schema.boolean(),
        },
        async execute(args, context) {
          return finalizeVisibleRun(
            context.directory,
            await readConfig(context.directory),
            args,
          )
        },
      }),
      specops_onboard: tool({
        description:
          "Create missing repo-local OpenSpec/SpecOps assets and refresh durable onboarding memory without replacing OpenSpec configuration.",
        args: {
          context: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const report = linkedWorkerReporter(context, "SpecOps onboarding")
          const observed: AgentRunner = (agent, prompt, parent) =>
            runner(agent, prompt, parent, report, context.abort)
          const result = await onboardWithContext(
            context.directory,
            observed,
            args.context ?? "",
            context.sessionID,
          )
          return `${result.message}\nStored refreshed project memory at openspec/onboarding.md.`
        },
      }),
      specops_doctor: tool({
        description: "Run read-only SpecOps readiness diagnostics.",
        args: {},
        async execute(_args, context) {
          return doctor(context.directory, await readConfig(context.directory))
        },
      }),
      specops_openspec: tool({
        description:
          "Run a read-only bundled OpenSpec CLI command. Pass argv without the openspec executable.",
        args: {
          args: tool.schema.array(tool.schema.string()).min(1),
        },
        async execute(args, context) {
          if (!READ_ONLY_OPENSPEC_COMMANDS.has(args.args[0])) {
            throw new Error(`OpenSpec command is not permitted by this read-only tool: ${args.args[0]}`)
          }
          return openSpecOrThrow(
            context.directory,
            await readConfig(context.directory),
            args.args,
            context.abort,
          )
        },
      }),
      specops_judgment_day: tool({
        description:
          "Run two independent judges in parallel; if either fails, invoke the fix agent to produce a remediation plan.",
        args: {
          diff: tool.schema.string().min(1),
          taskDescription: tool.schema.string().min(1),
        },
        async execute(args, context) {
          const report = linkedWorkerReporter(context, "SpecOps Judgment Day")
          const observed: AgentRunner = (agent, prompt, parent) =>
            runner(agent, prompt, parent, report, context.abort)
          return JSON.stringify(
            await judgmentDayWithRunner(observed, args.diff, args.taskDescription, context.sessionID),
            null,
            2,
          )
        },
      }),
      specops_review_panel: tool({
        description:
          "Run risk, readability, reliability, and resilience reviews in parallel, then refute and prioritize them.",
        args: {
          diff: tool.schema.string().min(1),
        },
        async execute(args, context) {
          const report = linkedWorkerReporter(context, "SpecOps review panel")
          const observed: AgentRunner = (agent, prompt, parent) =>
            runner(agent, prompt, parent, report, context.abort)
          return JSON.stringify(
            await reviewPanelWithRunner(observed, args.diff, context.sessionID),
            null,
            2,
          )
        },
      }),
      specops_run_auto: tool({
        description:
          "Run the complete SpecOps workflow from goal through implementation, bounded remediation, review, evidence receipt, and archive.",
        args: {
          goal: tool.schema.string().min(1),
        },
        async execute(args, context) {
          const progress = new ProgressTracker(
            context as MetadataContext,
            context.directory,
            args.goal,
            context.abort,
          )
          try {
            const output = await runAutomatic(
              input,
              runner,
              await readConfig(context.directory),
              args.goal,
              context.sessionID,
              progress,
            )
            return progress.result(output)
          } catch (error) {
            await progress.finish(context.abort.aborted ? "cancelled" : "failed", error)
            throw error
          }
        },
      }),
    },
  }
}

/**
 * Create the agent runner lazily, avoiding a circular import between
 * `runner.ts` (which imports `progress.ts`) and this module (which imports both).
 */
async function createRunner(
  input: PluginInput,
  config: Awaited<ReturnType<typeof readConfig>>,
): Promise<AgentRunner> {
  const { createAgentRunner } = await import("./runner.js")
  return createAgentRunner(input, config)
}

/** Re-exported for the index module and consumers that need the raw plugin. */
export { SpecOpsPlugin as default, type WorkflowPlan }

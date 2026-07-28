/**
 * Adaptive run preparation, escalation, and finalization.
 *
 * These functions are the heart of the visible SpecOps workflow: they turn an
 * assessment into a prepared OpenSpec change, monotonically escalate its tier
 * when evidence requires it, and finalize+archive it once every gate passes.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  hashArtifactTree,
  higherTier,
  receiptIsFresh,
  type SpecOpsConfig,
  type SpecOpsReceipt,
  type TierAssessment,
  selectWorkflowTier,
  sha256,
  WORKFLOW_PLANS,
  type WorkflowPlan,
  type WorkflowTier,
} from "./core.js"
import type { AgentRunner } from "./progress.js"
import { escalationMarker, parseAssessment, parseTierInvocation } from "./parsing.js"
import {
  assertCleanWorktree,
  baseCommit,
  collectDiff,
  implementationFootprint,
  footprintEscalation,
} from "./git.js"
import { onboard, openSpecOrThrow, uniqueChangeName, writeArtifact } from "./openspec.js"

/** A single monotonic tier transition recorded in the run's tier history. */
export type TierHistoryEntry = {
  from: WorkflowTier
  to: WorkflowTier
  reason: string
  at: string
}

/** The on-disk adaptive run state written to `specops-run.json`. */
export type AdaptiveRunState = {
  version: 2
  mode: "visible-controller" | "headless"
  goal: string
  base_commit: string
  requested_tier: "auto" | WorkflowTier
  initial_tier: WorkflowTier
  tier: WorkflowTier
  schema: WorkflowPlan["schema"]
  assessment: TierAssessment
  routing_reasons: string[]
  tier_history: TierHistoryEntry[]
  created_at: string
}

/**
 * Prepare a visible adaptive run: validate the assessment, select the workflow
 * tier, create the OpenSpec change, write the routing artifact, and persist
 * the run state. Returns everything the controller needs to drive the run.
 *
 * @param directory - The project root.
 * @param config - The merged SpecOps configuration.
 * @param goal - The user's goal (may include a `--tier=` prefix).
 * @param assessmentOutput - The raw `sdd-assess` JSON output.
 * @param requestedTier - The requested minimum tier (`"auto"` when unspecified).
 */
export async function prepareVisibleRun(
  directory: string,
  config: SpecOpsConfig,
  goal: string,
  assessmentOutput: string,
  requestedTier: "auto" | WorkflowTier,
): Promise<{
  change: string
  goal: string
  baseline: string
  changeDirectory: string
  onboardingRequired: boolean
  plan: WorkflowPlan
  routingReasons: string[]
  maxFixCycles: number
}> {
  const invocation = parseTierInvocation(goal)
  goal = invocation.goal
  if (
    requestedTier !== "auto" &&
    invocation.requestedTier !== "auto" &&
    requestedTier !== invocation.requestedTier
  ) {
    throw new Error("Conflicting requested workflow tiers")
  }
  if (requestedTier === "auto") requestedTier = invocation.requestedTier
  if (config.automation.require_clean_worktree) await assertCleanWorktree(directory)
  const baseline = await baseCommit(directory)
  const onboardingRequired =
    config.workflow.onboarding === "always" ||
    !(await readFile(path.join(directory, "openspec", "onboarding.md"))
      .then(() => true)
      .catch(() => false))
  await onboard(directory)
  const assessment = parseAssessment(assessmentOutput)
  const selected = selectWorkflowTier(assessment, requestedTier, config)
  const change = await uniqueChangeName(directory, goal)
  await openSpecOrThrow(directory, config, [
    "new",
    "change",
    change,
    "--schema",
    selected.plan.schema,
    "--goal",
    goal,
    "--json",
  ])
  const changeDirectory = path.join(directory, "openspec", "changes", change)
  const state: AdaptiveRunState = {
    version: 2,
    mode: "visible-controller",
    goal,
    base_commit: baseline,
    requested_tier: requestedTier,
    initial_tier: selected.plan.tier,
    tier: selected.plan.tier,
    schema: selected.plan.schema,
    assessment,
    routing_reasons: selected.reasons,
    tier_history: [],
    created_at: new Date().toISOString(),
  }
  await writeFile(
    path.join(changeDirectory, "specops-run.json"),
    JSON.stringify(state, null, 2) + "\n",
    "utf-8",
  )
  await writeArtifact(
    directory,
    change,
    "routing.md",
    `# Adaptive Routing\n\n- Selected tier: **${selected.plan.tier}**\n- OpenSpec schema: \`${selected.plan.schema}\`\n- Expected files: ${assessment.expected_files}\n- Expected modules: ${assessment.expected_modules}\n\n## Reasons\n\n${selected.reasons.map((reason) => `- ${reason}`).join("\n")}\n\n## Evidence\n\n${assessment.evidence.map((item) => `- ${item}`).join("\n")}\n`,
  )
  return {
    change,
    goal,
    baseline,
    changeDirectory,
    onboardingRequired,
    plan: selected.plan,
    routingReasons: selected.reasons,
    maxFixCycles: config.automation.max_fix_cycles,
  }
}

/**
 * Read the adaptive run state from a change directory.
 *
 * @param changeDirectory - Absolute path to the OpenSpec change directory.
 * @throws {Error} when the state file is missing or unsupported.
 */
export async function readAdaptiveRun(changeDirectory: string): Promise<AdaptiveRunState> {
  const value = JSON.parse(
    await readFile(path.join(changeDirectory, "specops-run.json"), "utf-8"),
  ) as AdaptiveRunState
  if (value.version !== 2 || !WORKFLOW_PLANS[value.tier]) {
    throw new Error("SpecOps adaptive run state is missing or unsupported")
  }
  return value
}

/**
 * Monotonically escalate an adaptive run to a higher tier.
 *
 * Updates the OpenSpec change's schema, the run state's tier and tier history,
 * and the routing artifact. No-op (returns `escalated: false`) when the
 * target tier is not higher than the current tier.
 *
 * @param directory - The project root.
 * @param change - The OpenSpec change slug.
 * @param target - The requested target tier.
 * @param reason - Human-readable reason for the escalation.
 */
export async function escalateVisibleRun(
  directory: string,
  change: string,
  target: WorkflowTier,
  reason: string,
): Promise<{ escalated: boolean; plan: WorkflowPlan; history: TierHistoryEntry[] }> {
  if (!reason.trim()) throw new Error("Escalation reason is required")
  const changeDirectory = path.join(directory, "openspec", "changes", change)
  const state = await readAdaptiveRun(changeDirectory)
  const next = higherTier(state.tier, target)
  if (next === state.tier) {
    return { escalated: false, plan: WORKFLOW_PLANS[state.tier], history: state.tier_history }
  }
  const entry: TierHistoryEntry = {
    from: state.tier,
    to: next,
    reason: reason.trim(),
    at: new Date().toISOString(),
  }
  const plan = WORKFLOW_PLANS[next]
  const metadataPath = path.join(changeDirectory, ".openspec.yaml")
  const metadata = await readFile(metadataPath, "utf-8")
  if (!/^schema:[ \t]*[a-z0-9-]+[ \t]*$/m.test(metadata)) {
    throw new Error("OpenSpec change metadata has no safe schema field")
  }
  await writeFile(
    metadataPath,
    metadata.replace(/^schema:[ \t]*[a-z0-9-]+[ \t]*$/m, `schema: ${plan.schema}`),
    "utf-8",
  )
  state.tier = next
  state.schema = plan.schema
  state.tier_history.push(entry)
  await writeFile(
    path.join(changeDirectory, "specops-run.json"),
    JSON.stringify(state, null, 2) + "\n",
    "utf-8",
  )
  await writeFile(
    path.join(changeDirectory, "routing.md"),
    (await readFile(path.join(changeDirectory, "routing.md"), "utf-8")) +
      `\n## Escalation ${state.tier_history.length}\n\n- From: **${entry.from}**\n- To: **${entry.to}**\n- At: ${entry.at}\n- Reason: ${entry.reason}\n`,
    "utf-8",
  )
  return { escalated: true, plan, history: state.tier_history }
}

/**
 * Finalize a visible adaptive run: enforce all gates, persist evidence,
 * validate, and archive. Returns a JSON string describing the outcome.
 *
 * Gates checked, in order:
 * 1. Footprint escalation (the actual diff outgrew the tier).
 * 2. Requested escalation markers from any judge or reviewer.
 * 3. Judgment pass (all required judges emitted `[PASS]`).
 * 4. Review completeness (all required reviewers + refuter ran).
 * 5. No blocking findings in the refuted ledger.
 *
 * On success, writes the receipt, re-checks freshness, validates, and archives.
 *
 * @param directory - The project root.
 * @param config - The merged SpecOps configuration.
 * @param input - The finalization inputs from the controller.
 */
export async function finalizeVisibleRun(
  directory: string,
  config: SpecOpsConfig,
  input: {
    change: string
    goal: string
    cycle: number
    judgeA: string
    judgeB?: string
    ledger: string
    panelEvidence: string
    completedReviewers: WorkflowPlan["reviewers"]
    refuterUsed: boolean
  },
): Promise<string> {
  const { hasBlockingFinding, hasStandalonePass } = await import("./core.js")
  const changeDirectory = path.join(directory, "openspec", "changes", input.change)
  const run = await readAdaptiveRun(changeDirectory)
  if (run.goal !== input.goal) throw new Error("Finalization goal does not match prepared run")
  const plan = WORKFLOW_PLANS[run.tier]

  const diff = await collectDiff(directory, config.review.max_diff_bytes)
  const diffHash = sha256(diff)
  const judgeAPassed = hasStandalonePass(input.judgeA)
  const judgeBPassed = input.judgeB ? hasStandalonePass(input.judgeB) : false
  const judgesPassed =
    judgeAPassed && (!plan.judges.includes("jd-judge-b") || judgeBPassed)
  const completed = new Set(input.completedReviewers)
  const missingReviewers = plan.reviewers.filter((reviewer) => !completed.has(reviewer))
  const refuterMissing = plan.refuter && !input.refuterUsed
  const blocking = hasBlockingFinding(input.ledger, config.automation.blocking_severities)
  const footprint = await implementationFootprint(directory)
  const footprintTarget = footprintEscalation(run.tier, footprint, config)
  if (footprintTarget) {
    return JSON.stringify({
      passed: false,
      gate: "escalation",
      target: footprintTarget,
      footprint,
      action:
        "Call specops_escalate_auto because the actual diff exceeds the current tier, then rebuild missing planning and evidence.",
    })
  }
  const requestedEscalation = [
    input.judgeA,
    input.judgeB ?? "",
    input.ledger,
    input.panelEvidence,
  ]
    .map(escalationMarker)
    .filter((tier): tier is WorkflowTier => Boolean(tier))
    .reduce<WorkflowTier | undefined>(
      (current, tier) => (current ? higherTier(current, tier) : tier),
      undefined,
    )
  if (requestedEscalation && higherTier(run.tier, requestedEscalation) !== run.tier) {
    return JSON.stringify({
      passed: false,
      gate: "escalation",
      target: requestedEscalation,
      action:
        "Call specops_escalate_auto, create newly required artifacts, and repeat apply and evidence.",
    })
  }
  await writeArtifact(
    directory,
    input.change,
    "judgment.md",
    `# Judgment Day\n\n## Reviewed Snapshot\n\n- Tier: **${run.tier}**\n- Diff SHA-256: \`${diffHash}\`\n- Remediation cycle: ${input.cycle}\n\n## Judge A\n\n${input.judgeA}\n\n## Judge B\n\n${input.judgeB ?? "Not required by this workflow tier."}\n\n## Verdict\n\n${judgesPassed ? "[PASS]" : "[FAIL]"}\n`,
  )
  await writeArtifact(
    directory,
    input.change,
    "review-ledger.md",
    `# Review Ledger\n\n## Reviewed Snapshot\n\n- Tier: **${run.tier}**\n- Diff SHA-256: \`${diffHash}\`\n- Required reviewers: ${plan.reviewers.join(", ")}\n- Refuter required: ${plan.refuter ? "yes" : "no"}\n\n## Synthesized Findings\n\n${input.ledger}\n\n## Panel Evidence\n\n${input.panelEvidence}\n`,
  )
  if (!judgesPassed) {
    return JSON.stringify({
      passed: false,
      gate: "judgment",
      judge_a_passed: judgeAPassed,
      judge_b_passed: judgeBPassed,
      action: "Run a visible jd-fix-agent task, then repeat verification and both judges.",
    })
  }
  if (missingReviewers.length || refuterMissing) {
    return JSON.stringify({
      passed: false,
      gate: "review-completeness",
      missing_reviewers: missingReviewers,
      refuter_missing: refuterMissing,
      action: "Run every review worker required by the selected tier before finalization.",
    })
  }
  if (blocking) {
    return JSON.stringify({
      passed: false,
      gate: "review",
      action:
        "Run a visible jd-fix-agent task for defensible BLOCKER/HIGH findings, then repeat verification, Judgment Day, and review.",
    })
  }

  const artifactHash = await hashArtifactTree(changeDirectory)
  const receipt: SpecOpsReceipt = {
    version: 2,
    change: input.change,
    goal: input.goal,
    tier: run.tier,
    tier_history: run.tier_history,
    base_commit: run.base_commit,
    diff_sha256: diffHash,
    artifacts_sha256: artifactHash,
    verified_at: new Date().toISOString(),
    fix_cycles: input.cycle,
    judgment: {
      required: plan.judges,
      passed: plan.judges,
    },
    review: {
      required: plan.reviewers,
      completed: plan.reviewers,
      refuter_required: plan.refuter,
      blocking_findings: false,
      ledger_sha256: sha256(input.ledger),
    },
    test_evidence: { source: "openspec-verification", fabricated: false },
  }
  await writeFile(
    path.join(changeDirectory, "specops-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    "utf-8",
  )
  const fresh = receiptIsFresh(receipt, {
    baseCommit: await baseCommit(directory),
    diffHash: sha256(await collectDiff(directory, config.review.max_diff_bytes)),
    artifactHash: await hashArtifactTree(changeDirectory),
  })
  if (!fresh) throw new Error("[SPECOPS:FAIL] Evidence became stale before archive")
  await openSpecOrThrow(directory, config, ["validate", input.change, "--strict", "--json"])
  await openSpecOrThrow(directory, config, ["archive", input.change, "--yes"])
  return JSON.stringify({
    passed: true,
    marker: "[SPECOPS:PASS]",
    change: input.change,
    fix_cycles: input.cycle,
  })
}

/** Re-export for the automation module. */
export { receiptIsFresh }

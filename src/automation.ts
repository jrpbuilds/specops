/**
 * The 13-phase headless automatic workflow.
 *
 * {@link runAutomatic} drives the complete SpecOps pipeline from goal through
 * archive: assessment, onboarding, planning, validate, apply, verify, judgment,
 * review, evidence receipt, and archive. Escalation is monotonic; remediation
 * is bounded by `automation.max_fix_cycles`.
 */

import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import {
  hashArtifactTree,
  hasBlockingFinding,
  higherTier,
  type SpecOpsConfig,
  type SpecOpsReceipt,
  type WorkflowPlan,
  type WorkflowTier,
  selectWorkflowTier,
  sha256,
  WORKFLOW_PLANS,
} from "./core.js"
import {
  type AgentRunner,
  ProgressTracker,
} from "./progress.js"
import {
  parseAssessment,
  parseTierInvocation,
  untrusted,
} from "./parsing.js"
import {
  adjudicateEscalation,
  parseEscalationRequest,
  type EscalationDecision,
} from "./escalation.js"
import {
  assertCleanWorktree,
  baseCommit,
  collectDiff,
  footprintEscalation,
  implementationFootprint,
} from "./git.js"
import {
  generateArtifact,
  instructions,
  onboard,
  onboardWithContext,
  openSpecOrThrow,
  uniqueChangeName,
  writeArtifact,
} from "./openspec.js"
import {
  adaptiveJudgmentWithRunner,
  adaptiveReviewWithRunner,
} from "./judgment.js"
import {
  escalateVisibleRun,
  type AdaptiveRunState,
  readAdaptiveRun,
  receiptIsFresh,
} from "./runs.js"

const ESCALATION_INSTRUCTIONS = `If the current tier is genuinely insufficient, end your response with one line beginning ESCALATION_JSON: followed by this exact JSON shape: {"escalation":{"target":"standard|full","category":"scope_overflow|public_contract|security|migration|concurrency|requirements_changed|blocked","confidence":"low|medium|high","summary":"...","evidence":["path or command evidence"],"boundary_crossed":"...","why_current_tier_is_insufficient":"..."}}. Do not request escalation for vague uncertainty, style preferences, or provider capacity failures.`

/**
 * Run the complete headless SpecOps automatic workflow for a goal.
 *
 * The workflow is a 13-phase state machine:
 * 0. Preflight (clean worktree check, baseline commit).
 * 1. Assessment (`sdd-assess` → `selectWorkflowTier`).
 * 2. Onboarding (if missing or `onboarding: "always"`).
 * 3-7. Planning stages (per the tier's `plan.planning`).
 * 8. Apply (`sdd-apply`).
 * 9. Verify (`sdd-verify`).
 * 10. Judgment Day (adaptive judges).
 * 11. Review panel (adaptive reviewers + refuter).
 * 12. Archive (receipt, freshness check, validate, archive).
 *
 * Validated structured escalation requests from any worker trigger a tier upgrade via
 * {@link escalateVisibleRun}, after which the run rebuilds the newly required
 * artifacts and re-runs apply/verify. Remediation cycles (judgment or review
 * failures) loop back to verify up to `automation.max_fix_cycles`.
 *
 * @param input - The OpenCode plugin input (provides the SDK client and directory).
 * @param runner - The agent runner bound to the current session.
 * @param config - The merged SpecOps configuration.
 * @param goal - The user's goal text (may include a `--tier=` prefix).
 * @param parentID - The parent session ID for worker spawns.
 * @param progress - The progress tracker for this run.
 * @returns A `[SPECOPS:PASS]` summary on success.
 * @throws {Error} with a `[SPECOPS:FAIL]` message on exhaustion or staleness.
 */
export async function runAutomatic(
  input: PluginInput,
  runner: AgentRunner,
  config: SpecOpsConfig,
  goal: string,
  parentID: string,
  progress: ProgressTracker,
): Promise<string> {
  const seenEscalations = new Set<string>()
  const inspectEscalation = (output: string, current: WorkflowTier): EscalationDecision | undefined => {
    const request = parseEscalationRequest(output)
    if (!request) return undefined
    const decision = adjudicateEscalation(current, request, seenEscalations)
    if (decision.accepted) seenEscalations.add(decision.fingerprint)
    return decision
  }
  const observedRunner: AgentRunner = (agent, prompt, parent) =>
    runner(agent, prompt, parent, progress.reporter, progress.signal)
  const invocation = parseTierInvocation(goal)
  goal = invocation.goal
  await progress.phase(0, "preflight", "Preflight")
  if (config.automation.require_clean_worktree) await assertCleanWorktree(input.directory)
  const baseline = await baseCommit(input.directory)
  await progress.phase(1, "assessment", "Adaptive assessment", ["sdd-assess"])
  const assessmentOutput = await observedRunner(
    "sdd-assess",
    `Assess the minimum safe SpecOps workflow tier for this exact goal. Inspect focused repository evidence and return only the required JSON object.\n\n${untrusted("goal", goal)}`,
    parentID,
  )
  const assessment = parseAssessment(assessmentOutput)
  const selected = selectWorkflowTier(assessment, invocation.requestedTier, config)
  let plan = selected.plan
  progress.setTotal(plan.planning.length + 8)
  const onboardingPath = path.join(input.directory, "openspec", "onboarding.md")
  const hasOnboarding = await readFile(onboardingPath, "utf-8")
    .then(() => true)
    .catch(() => false)
  let onboardingContext = hasOnboarding
    ? await readFile(onboardingPath, "utf-8")
    : "(onboarding memory not yet available)"
  await onboard(input.directory)
  if (config.workflow.onboarding === "always" || !hasOnboarding) {
    await progress.phase(2, "onboard", "Onboarding", ["sdd-onboard"])
    const onboarded = await onboardWithContext(
      input.directory,
      observedRunner,
      goal,
      parentID,
    )
    onboardingContext = onboarded.projectContext
  }
  const change = await uniqueChangeName(input.directory, goal)
  await openSpecOrThrow(input.directory, config, [
    "new",
    "change",
    change,
    "--schema",
    plan.schema,
    "--goal",
    goal,
    "--json",
  ])
  await progress.setChange(change)
  const changeDirectory = path.join(input.directory, "openspec", "changes", change)
  const runState: AdaptiveRunState = {
    version: 2,
    mode: "headless",
    goal,
    base_commit: baseline,
    requested_tier: invocation.requestedTier,
    initial_tier: plan.tier,
    tier: plan.tier,
    schema: plan.schema,
    assessment,
    routing_reasons: selected.reasons,
    tier_history: [],
    escalation_history: [],
    created_at: new Date().toISOString(),
  }
  await writeFile(
    path.join(changeDirectory, "specops-run.json"),
    JSON.stringify(runState, null, 2) + "\n",
    "utf-8",
  )
  await writeArtifact(
    input.directory,
    change,
    "routing.md",
    `# Adaptive Routing\n\n- Selected tier: **${plan.tier}**\n- Schema: \`${plan.schema}\`\n\n${selected.reasons.map((reason) => `- ${reason}`).join("\n")}\n`,
  )

  const generated = new Set<string>()
  let planningIndex = 3
  const completePlanning = async (): Promise<void> => {
    while (true) {
      let escalated = false
      for (const artifact of plan.planning) {
        if (generated.has(artifact)) continue
        const agent = artifact === "init" ? "sdd-init" : `sdd-${artifact === "specs" ? "spec" : artifact}`
        await progress.phase(planningIndex++, artifact, artifact, [agent])
        let output: string
        if (artifact === "init") {
          output = await observedRunner(
            "sdd-init",
            `Prepare a concise safe bootstrap for this ${plan.tier}-tier goal. Return Markdown with scope, assumptions, non-goals, and readiness risks. ${ESCALATION_INSTRUCTIONS}\n\n${untrusted("goal", goal)}\n\n${untrusted("project-onboarding", onboardingContext)}`,
            parentID,
          )
          await writeArtifact(input.directory, change, "init.md", output)
        } else {
          output = await generateArtifact(
            observedRunner,
            input.directory,
            config,
            change,
            artifact,
            agent,
            parentID,
            artifact === "exploration"
              ? `${onboardingContext}\n\n# Selected tier\n\n${plan.tier}`
              : undefined,
          )
        }
        generated.add(artifact)
        const escalation = inspectEscalation(output, plan.tier)
        const target = escalation?.accepted ? escalation.request.target : undefined
        if (target && higherTier(plan.tier, target) !== plan.tier) {
          const result = await escalateVisibleRun(
            input.directory,
            change,
            target,
            `${agent}: ${escalation?.reason} Evidence: ${escalation?.request.evidence.join(", ")}`,
            escalation?.request,
          )
          plan = result.plan
          progress.setTotal(plan.planning.length + 8)
          generated.delete("tasks")
          escalated = true
          break
        }
      }
      if (!escalated) return
    }
  }
  await completePlanning()
  await openSpecOrThrow(input.directory, config, ["validate", change, "--strict", "--json"])
  const applyCurrentPlan = async (): Promise<void> => {
    while (true) {
      await progress.phase(8, "apply", `Apply (${plan.tier})`, ["sdd-apply"])
      const applyGuide = await instructions(input.directory, config, change, "apply")
      const output = await observedRunner(
        "sdd-apply",
        `Implement this approved ${plan.tier}-tier change now. Edit code and tests only within scope, run focused validation, and do not commit or mutate Git history. Make small reversible choices for unspecified low-risk detail. ${ESCALATION_INSTRUCTIONS}\n\n${untrusted("openspec-apply-instructions", applyGuide)}`,
        parentID,
      )
      const escalation = inspectEscalation(output, plan.tier)
      const target = escalation?.accepted ? escalation.request.target : undefined
      if (!target || higherTier(plan.tier, target) === plan.tier) return
      const result = await escalateVisibleRun(
        input.directory,
        change,
        target,
        `sdd-apply: ${escalation?.reason} Evidence: ${escalation?.request.evidence.join(", ")}`,
        escalation?.request,
      )
      plan = result.plan
      progress.setTotal(plan.planning.length + 8)
      generated.delete("tasks")
      await completePlanning()
      await openSpecOrThrow(input.directory, config, ["validate", change, "--strict", "--json"])
    }
  }
  await applyCurrentPlan()

  for (let cycle = 0; cycle <= config.automation.max_fix_cycles; cycle += 1) {
    const footprint = await implementationFootprint(input.directory)
    const footprintTarget = footprintEscalation(plan.tier, footprint, config)
    if (footprintTarget) {
      const result = await escalateVisibleRun(
        input.directory,
        change,
        footprintTarget,
        `Actual implementation footprint is ${footprint.files} files across ${footprint.modules} modules.`,
      )
      plan = result.plan
      progress.setTotal(plan.planning.length + 8)
      generated.delete("tasks")
      await completePlanning()
      await openSpecOrThrow(input.directory, config, ["validate", change, "--strict", "--json"])
      await applyCurrentPlan()
      cycle -= 1
      continue
    }
    await progress.phase(9, "verify", "Verify", ["sdd-verify"], cycle)
    const verification = await generateArtifact(
      observedRunner,
      input.directory,
      config,
      change,
      "verification",
      "sdd-verify",
      parentID,
      `Selected workflow tier: ${plan.tier}. ${ESCALATION_INSTRUCTIONS}`,
    )
    const verificationDecision = inspectEscalation(verification, plan.tier)
    const verificationTarget = verificationDecision?.accepted ? verificationDecision.request.target : undefined
    if (verificationTarget && higherTier(plan.tier, verificationTarget) !== plan.tier) {
      const result = await escalateVisibleRun(
        input.directory,
        change,
        verificationTarget,
        `sdd-verify: ${verificationDecision?.reason} Evidence: ${verificationDecision?.request.evidence.join(", ")}`,
        verificationDecision?.request,
      )
      plan = result.plan
      progress.setTotal(plan.planning.length + 8)
      generated.delete("tasks")
      await completePlanning()
      await openSpecOrThrow(input.directory, config, ["validate", change, "--strict", "--json"])
      await applyCurrentPlan()
      cycle -= 1
      continue
    }
    const diff = await collectDiff(input.directory, config.review.max_diff_bytes)
    const diffHash = sha256(diff)
    await progress.phase(
      10,
      "judgment",
      "Judgment Day",
      plan.judges,
      cycle,
    )
    const judgment = await adaptiveJudgmentWithRunner(observedRunner, plan, diff, goal, parentID)
    const judgmentDecisions = Object.values(judgment.outputs)
      .map((output) => inspectEscalation(output ?? "", plan.tier))
      .filter((decision): decision is EscalationDecision => Boolean(decision?.accepted))
    const judgmentTarget = judgmentDecisions.reduce<WorkflowTier | undefined>(
      (current, decision) => (current ? higherTier(current, decision.request.target) : decision.request.target),
      undefined,
    )
    if (judgmentTarget && higherTier(plan.tier, judgmentTarget) !== plan.tier) {
      const result = await escalateVisibleRun(
        input.directory,
        change,
        judgmentTarget,
        `${judgmentDecisions[0].reason} Evidence: ${judgmentDecisions[0].request.evidence.join(", ")}`,
        judgmentDecisions[0].request,
      )
      plan = result.plan
      progress.setTotal(plan.planning.length + 8)
      generated.delete("tasks")
      await completePlanning()
      await openSpecOrThrow(input.directory, config, ["validate", change, "--strict", "--json"])
      await applyCurrentPlan()
      cycle -= 1
      continue
    }
    await writeArtifact(
      input.directory,
      change,
      "judgment.md",
      `# Judgment Day\n\n- Tier: **${plan.tier}**\n- Diff SHA-256: \`${diffHash}\`\n- Remediation cycle: ${cycle}\n\n${plan.judges
        .map((agent) => `## ${agent}\n\n${judgment.outputs[agent] ?? "Missing output."}`)
        .join("\n\n")}\n\n## Verdict\n\n${judgment.passed ? "[PASS]" : "[FAIL]"}\n`,
    )
    if (!judgment.passed) {
      if (cycle === config.automation.max_fix_cycles) {
        throw new Error(
          `[SPECOPS:FAIL] Judgment Day still fails after ${cycle} remediation cycle(s). Change: ${change}`,
        )
      }
      await progress.phase(9, "judgment-remediation", "Judgment remediation", ["jd-fix-agent"], cycle + 1)
      await observedRunner(
        "jd-fix-agent",
        `MODE: APPLY. Implement only the validated remediation plan, update focused tests, and run relevant checks. Do not commit or edit OpenSpec evidence files.\n\n${untrusted("fix-plan", judgment.fixPlan ?? "")}\n\n${untrusted("current-diff", diff)}`,
        parentID,
      )
      continue
    }

    await progress.phase(
      11,
      "review",
      "Review panel",
      plan.reviewers,
      cycle,
    )
    const panel = await adaptiveReviewWithRunner(observedRunner, plan, diff, parentID)
    const reviewDecisions = Object.values(panel.outputs)
      .map((output) => inspectEscalation(output ?? "", plan.tier))
      .filter((decision): decision is EscalationDecision => Boolean(decision?.accepted))
    const reviewTarget = reviewDecisions.reduce<WorkflowTier | undefined>(
      (current, decision) => (current ? higherTier(current, decision.request.target) : decision.request.target),
      undefined,
    )
    if (reviewTarget && higherTier(plan.tier, reviewTarget) !== plan.tier) {
      const result = await escalateVisibleRun(
        input.directory,
        change,
        reviewTarget,
        `${reviewDecisions[0].reason} Evidence: ${reviewDecisions[0].request.evidence.join(", ")}`,
        reviewDecisions[0].request,
      )
      plan = result.plan
      generated.delete("tasks")
      await completePlanning()
      await openSpecOrThrow(input.directory, config, ["validate", change, "--strict", "--json"])
      await applyCurrentPlan()
      cycle -= 1
      continue
    }
    const panelEvidence = Object.entries(panel.outputs)
      .map(([agent, output]) => `## ${agent}\n\n${output}`)
      .join("\n\n")
    await writeArtifact(
      input.directory,
      change,
      "review-ledger.md",
      `# Review Ledger\n\n- Tier: **${plan.tier}**\n- Diff SHA-256: \`${diffHash}\`\n\n## Synthesized Findings\n\n${panel.ledger}\n\n## Panel Evidence\n\n${panelEvidence}\n`,
    )
    const blocking = hasBlockingFinding(
      panel.ledger,
      config.automation.blocking_severities,
    )
    if (blocking) {
      if (cycle === config.automation.max_fix_cycles) {
        throw new Error(
          `[SPECOPS:FAIL] Blocking review findings remain after ${cycle} remediation cycle(s). Change: ${change}`,
        )
      }
      await progress.phase(9, "review-remediation", "Review remediation", ["jd-fix-agent"], cycle + 1)
      await observedRunner(
        "jd-fix-agent",
        `MODE: APPLY. Repair only defensible BLOCKER/HIGH findings from this refuted ledger. Add or update focused tests and run relevant checks. Do not commit or edit OpenSpec evidence files.\n\n${untrusted("review-ledger", panel.ledger)}\n\n${untrusted("current-diff", diff)}`,
        parentID,
      )
      continue
    }

    await progress.phase(12, "archive", "Evidence and archive", [], cycle)
    const artifactHash = await hashArtifactTree(changeDirectory)
    const finalState = await readAdaptiveRun(changeDirectory)
    const receipt: SpecOpsReceipt = {
      version: 2,
      change,
      goal,
      tier: plan.tier,
      tier_history: finalState.tier_history,
      base_commit: baseline,
      diff_sha256: diffHash,
      artifacts_sha256: artifactHash,
      verified_at: new Date().toISOString(),
      fix_cycles: cycle,
      judgment: {
        required: plan.judges,
        passed: plan.judges,
      },
      review: {
        required: plan.reviewers,
        completed: plan.reviewers,
        refuter_required: plan.refuter,
        blocking_findings: false,
        ledger_sha256: sha256(panel.ledger),
      },
      test_evidence: { source: "openspec-verification", fabricated: false },
    }
    await writeFile(
      path.join(changeDirectory, "specops-receipt.json"),
      JSON.stringify(receipt, null, 2) + "\n",
      "utf-8",
    )

    const fresh = receiptIsFresh(receipt, {
      baseCommit: await baseCommit(input.directory),
      diffHash: sha256(await collectDiff(input.directory, config.review.max_diff_bytes)),
      artifactHash: await hashArtifactTree(changeDirectory),
    })
    if (!fresh) throw new Error("[SPECOPS:FAIL] Evidence became stale before archive")
    await openSpecOrThrow(input.directory, config, ["validate", change, "--strict", "--json"])
    await openSpecOrThrow(input.directory, config, ["archive", change, "--yes"])
    const archiveRoot = path.join(input.directory, "openspec", "changes", "archive")
    const archived = (await readdir(archiveRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(`-${change}`))
      .map((entry) => entry.name)
      .sort()
      .at(-1)
    if (archived) progress.relocate(path.join(archiveRoot, archived))
    await progress.finish("passed")
    return `[SPECOPS:PASS] ${change} completed at ${plan.tier} tier, verified, judged, reviewed, and archived after ${cycle} remediation cycle(s).`
  }
  throw new Error("[SPECOPS:FAIL] Unreachable automation state")
}

/** Re-export the plan type for the orchestrator's tool signatures. */
export type { WorkflowPlan }

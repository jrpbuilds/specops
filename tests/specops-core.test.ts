import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  hashArtifactTree,
  hasBlockingFinding,
  hasStandalonePass,
  mergeConfig,
  receiptIsFresh,
  selectWorkflowTier,
  sha256,
  slugifyGoal,
  type SpecOpsReceipt,
  type TierAssessment,
  validateConfig,
} from "../src/core.js"
import {
  adjudicateEscalation,
  legacyEscalationRequest,
  parseEscalationRequest,
} from "../src/escalation.js"

describe("SpecOps core", () => {
  const assessment = (overrides: Partial<TierAssessment> = {}): TierAssessment => ({
    suggested_tier: "lean",
    change_kind: "bugfix",
    expected_files: 2,
    expected_modules: 1,
    restores_existing_behavior: true,
    changes_requirements: false,
    public_contract: "none",
    security_sensitive: false,
    data_migration: false,
    new_external_dependency: false,
    infrastructure_change: false,
    concurrency_sensitive: false,
    destructive_or_irreversible: false,
    cross_cutting_architecture: false,
    critical_unknowns: false,
    rationale: ["Localized regression."],
    evidence: ["src/example.ts:10"],
    ...overrides,
  })

  it("requires a standalone pass marker", () => {
    expect(hasStandalonePass("[PASS]")).toBe(true)
    expect(hasStandalonePass("Evidence\n[PASS]\n")).toBe(true)
    expect(hasStandalonePass("The code says [PASS] inline.")).toBe(false)
    expect(hasStandalonePass("[PASS] but with a caveat")).toBe(false)
  })

  it("parses and adjudicates evidence-backed escalation requests", () => {
    const output = JSON.stringify({
      escalation: {
        target: "full",
        category: "security",
        confidence: "high",
        summary: "The change crosses the authorization boundary.",
        evidence: ["src/auth/policy.ts", "tests/AuthPolicyTest.ts"],
        boundary_crossed: "security",
        why_current_tier_is_insufficient: "The current tier does not include the security review stages.",
      },
    })
    const request = parseEscalationRequest(output)
    expect(request?.category).toBe("security")
    const decision = adjudicateEscalation("standard", request!)
    expect(decision.accepted).toBe(true)
    expect(decision.fingerprint).toContain("security")
    expect(adjudicateEscalation("standard", request!, new Set([decision.fingerprint])).accepted).toBe(false)
  })

  it("marks legacy markers as compatibility escalations", () => {
    const request = legacyEscalationRequest("standard", "[ESCALATE:STANDARD]")
    expect(request.legacy_marker).toBe(true)
    expect(adjudicateEscalation("lean", request).reason).toContain("Compatibility mode")
  })

  it("recognizes configured blocking severities", () => {
    expect(hasBlockingFinding("[HIGH] unsafe default", ["BLOCKER", "HIGH"])).toBe(true)
    expect(hasBlockingFinding("## BLOCKER\nData loss", ["BLOCKER"])).toBe(true)
    expect(hasBlockingFinding("[MEDIUM] naming", ["BLOCKER", "HIGH"])).toBe(false)
  })

  it("creates safe stable change slugs", () => {
    expect(slugifyGoal(" Add OAuth 2.0 / Login! ")).toBe("add-oauth-2-0-login")
    expect(slugifyGoal("🔥")).toBe("specops-change")
    expect(slugifyGoal("a".repeat(100)).length).toBeLessThanOrEqual(52)
  })

  it("deep-merges project configuration with defaults", () => {
    const config = mergeConfig({ review: { max_diff_bytes: 1234 } })
    expect(config.review.max_diff_bytes).toBe(1234)
    expect(config.review.transient_retries).toBe(1)
    expect(config.automation.max_fix_cycles).toBe(3)
    expect(config.workflow.default_tier).toBe("auto")
  })

  it("selects Lean for a localized restorative bug fix", () => {
    const selected = selectWorkflowTier(assessment(), "auto", mergeConfig({}))
    expect(selected.plan.tier).toBe("lean")
    expect(selected.plan.judges).toEqual(["jd-judge-a"])
    expect(selected.plan.reviewers).toEqual(["review-risk"])
  })

  it("raises requirement changes to Standard and critical risk to Full", () => {
    const standard = selectWorkflowTier(
      assessment({ changes_requirements: true, restores_existing_behavior: false }),
      "auto",
      mergeConfig({}),
    )
    expect(standard.plan.tier).toBe("standard")
    expect(standard.plan.planning).toContain("specs")

    const full = selectWorkflowTier(
      assessment({ security_sensitive: true }),
      "auto",
      mergeConfig({}),
    )
    expect(full.plan.tier).toBe("full")
    expect(full.plan.reviewers).toHaveLength(4)
  })

  it("treats manual and configured tiers as minimums", () => {
    expect(selectWorkflowTier(assessment(), "full", mergeConfig({})).plan.tier).toBe("full")
    expect(
      selectWorkflowTier(
        assessment(),
        "auto",
        mergeConfig({ workflow: { default_tier: "standard" } }),
      ).plan.tier,
    ).toBe("standard")
    expect(
      selectWorkflowTier(assessment({ data_migration: true }), "lean", mergeConfig({})).plan.tier,
    ).toBe("full")
  })

  it("rejects unsafe runtime configuration", () => {
    const config = mergeConfig({ openspec: { schema: "../escape" } })
    expect(() => validateConfig(config)).toThrow("openspec.schema")
    const thresholds = mergeConfig({
      workflow: { lean_max_files: 5, full_min_files: 5 },
    })
    expect(() => validateConfig(thresholds)).toThrow("workflow thresholds")
  })

  it("hashes artifacts deterministically while excluding the receipt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "specops-artifacts-"))
    await mkdir(path.join(root, "specs", "example"), { recursive: true })
    await writeFile(path.join(root, "proposal.md"), "proposal")
    await writeFile(path.join(root, "specs", "example", "spec.md"), "spec")
    const before = await hashArtifactTree(root)
    await writeFile(path.join(root, "specops-receipt.json"), '{"changes":"often"}')
    await writeFile(path.join(root, "specops-progress.json"), '{"elapsed_ms":1000}')
    await writeFile(path.join(root, "specops-run.json"), '{"base_commit":"abc"}')
    expect(await hashArtifactTree(root)).toBe(before)
    await writeFile(path.join(root, "proposal.md"), "changed")
    expect(await hashArtifactTree(root)).not.toBe(before)
  })

  it("detects stale evidence", () => {
    const receipt = {
      base_commit: "a",
      diff_sha256: "b",
      artifacts_sha256: "c",
    } as SpecOpsReceipt
    expect(
      receiptIsFresh(receipt, { baseCommit: "a", diffHash: "b", artifactHash: "c" }),
    ).toBe(true)
    expect(
      receiptIsFresh(receipt, { baseCommit: "a", diffHash: sha256("new"), artifactHash: "c" }),
    ).toBe(false)
  })
})

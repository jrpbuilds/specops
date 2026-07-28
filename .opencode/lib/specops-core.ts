import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

export type SpecOpsConfig = {
  openspec: { command: string[] | null; schema: string }
  workflow: {
    default_tier: "auto" | WorkflowTier
    onboarding: "if-missing" | "always"
    lean_max_files: number
    lean_max_modules: number
    full_min_files: number
    full_min_modules: number
  }
  automation: {
    max_fix_cycles: number
    require_clean_worktree: boolean
    blocking_severities: Array<"BLOCKER" | "HIGH" | "MEDIUM" | "LOW">
  }
  review: {
    max_diff_bytes: number
    transient_retries: number
    agent_timeout_seconds: number
  }
  integrations: { mcp: "inherit" | "disabled" }
}

export const DEFAULT_CONFIG: SpecOpsConfig = {
  openspec: { command: null, schema: "specops" },
  workflow: {
    default_tier: "auto",
    onboarding: "if-missing",
    lean_max_files: 2,
    lean_max_modules: 1,
    full_min_files: 9,
    full_min_modules: 4,
  },
  automation: {
    max_fix_cycles: 3,
    require_clean_worktree: true,
    blocking_severities: ["BLOCKER", "HIGH"],
  },
  review: {
    max_diff_bytes: 200_000,
    transient_retries: 1,
    agent_timeout_seconds: 300,
  },
  integrations: { mcp: "inherit" },
}

export function mergeConfig(value: unknown): SpecOpsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return structuredClone(DEFAULT_CONFIG)
  const source = value as Partial<SpecOpsConfig>
  return {
    openspec: { ...DEFAULT_CONFIG.openspec, ...source.openspec },
    workflow: { ...DEFAULT_CONFIG.workflow, ...source.workflow },
    automation: { ...DEFAULT_CONFIG.automation, ...source.automation },
    review: { ...DEFAULT_CONFIG.review, ...source.review },
    integrations: { ...DEFAULT_CONFIG.integrations, ...source.integrations },
  }
}

export function validateConfig(config: SpecOpsConfig): SpecOpsConfig {
  const fail = (field: string): never => {
    throw new Error(`invalid SpecOps configuration field: ${field}`)
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.openspec.schema)) fail("openspec.schema")
  if (
    config.openspec.command !== null &&
    (!Array.isArray(config.openspec.command) ||
      config.openspec.command.length === 0 ||
      config.openspec.command.some((value) => typeof value !== "string" || !value))
  ) {
    fail("openspec.command")
  }
  if (!["auto", "lean", "standard", "full"].includes(config.workflow.default_tier)) {
    fail("workflow.default_tier")
  }
  if (!["if-missing", "always"].includes(config.workflow.onboarding)) {
    fail("workflow.onboarding")
  }
  for (const field of [
    "lean_max_files",
    "lean_max_modules",
    "full_min_files",
    "full_min_modules",
  ] as const) {
    if (!Number.isInteger(config.workflow[field]) || config.workflow[field] < 1) {
      fail(`workflow.${field}`)
    }
  }
  if (
    config.workflow.full_min_files <= config.workflow.lean_max_files ||
    config.workflow.full_min_modules <= config.workflow.lean_max_modules
  ) {
    fail("workflow thresholds")
  }
  if (
    !Number.isInteger(config.automation.max_fix_cycles) ||
    config.automation.max_fix_cycles < 0 ||
    config.automation.max_fix_cycles > 10
  ) {
    fail("automation.max_fix_cycles")
  }
  if (typeof config.automation.require_clean_worktree !== "boolean") {
    fail("automation.require_clean_worktree")
  }
  const severity = new Set(["BLOCKER", "HIGH", "MEDIUM", "LOW"])
  if (
    !Array.isArray(config.automation.blocking_severities) ||
    config.automation.blocking_severities.some((value) => !severity.has(value))
  ) {
    fail("automation.blocking_severities")
  }
  if (!Number.isInteger(config.review.max_diff_bytes) || config.review.max_diff_bytes < 1000) {
    fail("review.max_diff_bytes")
  }
  if (
    !Number.isInteger(config.review.transient_retries) ||
    config.review.transient_retries < 0 ||
    config.review.transient_retries > 5
  ) {
    fail("review.transient_retries")
  }
  if (
    !Number.isInteger(config.review.agent_timeout_seconds) ||
    config.review.agent_timeout_seconds < 30
  ) {
    fail("review.agent_timeout_seconds")
  }
  if (!["inherit", "disabled"].includes(config.integrations.mcp)) fail("integrations.mcp")
  return config
}

export function hasStandalonePass(output: string): boolean {
  return /(?:^|\r?\n)\s*\[PASS]\s*(?:\r?\n|$)/i.test(output)
}

export function hasBlockingFinding(output: string, severities: string[]): boolean {
  return severities.some((severity) => {
    const escaped = severity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`(?:\\[${escaped}\\]|^#{1,6}\\s+${escaped}\\b|^${escaped}\\s*:)`, "im").test(output)
  })
}

export function slugifyGoal(goal: string): string {
  const slug = goal
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 52)
    .replace(/-+$/g, "")
  return slug || "specops-change"
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}

export type WorkflowTier = "lean" | "standard" | "full"

export type TierAssessment = {
  suggested_tier: WorkflowTier
  change_kind:
    | "documentation"
    | "configuration"
    | "test"
    | "bugfix"
    | "refactor"
    | "feature"
    | "migration"
    | "infrastructure"
  expected_files: number
  expected_modules: number
  restores_existing_behavior: boolean
  changes_requirements: boolean
  public_contract: "none" | "compatible" | "breaking"
  security_sensitive: boolean
  data_migration: boolean
  new_external_dependency: boolean
  infrastructure_change: boolean
  concurrency_sensitive: boolean
  destructive_or_irreversible: boolean
  cross_cutting_architecture: boolean
  critical_unknowns: boolean
  rationale: string[]
  evidence: string[]
}

export type WorkflowPlan = {
  tier: WorkflowTier
  schema: "specops-lean" | "specops-standard" | "specops"
  planning: Array<"init" | "exploration" | "proposal" | "specs" | "design" | "tasks">
  judges: Array<"jd-judge-a" | "jd-judge-b">
  reviewers: Array<
    "review-risk" | "review-readability" | "review-reliability" | "review-resilience"
  >
  refuter: boolean
}

const TIER_ORDER: Record<WorkflowTier, number> = { lean: 0, standard: 1, full: 2 }

export const WORKFLOW_PLANS: Record<WorkflowTier, WorkflowPlan> = {
  lean: {
    tier: "lean",
    schema: "specops-lean",
    planning: ["exploration"],
    judges: ["jd-judge-a"],
    reviewers: ["review-risk"],
    refuter: false,
  },
  standard: {
    tier: "standard",
    schema: "specops-standard",
    planning: ["exploration", "proposal", "specs", "tasks"],
    judges: ["jd-judge-a", "jd-judge-b"],
    reviewers: ["review-risk", "review-reliability"],
    refuter: true,
  },
  full: {
    tier: "full",
    schema: "specops",
    planning: ["init", "exploration", "proposal", "specs", "design", "tasks"],
    judges: ["jd-judge-a", "jd-judge-b"],
    reviewers: [
      "review-risk",
      "review-readability",
      "review-reliability",
      "review-resilience",
    ],
    refuter: true,
  },
}

export function higherTier(left: WorkflowTier, right: WorkflowTier): WorkflowTier {
  return TIER_ORDER[left] >= TIER_ORDER[right] ? left : right
}

export function selectWorkflowTier(
  assessment: TierAssessment,
  requested: "auto" | WorkflowTier,
  config: SpecOpsConfig,
): { plan: WorkflowPlan; floor: WorkflowTier; reasons: string[] } {
  const reasons = [...assessment.rationale]
  let floor: WorkflowTier = "lean"
  // These signals establish the non-negotiable safety floor. The assessor may
  // still conservatively request a higher tier, but it cannot lower this floor.
  const fullRisk =
    assessment.security_sensitive ||
    assessment.data_migration ||
    assessment.new_external_dependency ||
    assessment.infrastructure_change ||
    assessment.concurrency_sensitive ||
    assessment.destructive_or_irreversible ||
    assessment.cross_cutting_architecture ||
    assessment.critical_unknowns ||
    assessment.public_contract === "breaking" ||
    assessment.change_kind === "migration" ||
    assessment.change_kind === "infrastructure" ||
    assessment.expected_files >= config.workflow.full_min_files ||
    assessment.expected_modules >= config.workflow.full_min_modules
  if (fullRisk) {
    floor = "full"
    reasons.push("A Full-tier safety or scope floor was triggered.")
  } else {
    const leanEligible =
      assessment.expected_files <= config.workflow.lean_max_files &&
      assessment.expected_modules <= config.workflow.lean_max_modules &&
      assessment.public_contract === "none" &&
      !assessment.changes_requirements &&
      !["feature", "refactor"].includes(assessment.change_kind) &&
      (["documentation", "configuration", "test"].includes(assessment.change_kind) ||
        (assessment.change_kind === "bugfix" && assessment.restores_existing_behavior))
    if (!leanEligible) {
      floor = "standard"
      reasons.push("The change exceeds the Lean scope or changes intended behavior.")
    }
  }
  const configured = config.workflow.default_tier === "auto" ? "lean" : config.workflow.default_tier
  const explicit = requested === "auto" ? "lean" : requested
  const tier = higherTier(higherTier(higherTier(floor, assessment.suggested_tier), configured), explicit)
  if (tier !== floor) reasons.push(`The requested, configured, or assessed minimum raised the tier to ${tier}.`)
  return { plan: WORKFLOW_PLANS[tier], floor, reasons: [...new Set(reasons)] }
}

async function filesBelow(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative)
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const result: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.posix.join(relative.split(path.sep).join(path.posix.sep), entry.name)
    if (entry.isDirectory()) result.push(...(await filesBelow(root, child)))
    else if (entry.isFile()) result.push(child)
  }
  return result
}

export async function hashArtifactTree(changeDirectory: string): Promise<string> {
  const files = (await filesBelow(changeDirectory)).filter(
    (file) =>
      !["specops-receipt.json", "specops-progress.json", "specops-run.json"].includes(file),
  )
  const hash = createHash("sha256")
  for (const relative of files) {
    const absolute = path.join(changeDirectory, relative)
    const info = await stat(absolute)
    hash.update(relative)
    hash.update("\0")
    hash.update(String(info.size))
    hash.update("\0")
    hash.update(await readFile(absolute))
    hash.update("\0")
  }
  return hash.digest("hex")
}

export type SpecOpsReceiptV1 = {
  version: 1
  change: string
  goal: string
  base_commit: string
  diff_sha256: string
  artifacts_sha256: string
  verified_at: string
  fix_cycles: number
  judgment: {
    judge_a_passed: boolean
    judge_b_passed: boolean
  }
  review: {
    blocking_findings: boolean
    ledger_sha256: string
  }
  test_evidence: {
    source: "openspec-verification"
    fabricated: false
  }
}

export type SpecOpsReceiptV2 = {
  version: 2
  change: string
  goal: string
  tier: WorkflowTier
  tier_history: Array<{
    from: WorkflowTier
    to: WorkflowTier
    reason: string
    at: string
  }>
  base_commit: string
  diff_sha256: string
  artifacts_sha256: string
  verified_at: string
  fix_cycles: number
  judgment: {
    required: Array<"jd-judge-a" | "jd-judge-b">
    passed: Array<"jd-judge-a" | "jd-judge-b">
  }
  review: {
    required: WorkflowPlan["reviewers"]
    completed: WorkflowPlan["reviewers"]
    refuter_required: boolean
    blocking_findings: boolean
    ledger_sha256: string
  }
  test_evidence: {
    source: "openspec-verification"
    fabricated: false
  }
}

export type SpecOpsReceipt = SpecOpsReceiptV1 | SpecOpsReceiptV2

export function receiptIsFresh(
  receipt: SpecOpsReceipt,
  snapshot: { baseCommit: string; diffHash: string; artifactHash: string },
): boolean {
  return (
    receipt.base_commit === snapshot.baseCommit &&
    receipt.diff_sha256 === snapshot.diffHash &&
    receipt.artifacts_sha256 === snapshot.artifactHash
  )
}

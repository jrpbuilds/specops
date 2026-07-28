/**
 * Parsing and prompt-injection defense helpers.
 *
 * These functions normalize agent output (JSON extraction, fence stripping,
 * verdict markers) and wrap untrusted content so model prose cannot inject
 * instructions into other agents' prompts.
 */

import type { TierAssessment, WorkflowTier } from "./core.js"

/**
 * Wrap a value in an untrusted-content tag so downstream agents treat it as
 * data, not instructions. Used for diffs, task descriptions, and other agent
 * outputs that are forwarded into the next worker's prompt.
 *
 * @param label - Semantic label for the content (e.g. `"diff"`).
 * @param value - The raw content to wrap.
 */
export function untrusted(label: string, value: string): string {
  return `<untrusted-${label}>\n${value}\n</untrusted-${label}>`
}

/**
 * Strip a surrounding Markdown code fence (``` or ```json) from agent output.
 * Returns the trimmed inner content with a trailing newline.
 *
 * @param output - Raw agent response that may be fenced.
 */
export function stripFence(output: string): string {
  const trimmed = output.trim()
  const match = trimmed.match(/^```(?:markdown|md|json)?\s*\n([\s\S]*?)\n```\s*$/i)
  return (match?.[1] ?? trimmed).trim() + "\n"
}

/**
 * Extract a JSON object from agent output. Tries direct parse first, then
 * falls back to the outermost `{...}` slice if the model wrapped the JSON
 * in prose.
 *
 * @param output - Raw agent response expected to contain JSON.
 * @returns The parsed JSON value.
 * @throws {Error} when no JSON object can be extracted.
 */
export function extractJson(output: string): unknown {
  const stripped = stripFence(output).trim()
  try {
    return JSON.parse(stripped)
  } catch {
    const first = stripped.indexOf("{")
    const last = stripped.lastIndexOf("}")
    if (first >= 0 && last > first) return JSON.parse(stripped.slice(first, last + 1))
    throw new Error("Agent did not return the required JSON object")
  }
}

/**
 * Parse and validate the `sdd-assess` worker's output into a {@link TierAssessment}.
 *
 * Accepts both the strict contract (all fields present) and a compact legacy
 * format (tier/scope/rationale) emitted by some smaller routing models. The
 * compact form is conservatively normalized so model formatting cannot bypass
 * the deterministic tier floors in `selectWorkflowTier`.
 *
 * @param output - Raw `sdd-assess` response text.
 * @returns The validated assessment.
 * @throws {Error} when the output is not a valid object or violates field bounds.
 */
export function parseAssessment(output: string): TierAssessment {
  const value = extractJson(output)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sdd-assess returned a non-object assessment")
  }
  const source = value as Record<string, unknown>
  // Some smaller routing models return the earlier compact contract despite the
  // strict prompt. Normalize it conservatively so model formatting cannot bypass
  // deterministic tier floors.
  if (!("suggested_tier" in source) && "tier" in source) {
    const scope =
      source.scope && typeof source.scope === "object" && !Array.isArray(source.scope)
        ? (source.scope as Record<string, unknown>)
        : {}
    const files = Array.isArray(scope.files)
      ? scope.files.filter((item): item is string => typeof item === "string" && Boolean(item))
      : []
    const text = JSON.stringify({
      goal: source.goal,
      rationale: source.rationale,
      risks: source.risks,
      dependencies: source.dependencies,
    }).toLowerCase()
    const allDocumentation =
      files.length > 0 &&
      files.every((file) =>
        /(?:^|\/)(?:readme|changelog|license)(?:\.[^/]*)?$|\.md$|^docs\//i.test(file),
      )
    const allTests =
      files.length > 0 && files.every((file) => /(?:^|\/)(?:test|tests|spec|specs)(?:\/|\.|$)/i.test(file))
    const allConfiguration =
      files.length > 0 &&
      files.every((file) => /\.(?:json|ya?ml|toml|ini|conf)$/i.test(file))
    const signalText = allDocumentation ? "" : text
    const kind: TierAssessment["change_kind"] = allDocumentation
      ? "documentation"
      : allTests
        ? "test"
        : allConfiguration
          ? "configuration"
          : /\b(?:bug|fix|regression|restore)\b/.test(signalText)
            ? "bugfix"
            : /\b(?:migrat|schema change|data model)\b/.test(signalText)
              ? "migration"
              : /\b(?:infrastructure|deploy|terraform|kubernetes|docker|ci\/cd)\b/.test(signalText)
                ? "infrastructure"
                : "feature"
    const dependencies = Array.isArray(source.dependencies)
      ? source.dependencies.filter((item) => typeof item === "string" && Boolean(item))
      : []
    const tier = ["lean", "standard", "full"].includes(String(source.tier))
      ? (String(source.tier) as WorkflowTier)
      : "full"
    const publicContract: TierAssessment["public_contract"] =
      /\b(?:breaking|remove public|public api break)\b/.test(signalText)
        ? "breaking"
        : /\b(?:public api|public contract|cli interface)\b/.test(signalText)
          ? "compatible"
          : "none"
    const criticalUnknowns = files.length === 0
    const rationale =
      typeof source.rationale === "string" && source.rationale.trim()
        ? [source.rationale.trim()]
        : ["Compact assessment omitted a rationale; conservatively normalized."]
    const risks = Array.isArray(source.risks)
      ? source.risks.filter((item): item is string => typeof item === "string" && Boolean(item))
      : []
    return {
      suggested_tier: criticalUnknowns ? "full" : tier,
      change_kind: kind,
      expected_files: Math.max(1, files.length),
      expected_modules: Math.max(
        1,
        new Set(files.map((file) => (file.includes("/") ? file.split("/")[0] : "(root)"))).size,
      ),
      restores_existing_behavior:
        kind === "bugfix" && /\b(?:bug|fix|regression|restore)\b/.test(signalText),
      changes_requirements: !allDocumentation && !allTests && kind !== "configuration",
      public_contract: publicContract,
      security_sensitive: /\b(?:security|auth|permission|secret|credential|crypto|privacy)\b/.test(signalText),
      data_migration: kind === "migration",
      new_external_dependency:
        !allDocumentation &&
        (dependencies.length > 0 || /\b(?:new dependency|install package|add package)\b/.test(signalText)),
      infrastructure_change: kind === "infrastructure",
      concurrency_sensitive: /\b(?:concurren|race condition|deadlock|parallel|distributed)\b/.test(signalText),
      destructive_or_irreversible: /\b(?:destructive|irreversible|delete data|drop table)\b/.test(signalText),
      cross_cutting_architecture: /\b(?:cross-cutting|architecture|multiple services|system-wide)\b/.test(signalText),
      critical_unknowns: criticalUnknowns,
      rationale: [
        ...rationale,
        "Normalized from the compact assessor format; deterministic safety floors still apply.",
      ],
      evidence: files.length ? files : risks.length ? risks : ["No concrete paths supplied."],
    }
  }
  const tier = new Set(["lean", "standard", "full"])
  const kinds = new Set([
    "documentation",
    "configuration",
    "test",
    "bugfix",
    "refactor",
    "feature",
    "migration",
    "infrastructure",
  ])
  const contracts = new Set(["none", "compatible", "breaking"])
  const booleans = [
    "restores_existing_behavior",
    "changes_requirements",
    "security_sensitive",
    "data_migration",
    "new_external_dependency",
    "infrastructure_change",
    "concurrency_sensitive",
    "destructive_or_irreversible",
    "cross_cutting_architecture",
    "critical_unknowns",
  ] as const
  if (!tier.has(String(source.suggested_tier))) throw new Error("Invalid suggested_tier")
  if (!kinds.has(String(source.change_kind))) throw new Error("Invalid change_kind")
  if (!contracts.has(String(source.public_contract))) throw new Error("Invalid public_contract")
  for (const field of ["expected_files", "expected_modules"] as const) {
    if (!Number.isInteger(source[field]) || Number(source[field]) < 1) {
      throw new Error(`Invalid ${field}`)
    }
  }
  for (const field of booleans) {
    if (typeof source[field] !== "boolean") throw new Error(`Invalid ${field}`)
  }
  for (const field of ["rationale", "evidence"] as const) {
    if (
      !Array.isArray(source[field]) ||
      source[field].length === 0 ||
      source[field].some((item) => typeof item !== "string" || !item.trim())
    ) {
      throw new Error(`Invalid ${field}`)
    }
  }
  return source as TierAssessment
}

/**
 * Parse a `--tier=lean|standard|full` prefix from an invocation, returning
 * the stripped goal and the requested minimum tier.
 *
 * @param input - The raw user invocation (e.g. `"--tier=full migrate the queue"`).
 * @returns The goal text and the requested tier (`"auto"` when no flag is present).
 * @throws {Error} when the flag syntax is invalid or the goal is empty.
 */
export function parseTierInvocation(input: string): {
  goal: string
  requestedTier: "auto" | WorkflowTier
} {
  const trimmed = input.trim()
  const match = trimmed.match(/^--tier=(lean|standard|full)(?:\s+|$)([\s\S]*)$/i)
  if (match) {
    const goal = match[2].trim()
    if (!goal) throw new Error("A goal is required after --tier")
    return { goal, requestedTier: match[1].toLowerCase() as WorkflowTier }
  }
  if (/^--tier(?:=|\s|$)/i.test(trimmed)) {
    throw new Error("Tier syntax is --tier=lean, --tier=standard, or --tier=full")
  }
  if (!trimmed) throw new Error("A non-empty goal is required")
  return { goal: trimmed, requestedTier: "auto" }
}

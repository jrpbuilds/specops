import type { WorkflowTier } from "./core.js"

export type EscalationCategory =
  | "scope_overflow"
  | "public_contract"
  | "security"
  | "migration"
  | "concurrency"
  | "requirements_changed"
  | "blocked"
  | "unknown"

export type EscalationRequest = {
  target: "standard" | "full"
  category: EscalationCategory
  confidence: "low" | "medium" | "high"
  summary: string
  evidence: string[]
  boundary_crossed: string
  why_current_tier_is_insufficient: string
  legacy_marker?: boolean
}

export type EscalationDecision = {
  accepted: boolean
  request: EscalationRequest
  fingerprint: string
  reason: string
}

const CATEGORIES = new Set<EscalationCategory>([
  "scope_overflow",
  "public_contract",
  "security",
  "migration",
  "concurrency",
  "requirements_changed",
  "blocked",
  "unknown",
])

const TARGETS = new Set(["standard", "full"])

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : []
}

/** Extract the structured escalation object from a worker response. */
export function parseEscalationRequest(output: string): EscalationRequest | undefined {
  const first = output.indexOf("{")
  const last = output.lastIndexOf("}")
  if (first < 0 || last <= first) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(output.slice(first, last + 1))
  } catch {
    return undefined
  }
  const source = asObject(asObject(parsed)?.escalation)
  if (!source) return undefined
  const target = source.target
  const category = source.category
  const confidence = source.confidence
  if (
    typeof target !== "string" || !TARGETS.has(target) ||
    typeof category !== "string" || !CATEGORIES.has(category as EscalationCategory) ||
    !["low", "medium", "high"].includes(String(confidence))
  ) return undefined
  const summary = typeof source.summary === "string" ? source.summary.trim() : ""
  const boundary = typeof source.boundary_crossed === "string" ? source.boundary_crossed.trim() : ""
  const why = typeof source.why_current_tier_is_insufficient === "string"
    ? source.why_current_tier_is_insufficient.trim()
    : ""
  const evidence = strings(source.evidence)
  if (!summary || !boundary || !why || evidence.length === 0) return undefined
  return {
    target: target as "standard" | "full",
    category: category as EscalationCategory,
    confidence: confidence as "low" | "medium" | "high",
    summary,
    evidence,
    boundary_crossed: boundary,
    why_current_tier_is_insufficient: why,
  }
}

/** Validate and adjudicate a request against the current workflow tier. */
export function adjudicateEscalation(
  current: WorkflowTier,
  request: EscalationRequest,
  seenFingerprints: Set<string> = new Set(),
): EscalationDecision {
  const fingerprint = [request.category, request.target, request.boundary_crossed, ...request.evidence]
    .map((item) => item.trim().toLowerCase())
    .join("|")
  if (current === "full") {
    return { accepted: false, request, fingerprint, reason: "The workflow is already at Full tier." }
  }
  if (current === "standard" && request.target !== "full") {
    return { accepted: false, request, fingerprint, reason: "The requested target is not higher than the current tier." }
  }
  if (seenFingerprints.has(fingerprint)) {
    return { accepted: false, request, fingerprint, reason: "This escalation evidence was already considered." }
  }
  return {
    accepted: true,
    request,
    fingerprint,
    reason: request.legacy_marker ? `${request.summary} Compatibility mode; structured evidence is preferred.` : request.summary,
  }
}

/** Convert a legacy marker into an explicitly low-confidence compatibility request. */
export function legacyEscalationRequest(target: "standard" | "full", output: string): EscalationRequest {
  return {
    target,
    category: "unknown",
    confidence: "low",
    summary: `Legacy escalation marker requested ${target} tier.`,
    evidence: [output.trim().slice(-500) || "Legacy marker"],
    boundary_crossed: "unspecified",
    why_current_tier_is_insufficient: "No structured explanation was supplied.",
    legacy_marker: true,
  }
}

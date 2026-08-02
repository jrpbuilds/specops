import type { WorkflowAction } from "./actions.js"

type JsonObject = Record<string, unknown>

/**
 * Format accepted structured worker output for the human-facing checkpoint
 * preview without changing the wire-format output used for validation.
 *
 * Planning and Lean assurance workers return JSON envelopes so the controller
 * can validate and persist their members. The checkpoint preview is a separate
 * presentation surface and should read like the Markdown artifacts instead of
 * exposing those transport details.
 *
 * @param action - The completed workflow action.
 * @param output - Marker-stripped accepted worker output.
 * @returns Presentation-ready Markdown, or the original output for actions
 *   whose response is already Markdown.
 */
export function formatCheckpointPreview(action: WorkflowAction, output: string): string {
    if (
        action.capability === "planning" &&
        (action.mode === "requirements-bundle" || action.mode === "standard-bundle")
    ) {
        return formatPlanningBundle(output)
    }
    if (action.capability === "verification" && action.mode === "lean-assurance-bundle") {
        return formatLeanAssuranceBundle(output)
    }
    return output
}

/** Format a validated planning bundle as a readable Markdown document. */
function formatPlanningBundle(output: string): string {
    const bundle = parseObject(output)
    if (!bundle || typeof bundle.proposal !== "string" || !isObject(bundle.specs)) {
        return output
    }

    const sections = [
        "# Planning Bundle",
        "",
        "## Proposal",
        "",
        withoutHeading(bundle.proposal, "# Proposal"),
        "",
        "## Specifications",
        "",
    ]
    for (const [name, content] of Object.entries(bundle.specs)) {
        if (typeof content !== "string") return output
        sections.push(`### ${name}`, "", content.trim(), "")
    }
    if (typeof bundle.tasks === "string") {
        sections.push("## Tasks", "", withoutHeading(bundle.tasks, "# Tasks"), "")
    }
    return sections.join("\n").trim() + "\n"
}

/** Format a validated Lean assurance envelope as readable Markdown. */
function formatLeanAssuranceBundle(output: string): string {
    const bundle = parseObject(output)
    if (
        !bundle ||
        typeof bundle.verification !== "string" ||
        !isObject(bundle.correctnessJudgment) ||
        !isObject(bundle.reviewLedger)
    ) {
        return output
    }

    const judgment = bundle.correctnessJudgment
    const ledger = bundle.reviewLedger
    if (
        typeof judgment.verdict !== "string" ||
        typeof judgment.summary !== "string" ||
        !Array.isArray(judgment.findings) ||
        !Array.isArray(ledger.findings)
    ) {
        return output
    }

    return (
        [
            "# Verification",
            "",
            bundle.verification.trim(),
            "",
            "## Correctness Judgment",
            "",
            `**Verdict:** ${judgment.verdict}`,
            "",
            judgment.summary.trim(),
            "",
            ...formatFindings("Correctness Findings", judgment.findings),
            "",
            "## Review Ledger",
            "",
            ...formatFindings("Review Findings", ledger.findings),
        ]
            .join("\n")
            .trim() + "\n"
    )
}

/** Render finding arrays without exposing their JSON transport shape. */
function formatFindings(title: string, findings: unknown[]): string[] {
    if (findings.length === 0) return [`### ${title}`, "", "No findings.", ""]
    const lines = [`### ${title}`, ""]
    for (const [index, finding] of findings.entries()) {
        if (!isObject(finding)) {
            lines.push(`- Finding ${index + 1}: ${String(finding)}`, "")
            continue
        }
        const severity = typeof finding.severity === "string" ? finding.severity : "Finding"
        const mode = typeof finding.mode === "string" ? ` (${finding.mode})` : ""
        const summary =
            typeof finding.summary === "string" ? finding.summary : "No summary provided."
        lines.push(`#### ${severity}${mode}`, "", summary.trim(), "")
        if (Array.isArray(finding.acceptanceCriteria) && finding.acceptanceCriteria.length > 0) {
            lines.push("**Acceptance criteria**", "")
            for (const criterion of finding.acceptanceCriteria) {
                lines.push(`- ${String(criterion)}`)
            }
            lines.push("")
        }
        if (Array.isArray(finding.evidence) && finding.evidence.length > 0) {
            lines.push("**Evidence**", "", ...formatEvidence(finding.evidence), "")
        }
    }
    return lines
}

/** Render typed evidence references as short human-readable descriptions. */
function formatEvidence(evidence: unknown[]): string[] {
    return evidence.map(item => {
        if (!isObject(item)) return `- ${String(item)}`
        const kind = typeof item.kind === "string" ? item.kind : "evidence"
        if (typeof item.path === "string") {
            const symbol = typeof item.symbol === "string" ? ` (${item.symbol})` : ""
            const surface = typeof item.surface === "string" ? ` [${item.surface}]` : ""
            return `- ${kind}: ${item.path}${symbol}${surface}`
        }
        if (typeof item.commandId === "string") {
            const exitCode = typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : ""
            const test = typeof item.test === "string" ? `: ${item.test}` : ""
            return `- ${kind}: ${item.commandId}${test}${exitCode}`
        }
        if (typeof item.package === "string") {
            const change = typeof item.change === "string" ? ` (${item.change})` : ""
            return `- ${kind}: ${item.package}${change}`
        }
        if (typeof item.question === "string") return `- ${kind}: ${item.question}`
        return `- ${kind}`
    })
}

/** Parse only object-shaped JSON; malformed previews remain safely unchanged. */
function parseObject(output: string): JsonObject | undefined {
    try {
        const value: unknown = JSON.parse(output.trim().replace(/^```json\s*|```$/g, ""))
        return isObject(value) ? value : undefined
    } catch {
        return undefined
    }
}

/** Return whether a value is a plain JSON object. */
function isObject(value: unknown): value is JsonObject {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Remove a known artifact title before nesting its Markdown in the preview. */
function withoutHeading(markdown: string, heading: string): string {
    const trimmed = markdown.trim()
    return trimmed.startsWith(`${heading}\n`) ? trimmed.slice(heading.length).trim() : trimmed
}

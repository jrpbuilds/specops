import { describe, expect, it } from "vitest"
import { AGENT_IDS } from "../src/capabilities/ids.js"
import type { WorkflowAction } from "../src/workflow/actions.js"
import { formatCheckpointPreview } from "../src/workflow/previews.js"

describe("checkpoint previews", () => {
    it("formats planning bundles as readable Markdown", () => {
        const preview = formatCheckpointPreview(
            workflowAction("planning", "standard-bundle"),
            JSON.stringify({
                proposal: "# Proposal\n\nUpdate the shared legal page styles.",
                specs: {
                    legal: "## Purpose\n\nKeep legal pages visually consistent.\n\n## ADDED Requirements\n\n### Requirement: Shared styling\n\n#### Scenario: Render\n- **WHEN** the page loads\n- **THEN** the shared style is applied.",
                },
                tasks: "# Tasks\n\n- Update the shared legal page component.",
            }),
        )

        expect(preview).toContain("# Planning Bundle")
        expect(preview).toContain("## Proposal")
        expect(preview).toContain("## Specifications")
        expect(preview).toContain("### legal")
        expect(preview).toContain("## Tasks")
        expect(preview).not.toContain('"proposal"')
        expect(preview).not.toContain("\\n")
    })

    it("formats Lean assurance bundles without exposing the JSON envelope", () => {
        const preview = formatCheckpointPreview(
            workflowAction("verification", "lean-assurance-bundle"),
            JSON.stringify({
                verification: "# Verification\n\nThe implementation passes lint.",
                correctnessJudgment: {
                    verdict: "PASS",
                    summary: "No correctness issues found.",
                    findings: [
                        {
                            severity: "LOW",
                            mode: "review-finding",
                            summary: "The naming could be clearer.",
                            evidence: [{ kind: "repository-path", path: "src/example.ts" }],
                            acceptanceCriteria: ["The name communicates its purpose."],
                        },
                    ],
                },
                reviewLedger: { findings: [] },
            }),
        )

        expect(preview).toContain("# Verification")
        expect(preview).toContain("## Correctness Judgment")
        expect(preview).toContain("**Verdict:** PASS")
        expect(preview).toContain("## Review Ledger")
        expect(preview).toContain("**Evidence**")
        expect(preview).toContain("repository-path: src/example.ts")
        expect(preview).toContain("The name communicates its purpose.")
        expect(preview).not.toContain('"correctnessJudgment"')
    })

    it("leaves existing Markdown and malformed structured output unchanged", () => {
        const markdown = "# Tasks\n\n- Keep the existing output."
        expect(formatCheckpointPreview(workflowAction("planning", "lean-plan"), markdown)).toBe(
            markdown,
        )
        expect(
            formatCheckpointPreview(workflowAction("planning", "standard-bundle"), "not JSON"),
        ).toBe("not JSON")
    })
})

function workflowAction(capability: "planning" | "verification", mode: string): WorkflowAction {
    return {
        id: "preview",
        capability,
        agent: capability === "planning" ? AGENT_IDS.core.planner : AGENT_IDS.core.verifier,
        purpose: "workflow",
        independent: false,
        mode,
        prompt: "",
    }
}

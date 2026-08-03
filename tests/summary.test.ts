import { describe, expect, it } from "vitest"
import { summarize } from "../src/summary.js"
import type { RunState } from "../src/types.js"

function state(overrides: Partial<RunState> = {}): RunState {
    const base: RunState = {
        version: 7,
        revision: 0,
        mode: "interactive",
        goal: "test",
        baseline: "abc",
        requestedTier: "auto",
        scopeTier: "lean",
        assessment: {} as RunState["assessment"],
        requirements: {
            scopeTier: "lean",
            policyHash: "hash",
            requiredCapabilities: [],
            requiredReviewFacets: [],
            requiredArtifacts: [],
            requiredValidations: [],
            judgePolicy: { required: [] },
            refuterPolicy: { mode: "conditional", triggers: [] },
            budgets: {
                maxScopeEscalations: 1,
                maxSpecialistDispatches: 1,
                maxRepairCycles: 1,
                maxRepeatedFailureFingerprints: 1,
            },
        },
        riskFacets: [],
        confidence: {
            requirements: "high",
            repository: "high",
            design: "high",
            implementation: "high",
            verification: "high",
        },
        routingReasons: [],
        decisions: [],
        budgetUsage: {},
        dispatches: [
            {
                id: "d1",
                action: "exploration",
                agent: "agent",
                capability: "exploration",
                purpose: "workflow",
                independent: false,
                inputHash: "h1",
                status: "completed",
                at: "now",
            },
            {
                id: "d2",
                action: "implementation",
                agent: "agent",
                capability: "implementation",
                purpose: "workflow",
                independent: false,
                inputHash: "h2",
                status: "issued",
                at: "now",
            },
        ],
        artifacts: {},
        invalidations: [],
        repairs: [],
        reviewSubmissions: [],
        repairTasks: [],
        frontierPolicy: {
            mode: "disabled",
            maxEscalationsPerRun: 2,
            maxDispatchesPerRun: 3,
            maxHighDispatchesPerRun: 1,
        },
        frontierUsage: { escalations: 0, dispatches: 0, highDispatches: 0 },
        frontierHistory: [],
        questionHistory: [],
        checkpointHistory: [],
        createdAt: "now",
        updatedAt: "now",
        status: "running",
    }
    return { ...base, ...overrides }
}

describe("summarize", () => {
    it("shows a running run with dispatch progress", () => {
        const summary = summarize(state(), "my-change", "Run started")
        expect(summary).toContain("○ Run started")
        expect(summary).toContain("my-change")
        expect(summary).toContain("tier=lean")
        expect(summary).toContain("dispatches=1/2")
        expect(summary).toContain('specops_get_status(change="my-change")')
    })

    it("shows a completed run that was archived", () => {
        const summary = summarize(
            state({
                status: "completed",
                archivedAt: "now",
                outcome: {
                    category: "completed",
                    message: "All gates passed.",
                    at: "now",
                },
            }),
            "completed-change",
            "Run finalized",
        )
        expect(summary).toContain("✓ Run finalized")
        expect(summary).toContain("outcome=completed")
        expect(summary).toContain("OpenSpec change archived to openspec/changes/archive/.")
    })

    it("shows a completed run that was not archived when auto-archive is disabled", () => {
        const summary = summarize(
            state({
                status: "completed",
                outcome: {
                    category: "completed",
                    message: "All gates passed.",
                    at: "now",
                },
            }),
            "completed-change",
            "Run finalized",
        )
        expect(summary).toContain("✓ Run finalized")
        expect(summary).toContain(
            "OpenSpec auto-archive disabled; change remains in openspec/changes/.",
        )
    })

    it("shows an archive_failed run with a retryable error", () => {
        const summary = summarize(
            state({
                status: "archive_failed",
                archiveError: {
                    attempt: 2,
                    kind: "command_failed",
                    message: "openspec archive exited with code 1",
                    at: "now",
                },
            }),
            "archive-failed-change",
            "Archive failed",
        )
        expect(summary).toContain("⚠ Archive failed")
        expect(summary).toContain("Archival failed (command_failed, attempt 2)")
        expect(summary).toContain("Retry via specops_finalize or specops_archive_run")
    })

    it("shows a failed run message", () => {
        const summary = summarize(
            state({
                status: "failed",
                outcome: {
                    category: "validation-failed",
                    message: "OpenSpec validation failed.",
                    at: "now",
                },
            }),
            "failed-change",
            "Run finalized",
        )
        expect(summary).toContain("✗ Run finalized")
        expect(summary).toContain("outcome=validation-failed")
        expect(summary).toContain("OpenSpec validation failed.")
    })

    it("shows a paused run", () => {
        const summary = summarize(state({ status: "paused" }), "paused-change", "Question raised")
        expect(summary).toContain("⏸ Question raised")
    })

    it("shows a cancelled run", () => {
        const summary = summarize(
            state({ status: "cancelled" }),
            "cancelled-change",
            "Run cancelled",
        )
        expect(summary).toContain("⊘ Run cancelled")
    })
})

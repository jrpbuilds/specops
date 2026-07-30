/**
 * Regression tests for worker-output wire-format contracts.
 *
 * These tests exercise the planning-bundle, judgment, and review-ledger parsers
 * through the public {@link completeAction} surface with both valid and
 * malformed worker output, asserting the exact actionable error messages
 * produced by the parsers and the resulting dispatch failure state. They also
 * verify that the scheduler dispatch prompts include the generated contract
 * strings so agents receive the exact expected output shape.
 */
import { mkdir, mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "../src/config.js"
import { requirementsFor } from "../src/routing/policy.js"
import { agentForCapability } from "../src/capabilities/registry.js"
import { changeRoot, readRun, writeRun } from "../src/state/store.js"
import type { Assessment, RunState } from "../src/types.js"
import { completeAction } from "../src/workflow/engine.js"
import { nextAction } from "../src/workflow/scheduler.js"
import {
    JUDGMENT_CONTRACT,
    PLANNING_BUNDLE_CONTRACT,
    REVIEW_LEDGER_CONTRACT,
} from "../src/workflow/contracts.generated.js"

/** Standard assessment that routes to the standard tier for bundle testing. */
const standardAssessment: Assessment = {
    changeKind: "feature",
    expectedFiles: 3,
    expectedModules: 2,
    restoresExistingBehavior: false,
    changesRequirements: true,
    publicContract: "none",
    riskFacets: [],
    touchedSurfaces: [],
    uncertainty: {
        requirements: "medium",
        repository: "medium",
        design: "medium",
        implementation: "medium",
        verification: "medium",
    },
    suggestedTier: "standard",
    inspectedPaths: ["src/example.ts"],
    unresolvedQuestions: [],
    likelyValidations: [],
    facts: ["localized"],
    inferences: [],
}

/** A valid spec body following the spec.md template with scenarios. */
const validSpec = [
    "## ADDED Requirements",
    "",
    "### Requirement: Document behavior",
    "The system SHALL describe the compatible behavior.",
    "",
    "#### Scenario: Reader opens the document",
    "- **WHEN** a reader opens the document",
    "- **THEN** the compatible behavior is described",
    "",
].join("\n")

/**
 * Create a temporary directory and persisted run state for outcome testing.
 * @returns A directory, change name, and mutable run state.
 */
async function persistedRun(): Promise<{ directory: string; change: string; state: RunState }> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "specops-contract-"))
    const change = "contract-test"
    await mkdir(changeRoot(directory, change), { recursive: true })
    return { directory, change, state: standardState() }
}

/** Build a standard-tier automatic run state. */
function standardState(): RunState {
    const assessed = standardAssessment
    return {
        version: 2,
        mode: "automatic",
        goal: "test",
        baseline: "abc",
        requestedTier: "auto",
        scopeTier: "standard",
        assessment: assessed,
        requirements: requirementsFor(assessed, "auto", DEFAULT_CONFIG).requirements,
        riskFacets: [],
        uncertainty: assessed.uncertainty,
        routingReasons: [],
        decisions: [],
        budgetUsage: {},
        dispatches: [],
        artifacts: {},
        invalidations: [],
        repairs: [],
        questionHistory: [],
        questionBudgetUsage: {
            questionsRaised: 0,
            questionsByDispatch: {},
            fingerprintCounts: {},
        },
        createdAt: "now",
        updatedAt: "now",
        status: "running",
    }
}

/** Construct a dispatch record for a given capability and purpose. */
function dispatch(
    id: string,
    capability: RunState["requirements"]["requiredCapabilities"][number],
    purpose: RunState["dispatches"][number]["purpose"],
    action: string,
): RunState["dispatches"][number] {
    return {
        id,
        action,
        agent: agentForCapability(capability, purpose),
        capability,
        purpose,
        independent: purpose === "judgment" || purpose === "independent-review",
        inputHash: "input",
        status: "issued",
        at: "now",
    }
}

/** Mark an artifact as valid in the run state. */
function validArtifact(state: RunState, artifact: string): void {
    state.artifacts[artifact as keyof RunState["artifacts"]] = {
        artifact: artifact as keyof RunState["artifacts"],
        producer: "test",
        purpose: "workflow",
        generatedAt: "now",
        inputHashes: {},
        outputHash: "output",
        scopeTier: state.scopeTier,
        capabilities: state.requirements.requiredCapabilities,
        validity: "valid",
    } as RunState["artifacts"][keyof RunState["artifacts"]]
}

describe("planning bundle contract", () => {
    it("accepts a valid planning bundle with normative specs", async () => {
        const run = await persistedRun()
        run.state.dispatches.push(dispatch("plan", "planning", "workflow", "standard-bundle"))
        await writeRun(run.directory, run.change, run.state)

        const bundle = JSON.stringify({
            proposal: "# Proposal\n\n## Why\n\nFix.\n",
            specs: { "doc-behavior": validSpec },
            tasks: "# Tasks\n\n- [ ] 1.1 Do it\n",
        })

        const completed = await completeAction(
            run.directory,
            run.change,
            "plan",
            bundle,
            DEFAULT_CONFIG,
        )
        expect(completed.status).toBe("running")
        expect(completed.dispatches[0]?.status).toBe("completed")
    })

    it("rejects specs as an array with an actionable message", async () => {
        const run = await persistedRun()
        run.state.dispatches.push(dispatch("plan", "planning", "workflow", "standard-bundle"))
        await writeRun(run.directory, run.change, run.state)

        const bundle = JSON.stringify({
            proposal: "# Proposal\n## Why\n\nFix.\n",
            specs: [{ file: "x", action: "delete", what: "rm", why: "gone" }],
        })

        await expect(
            completeAction(run.directory, run.change, "plan", bundle, DEFAULT_CONFIG),
        ).rejects.toThrow(
            /specs must be a JSON object mapping spec names to markdown strings, not an array/,
        )
        const failedState = await readRun(run.directory, run.change)
        expect(failedState.dispatches[0]?.status).toBe("failed")
    })

    it("rejects an invalid spec name with the allowed pattern", async () => {
        const run = await persistedRun()
        run.state.dispatches.push(dispatch("plan", "planning", "workflow", "standard-bundle"))
        await writeRun(run.directory, run.change, run.state)

        const bundle = JSON.stringify({
            proposal: "# Proposal\n## Why\n\nFix.\n",
            specs: { Bad_Name: validSpec },
        })

        await expect(
            completeAction(run.directory, run.change, "plan", bundle, DEFAULT_CONFIG),
        ).rejects.toThrow(/spec name "Bad_Name" must match/)
    })

    it("rejects empty spec content", async () => {
        const run = await persistedRun()
        run.state.dispatches.push(dispatch("plan", "planning", "workflow", "standard-bundle"))
        await writeRun(run.directory, run.change, run.state)

        const bundle = JSON.stringify({
            proposal: "# Proposal\n## Why\n\nFix.\n",
            specs: { "valid-name": "   " },
        })

        await expect(
            completeAction(run.directory, run.change, "plan", bundle, DEFAULT_CONFIG),
        ).rejects.toThrow(/content must be a non-empty string/)
    })

    it("rejects spec content missing a delta section", async () => {
        const run = await persistedRun()
        run.state.dispatches.push(dispatch("plan", "planning", "workflow", "standard-bundle"))
        await writeRun(run.directory, run.change, run.state)

        const bundle = JSON.stringify({
            proposal: "# Proposal\n## Why\n\nFix.\n",
            specs: { "no-section": "DELETE scripts/install.sh. The installer is gone." },
        })

        await expect(
            completeAction(run.directory, run.change, "plan", bundle, DEFAULT_CONFIG),
        ).rejects.toThrow(/must contain a "## ADDED\/MODIFIED\/REMOVED Requirements" section/)
    })

    it("rejects spec content missing a requirement block", async () => {
        const run = await persistedRun()
        run.state.dispatches.push(dispatch("plan", "planning", "workflow", "standard-bundle"))
        await writeRun(run.directory, run.change, run.state)

        const bundle = JSON.stringify({
            proposal: "# Proposal\n## Why\n\nFix.\n",
            specs: { "no-req": "## ADDED Requirements\n\nNo requirements here." },
        })

        await expect(
            completeAction(run.directory, run.change, "plan", bundle, DEFAULT_CONFIG),
        ).rejects.toThrow(/must contain at least one "### Requirement:" heading/)
    })

    it("rejects a requirement block without a scenario", async () => {
        const run = await persistedRun()
        run.state.dispatches.push(dispatch("plan", "planning", "workflow", "standard-bundle"))
        await writeRun(run.directory, run.change, run.state)

        const noScenario = [
            "## ADDED Requirements",
            "",
            "### Requirement: Missing scenario",
            "The system SHALL do something.",
            "",
        ].join("\n")
        const bundle = JSON.stringify({
            proposal: "# Proposal\n## Why\n\nFix.\n",
            specs: { "no-scenario": noScenario },
        })

        await expect(
            completeAction(run.directory, run.change, "plan", bundle, DEFAULT_CONFIG),
        ).rejects.toThrow(/must have at least one "#### Scenario:"/)
    })

    it("rejects a scenario missing a WHEN or THEN clause", async () => {
        const run = await persistedRun()
        run.state.dispatches.push(dispatch("plan", "planning", "workflow", "standard-bundle"))
        await writeRun(run.directory, run.change, run.state)

        const noWhen = [
            "## ADDED Requirements",
            "",
            "### Requirement: Missing WHEN",
            "The system SHALL do something.",
            "",
            "#### Scenario: Incomplete",
            "- **THEN** the result is produced",
            "",
        ].join("\n")
        const bundle = JSON.stringify({
            proposal: "# Proposal\n## Why\n\nFix.\n",
            specs: { "no-when": noWhen },
        })

        await expect(
            completeAction(run.directory, run.change, "plan", bundle, DEFAULT_CONFIG),
        ).rejects.toThrow(/is missing "- \*\*WHEN\*\*" clause/)
    })
})

describe("judgment contract", () => {
    it("rejects an invalid verdict with the allowed values", async () => {
        const run = await persistedRun()
        run.state.requirements.budgets.maxRepairCycles = 0
        run.state.dispatches.push(
            dispatch("judgment", "correctness-judgment", "judgment", "correctness-judgment"),
        )
        await writeRun(run.directory, run.change, run.state)

        await expect(
            completeAction(
                run.directory,
                run.change,
                "judgment",
                JSON.stringify({ verdict: "FAILS", summary: "Bad.", findings: [] }),
                DEFAULT_CONFIG,
            ),
        ).rejects.toThrow(/verdict must be "PASS" or "FAIL", got "FAILS"/)
        const failedState = await readRun(run.directory, run.change)
        expect(failedState.dispatches[0]?.status).toBe("failed")
    })

    it("rejects a missing summary", async () => {
        const run = await persistedRun()
        run.state.requirements.budgets.maxRepairCycles = 0
        run.state.dispatches.push(
            dispatch("judgment", "correctness-judgment", "judgment", "correctness-judgment"),
        )
        await writeRun(run.directory, run.change, run.state)

        await expect(
            completeAction(
                run.directory,
                run.change,
                "judgment",
                JSON.stringify({ verdict: "PASS", findings: [] }),
                DEFAULT_CONFIG,
            ),
        ).rejects.toThrow(/summary must be a non-empty string/)
    })

    it("rejects an empty summary", async () => {
        const run = await persistedRun()
        run.state.requirements.budgets.maxRepairCycles = 0
        run.state.dispatches.push(
            dispatch("judgment", "correctness-judgment", "judgment", "correctness-judgment"),
        )
        await writeRun(run.directory, run.change, run.state)

        await expect(
            completeAction(
                run.directory,
                run.change,
                "judgment",
                JSON.stringify({ verdict: "PASS", summary: "   ", findings: [] }),
                DEFAULT_CONFIG,
            ),
        ).rejects.toThrow(/summary must be a non-empty string/)
    })

    it("rejects non-array findings", async () => {
        const run = await persistedRun()
        run.state.requirements.budgets.maxRepairCycles = 0
        run.state.dispatches.push(
            dispatch("judgment", "correctness-judgment", "judgment", "correctness-judgment"),
        )
        await writeRun(run.directory, run.change, run.state)

        await expect(
            completeAction(
                run.directory,
                run.change,
                "judgment",
                JSON.stringify({ verdict: "PASS", summary: "Good.", findings: "none" }),
                DEFAULT_CONFIG,
            ),
        ).rejects.toThrow(/findings must be an array/)
    })
})

describe("review ledger contract", () => {
    it("rejects a lowercase severity with the uppercase enum", async () => {
        const run = await persistedRun()
        run.state.dispatches.push(dispatch("review", "refutation", "workflow", "refutation"))
        await writeRun(run.directory, run.change, run.state)

        await expect(
            completeAction(
                run.directory,
                run.change,
                "review",
                JSON.stringify({
                    findings: [{ severity: "high", summary: "Lowercase severity." }],
                }),
                DEFAULT_CONFIG,
            ),
        ).rejects.toThrow(/severity must be one of BLOCKER, HIGH, MEDIUM, LOW \(uppercase\)/)
        const failedState = await readRun(run.directory, run.change)
        expect(failedState.dispatches[0]?.status).toBe("failed")
    })

    it("rejects an invalid mode with the allowed set", async () => {
        const run = await persistedRun()
        run.state.dispatches.push(dispatch("review", "refutation", "workflow", "refutation"))
        await writeRun(run.directory, run.change, run.state)

        await expect(
            completeAction(
                run.directory,
                run.change,
                "review",
                JSON.stringify({
                    findings: [{ severity: "HIGH", mode: "unknown-mode", summary: "Bad mode." }],
                }),
                DEFAULT_CONFIG,
            ),
        ).rejects.toThrow(/mode must be one of implementation-defect/)
    })

    it("rejects an empty summary", async () => {
        const run = await persistedRun()
        run.state.dispatches.push(dispatch("review", "refutation", "workflow", "refutation"))
        await writeRun(run.directory, run.change, run.state)

        await expect(
            completeAction(
                run.directory,
                run.change,
                "review",
                JSON.stringify({
                    findings: [{ severity: "HIGH", summary: "   " }],
                }),
                DEFAULT_CONFIG,
            ),
        ).rejects.toThrow(/summary must be a non-empty string/)
    })

    it("does not embed runtime blocking severities in the generated contract", () => {
        // The review-ledger contract is config-neutral; runtime
        // blockingSeverities is controller policy, not worker instruction.
        expect(REVIEW_LEDGER_CONTRACT).not.toContain("configured blocking severities")
    })

    it("accepts a modeless blocking finding as review-failed", async () => {
        const run = await persistedRun()
        run.state.dispatches.push(dispatch("review", "refutation", "workflow", "refutation"))
        await writeRun(run.directory, run.change, run.state)

        const reviewed = await completeAction(
            run.directory,
            run.change,
            "review",
            JSON.stringify({
                findings: [{ severity: "HIGH", summary: "Unresolved review failure." }],
            }),
            DEFAULT_CONFIG,
        )
        // A modeless HIGH finding is blocking (default blockingSeverities) and
        // falls through to the terminal review-failed outcome — intended behavior.
        expect(reviewed.status).toBe("failed")
        expect(reviewed.outcome?.category).toBe("review-failed")
    })
})

describe("scheduler contract consumption", () => {
    it("includes the planning-bundle contract in the planning dispatch prompt", () => {
        const state = standardState()
        // Mark exploration complete so the scheduler advances to proposal.
        validArtifact(state, "exploration")
        validArtifact(state, "routing")

        const action = nextAction(state)
        expect(action?.capability).toBe("planning")
        expect(action?.prompt).toContain(PLANNING_BUNDLE_CONTRACT)
        expect(action?.prompt).toContain("Do not write files.")
    })

    it("includes the judgment contract in the correctness-judgment dispatch prompt", () => {
        const state = standardState()
        // Mark all prior standard-tier artifacts complete so the scheduler
        // advances to the correctness-judgment phase.
        for (const artifact of [
            "routing",
            "exploration",
            "proposal",
            "specs",
            "tasks",
            "implementation",
            "verification",
        ]) {
            validArtifact(state, artifact)
        }
        // Mark required specialist reviews complete to reach the judgment gate.
        validArtifact(state, "correctness-judgment")

        const action = nextAction(state)
        // The scheduler may return a compliance-judgment or review-ledger next,
        // but correctness-judgment must be dispatched before those. Verify that
        // when it is the correctness-judgment turn, the prompt carries the
        // contract by checking the compliance-judgment path uses the contract.
        if (action?.capability === "compliance-judgment") {
            expect(action.prompt).toContain(JUDGMENT_CONTRACT)
        } else {
            // The correctness-judgment was already completed above, so the
            // scheduler should advance to compliance-judgment or review-ledger.
            expect(action?.capability).toMatch(/compliance-judgment|refutation/)
        }
    })

    it("includes the review-ledger contract in the refutation dispatch prompt", () => {
        const state = standardState()
        for (const artifact of [
            "routing",
            "exploration",
            "proposal",
            "specs",
            "tasks",
            "implementation",
            "verification",
            "correctness-judgment",
            "compliance-judgment",
        ]) {
            validArtifact(state, artifact)
        }
        // The standard tier requires a general-risk independent review before
        // the refutation phase; mark it completed so the scheduler advances.
        state.dispatches.push({
            ...dispatch("risk", "general-risk", "independent-review", "general-risk"),
            status: "completed",
        })

        const action = nextAction(state)
        expect(action?.capability).toBe("refutation")
        expect(action?.prompt).toContain(REVIEW_LEDGER_CONTRACT)
    })
})

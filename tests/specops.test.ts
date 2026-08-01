import { mkdir, mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG, validateConfig } from "../src/config.js"
import { requirementsFor } from "../src/routing/policy.js"
import { downstream } from "../src/artifacts/graph.js"
import { AGENT_REGISTRY, agentForCapability } from "../src/capabilities/registry.js"
import { parseAssessment } from "../src/routing/assessment.js"
import { AGENT_IDS } from "../src/capabilities/ids.js"
import { executeValidation } from "../src/evidence/commands.js"
import { applyEscalation, decideEscalation } from "../src/escalation/policy.js"
import { changeRoot, writeMachine, writeRun } from "../src/state/store.js"
import type { Assessment, RunState } from "../src/types.js"
import {
    cancelRun,
    completeAction,
    finalizeRun,
    issueDirective,
    recoverDispatch,
} from "../src/workflow/engine.js"
import { nextAction } from "../src/workflow/scheduler.js"

const assessment = (overrides: Partial<Assessment> = {}): Assessment => ({
    changeKind: "bugfix",
    expectedFiles: 1,
    expectedModules: 1,
    restoresExistingBehavior: true,
    changesRequirements: false,
    publicContract: "none",
    riskFacets: [],
    touchedSurfaces: [],
    uncertainty: {
        requirements: "high",
        repository: "high",
        design: "high",
        implementation: "high",
        verification: "high",
    },
    suggestedTier: "lean",
    inspectedPaths: ["src/example.ts"],
    unresolvedQuestions: [],
    likelyValidations: [],
    facts: ["localized"],
    inferences: [],
    ...overrides,
})

describe("final SpecOps policy", () => {
    it("routes a restorative local fix to Lean", () => {
        expect(requirementsFor(assessment(), "auto", DEFAULT_CONFIG).requirements.scopeTier).toBe(
            "lean",
        )
    })

    it("snapshots run budgets without mutating project defaults", () => {
        const first = requirementsFor(assessment(), "auto", DEFAULT_CONFIG)
        first.requirements.budgets.maxRepairCycles = 0
        const second = requirementsFor(assessment(), "auto", DEFAULT_CONFIG)
        expect(second.requirements.budgets.maxRepairCycles).toBe(
            DEFAULT_CONFIG.escalation.budgets.maxRepairCycles,
        )
    })
    it("adds a security specialist without forcing Full", () => {
        const result = requirementsFor(
            assessment({ riskFacets: ["security"], expectedFiles: 2 }),
            "auto",
            DEFAULT_CONFIG,
        ).requirements
        expect(result.scopeTier).toBe("standard")
        expect(result.requiredCapabilities).toContain("security")
        expect(result.requiredReviewFacets).toEqual(["security"])
    })
    it("makes migration Full", () => {
        expect(
            requirementsFor(
                assessment({ changeKind: "migration", riskFacets: ["migration"] }),
                "auto",
                DEFAULT_CONFIG,
            ).requirements.scopeTier,
        ).toBe("full")
    })
    it("rejects unknown configuration fields", () => {
        expect(() =>
            validateConfig({
                ...DEFAULT_CONFIG,
                workflow: { ...DEFAULT_CONFIG.workflow, unknownField: "lean" },
            }),
        ).toThrow("unknownField")
    })
    it("keeps specialist identities distinct", () => {
        expect(agentForCapability("security")).toBe(AGENT_IDS.specialist.security)
        expect(AGENT_REGISTRY[AGENT_IDS.review.risk].permission.edit).toBe("deny")
    })
    it("invalidates all assurance downstream of implementation", () => {
        expect(downstream(["implementation"])).toEqual(
            expect.arrayContaining([
                "verification",
                "correctness-judgment",
                "review-ledger",
                "receipt",
            ]),
        )
    })

    it("accepts a bounded escalation only when it adds a new requirement", () => {
        const routed = requirementsFor(assessment(), "auto", DEFAULT_CONFIG).requirements
        const state = {
            version: 6 as const,
            revision: 0,
            mode: "automatic" as const,
            goal: "test",
            baseline: "abc",
            requestedTier: "auto" as const,
            scopeTier: "lean" as const,
            assessment: assessment(),
            requirements: routed,
            riskFacets: [],
            uncertainty: assessment().uncertainty,
            routingReasons: [],
            decisions: [],
            budgetUsage: {},
            dispatches: [],
            artifacts: {},
            invalidations: [],
            repairs: [],
            reviewSubmissions: [],
            repairTasks: [],
            frontierPolicy: structuredClone(DEFAULT_CONFIG.frontier),
            frontierUsage: { escalations: 0, dispatches: 0, highDispatches: 0 },
            frontierHistory: [],
            questionHistory: [],
            checkpointHistory: [],
            createdAt: "now",
            updatedAt: "now",
            status: "running" as const,
        }
        const claim = {
            category: "risk-discovery" as const,
            confidence: "high" as const,
            summary: "A public contract was discovered.",
            evidence: [],
            boundaryCrossed: "public API",
            whyCurrentRequirementsAreInsufficient: "Contract review is required.",
            requestedPatch: {
                addCapabilities: ["public-contract" as const],
                addReviewFacets: ["public-contract" as const],
            },
        }
        const decision = decideEscalation(state, claim)
        expect(decision.disposition).toBe("narrowed")
        applyEscalation(state, decision.appliedPatch)
        expect(state.scopeTier).toBe("standard")
        expect(state.requirements.requiredCapabilities).toContain("public-contract")
        expect(decideEscalation(state, claim).disposition).toBe("rejected")
    })

    it("runs arbitrary registered executables without a shell and bounds output", async () => {
        const evidence = await executeValidation(
            process.cwd(),
            {
                ...DEFAULT_CONFIG,
                review: { ...DEFAULT_CONFIG.review, commandOutputBytes: 64 },
            },
            {
                executable: process.execPath,
                args: ["--eval", "process.stdout.write('x'.repeat(1000))"],
                validationId: "node-output",
                dispatchId: "dispatch",
                implementationDiffHash: "diff",
                policyHash: "policy",
            },
        )
        expect(
            Buffer.byteLength(evidence.stdoutExcerpt) + Buffer.byteLength(evidence.stderrExcerpt),
        ).toBeLessThanOrEqual(96)
        expect(evidence.args).toEqual(["--eval", "process.stdout.write('x'.repeat(1000))"])
        expect(evidence).toMatchObject({
            implementationDiffHash: "diff",
            policyHash: "policy",
        })
    })

    it("forwards adapter cancellation to a running evidence command", async () => {
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 25)
        const evidence = await executeValidation(
            process.cwd(),
            DEFAULT_CONFIG,
            {
                executable: process.execPath,
                args: ["--eval", "setTimeout(() => {}, 10_000)"],
                validationId: "cancelled-command",
                dispatchId: "dispatch",
            },
            controller.signal,
        )
        expect(evidence.exitCode).not.toBe(0)
    })

    it("blocks safely when a failed judgment exhausts the repair budget", async () => {
        const { directory, change, state } = await persistedRun()
        state.requirements.budgets.maxRepairCycles = 0
        state.dispatches.push(dispatch("judgment", "correctness-judgment", "judgment"))
        await writeRun(directory, change, state)

        const completed = await completeAction(
            directory,
            change,
            "judgment",
            JSON.stringify({ verdict: "FAIL", summary: "Implementation defect.", findings: [] }),
            DEFAULT_CONFIG,
        )

        expect(completed.status).toBe("blocked")
        expect(completed.outcome?.category).toBe("policy-blocked")
    })

    it("persists review and validation failure outcomes for machine consumers", async () => {
        const reviewRun = await persistedRun()
        reviewRun.state.reviewSubmissions = [
            {
                id: "submission",
                dispatchId: "source-dispatch",
                capability: "general-risk",
                inputHash: "input",
                implementationDiffHash: reviewRun.state.implementationDiffHash,
                policyHash: reviewRun.state.requirements.policyHash,
                findings: [
                    {
                        id: "source",
                        severity: "HIGH",
                        summary: "Unresolved review failure.",
                        evidence: [],
                        acceptanceCriteria: [],
                    },
                ],
                at: "now",
            },
        ]
        reviewRun.state.dispatches.push({
            ...dispatch("source-dispatch", "general-risk", "independent-review"),
            status: "completed",
        })
        reviewRun.state.dispatches.push(dispatch("review", "refutation", "workflow"))
        await writeRun(reviewRun.directory, reviewRun.change, reviewRun.state)
        const reviewed = await completeAction(
            reviewRun.directory,
            reviewRun.change,
            "review",
            JSON.stringify({
                findings: [
                    {
                        severity: "HIGH",
                        summary: "Unresolved review failure.",
                        evidence: [
                            {
                                kind: "repository-path",
                                path: `openspec/changes/${reviewRun.change}/specops-run.json`,
                            },
                        ],
                        acceptanceCriteria: [],
                        sourceFindingIds: ["source"],
                    },
                ],
                dismissed: [],
            }),
            DEFAULT_CONFIG,
        )
        expect(reviewed.status).toBe("failed")
        expect(reviewed.outcome?.category).toBe("review-failed")

        const validationRun = await persistedRun()
        makeSchedulerComplete(validationRun.state)
        validationRun.state.requirements.requiredValidations.push({
            id: "required-command",
            kind: "command",
            executable: process.execPath,
            args: ["--version"],
            purpose: "Required command evidence.",
            requirements: ["outcome"],
        })
        await writeMachine(validationRun.directory, validationRun.change, "specops-evidence.json", {
            version: 2,
            commands: [
                {
                    id: "stale-command",
                    executable: process.execPath,
                    args: ["--version"],
                    cwd: validationRun.directory,
                    startedAt: "now",
                    finishedAt: "now",
                    exitCode: 0,
                    stdoutHash: "stdout",
                    stderrHash: "stderr",
                    stdoutExcerpt: "",
                    stderrExcerpt: "",
                    validationId: "required-command",
                    dispatchId: "old-dispatch",
                    implementationDiffHash: "old-diff",
                    policyHash: "old-policy",
                },
            ],
        })
        await writeRun(validationRun.directory, validationRun.change, validationRun.state)
        const validated = await finalizeRun(
            validationRun.directory,
            validationRun.change,
            DEFAULT_CONFIG,
        )
        expect(validated.status).toBe("failed")
        expect(validated.outcome?.category).toBe("validation-failed")
    })

    it("gives visible and CLI automatic adapters identical routing and first action", () => {
        const left = automaticState()
        const right = automaticState()
        expect(left.requirements).toEqual(right.requirements)

        const leftAction = nextAction(left)
        const rightAction = nextAction(right)
        expect({ ...leftAction, id: undefined }).toEqual({ ...rightAction, id: undefined })
    })

    it("records cancellation and closes any issued dispatch safely", async () => {
        const run = await persistedRun()
        run.state.dispatches.push(dispatch("active", "exploration", "workflow"))
        await writeRun(run.directory, run.change, run.state)

        const cancelled = await cancelRun(run.directory, run.change, "Interrupted by CI.")
        expect(cancelled.status).toBe("cancelled")
        expect(cancelled.outcome?.category).toBe("cancelled")
        expect(cancelled.dispatches[0]?.status).toBe("failed")
    })

    it("refuses to issue concurrent workflow dispatches", async () => {
        const { directory, change, state } = await persistedRun()
        await writeRun(directory, change, state)

        const first = await issueDirective(directory, change, DEFAULT_CONFIG)
        expect(first.type).toBe("dispatch")
        await expect(issueDirective(directory, change, DEFAULT_CONFIG)).rejects.toThrow(
            "is still issued and must be completed first",
        )
    })

    it("recovers an interrupted dispatch without cancelling the run", async () => {
        const { directory, change, state } = await persistedRun()
        state.dispatches.push(dispatch("interrupted", "exploration", "workflow"))
        await writeRun(directory, change, state)

        const recovered = await recoverDispatch(
            directory,
            change,
            "interrupted",
            "the worker task was interrupted by the host",
        )
        expect(recovered.status).toBe("running")
        expect(recovered.dispatches[0]).toMatchObject({
            status: "failed",
            recovery: { reason: "the worker task was interrupted by the host" },
        })
        expect(recovered.dispatches[0]?.finishedAt).toBeTruthy()
    })

    it("blocks repeated interrupted recovery after its configured budget", async () => {
        const { directory, change, state } = await persistedRun()
        state.requirements.budgets.maxRepeatedFailureFingerprints = 1
        state.dispatches.push(dispatch("interrupted-1", "exploration", "workflow"))
        await writeRun(directory, change, state)

        const first = await recoverDispatch(
            directory,
            change,
            "interrupted-1",
            "first interruption",
        )
        first.dispatches.push(dispatch("interrupted-2", "exploration", "workflow"))
        await writeRun(directory, change, first)

        const second = await recoverDispatch(
            directory,
            change,
            "interrupted-2",
            "second interruption",
        )
        expect(second.status).toBe("blocked")
        expect(second.blockReason).toBe("budget-exhausted")
    })

    it("does not finalize with an unresolved repair task", async () => {
        const { directory, change, state } = await persistedRun()
        makeSchedulerComplete(state)
        state.repairTasks = [
            {
                id: "unverified-repair",
                target: "implementation",
                modes: ["implementation-defect"],
                findingIds: ["finding"],
                summary: "Repair is awaiting fresh assurance.",
                evidence: [],
                acceptanceCriteria: [],
                sourceLedgerHash: "ledger",
                fingerprint: "fingerprint",
                attempt: 1,
                status: "completed",
                at: "now",
            },
        ]
        await writeRun(directory, change, state)

        const finalized = await finalizeRun(directory, change, DEFAULT_CONFIG)
        expect(finalized.status).toBe("failed")
        expect(finalized.outcome?.message).toContain("Repair tasks are not verified")
    })
})

describe("parseAssessment", () => {
    const valid = () =>
        JSON.stringify({
            changeKind: "bugfix",
            expectedFiles: 1,
            expectedModules: 1,
            restoresExistingBehavior: true,
            changesRequirements: false,
            publicContract: "none",
            riskFacets: [],
            touchedSurfaces: [],
            uncertainty: {
                requirements: "high",
                repository: "high",
                design: "high",
                implementation: "high",
                verification: "high",
            },
            suggestedTier: "lean",
            inspectedPaths: ["src/example.ts"],
            unresolvedQuestions: [],
            likelyValidations: [],
            facts: ["localized"],
            inferences: [],
        })

    it("presets uncertainty in error when missing", () => {
        const payload = JSON.parse(valid())
        delete payload.uncertainty
        expect(() => parseAssessment(JSON.stringify(payload))).toThrow(
            /invalid assessment\.uncertainty/,
        )
    })

    it("echoes back an invalid changeKind with choices", () => {
        expect(() => parseAssessment(valid().replace('"bugfix"', '"readme-update"'))).toThrow(
            `invalid assessment.changeKind "readme-update" — must be one of: documentation, configuration, test, bugfix, refactor, feature, migration, infrastructure`,
        )
    })

    it("echoes back an invalid publicContract with choices", () => {
        expect(() => parseAssessment(valid().replace('"none"', '"unknown"'))).toThrow(
            `invalid assessment.publicContract "unknown" — must be one of: none, compatible, breaking`,
        )
    })

    it("echoes back an invalid suggestedTier with choices", () => {
        expect(() => parseAssessment(valid().replace('"lean"', '"tiny"'))).toThrow(
            `invalid assessment.suggestedTier "tiny" — must be one of: lean, standard, full`,
        )
    })

    it("echoes back an invalid riskFacet with choices", () => {
        const payload = JSON.parse(valid())
        payload.riskFacets = ["unknown"]
        expect(() => parseAssessment(JSON.stringify(payload))).toThrow(
            `invalid assessment.riskFacets "unknown" — must be one of:`,
        )
    })

    it("echoes back an invalid touchedSurface with choices", () => {
        const payload = JSON.parse(valid())
        payload.touchedSurfaces = ["unknown"]
        expect(() => parseAssessment(JSON.stringify(payload))).toThrow(
            `invalid assessment.touchedSurfaces "unknown" — must be one of:`,
        )
    })

    it("echoes back an invalid uncertainty level with choices", () => {
        const payload = JSON.parse(valid())
        payload.uncertainty.requirements = "sure"
        expect(() => parseAssessment(JSON.stringify(payload))).toThrow(
            `invalid assessment.uncertainty.requirements "sure" — must be one of: low, medium, high`,
        )
    })
})

describe("agent permissions", () => {
    it("gives correctness, compliance and risk reviewers bash access", () => {
        for (const id of [
            AGENT_IDS.review.correctnessJudge,
            AGENT_IDS.review.complianceJudge,
            AGENT_IDS.review.risk,
        ]) {
            expect(AGENT_REGISTRY[id].permission.bash).toBe("allow")
            expect(AGENT_REGISTRY[id].permission.edit).toBe("deny")
        }
    })

    it("keeps specialists and refuter read-only", () => {
        for (const id of [
            AGENT_IDS.specialist.security,
            AGENT_IDS.specialist.dataMigration,
            AGENT_IDS.review.refuter,
        ]) {
            expect(AGENT_REGISTRY[id].permission.bash).toBe("deny")
            expect(AGENT_REGISTRY[id].permission.edit).toBe("deny")
        }
    })
})

async function persistedRun(): Promise<{ directory: string; change: string; state: RunState }> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "specops-outcome-"))
    const change = "outcome-test"
    await mkdir(changeRoot(directory, change), { recursive: true })
    return { directory, change, state: automaticState() }
}

function automaticState(): RunState {
    const assessed = assessment()
    return {
        version: 6,
        revision: 0,
        mode: "automatic",
        goal: "test",
        baseline: "abc",
        requestedTier: "auto",
        scopeTier: "lean",
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
        reviewSubmissions: [],
        repairTasks: [],
        frontierPolicy: structuredClone(DEFAULT_CONFIG.frontier),
        frontierUsage: { escalations: 0, dispatches: 0, highDispatches: 0 },
        frontierHistory: [],
        questionHistory: [],
        checkpointHistory: [],
        createdAt: "now",
        updatedAt: "now",
        status: "running",
    }
}

function dispatch(
    id: string,
    capability: RunState["requirements"]["requiredCapabilities"][number],
    purpose: RunState["dispatches"][number]["purpose"],
): RunState["dispatches"][number] {
    return {
        id,
        action: capability,
        agent: agentForCapability(capability, purpose),
        capability,
        purpose,
        independent: purpose === "judgment" || purpose === "independent-review",
        inputHash: "input",
        status: "issued",
        at: "now",
    }
}

function makeSchedulerComplete(state: RunState): void {
    const artifact = (name: keyof RunState["artifacts"]) => ({
        artifact: name,
        producer: "test",
        purpose: "workflow" as const,
        generatedAt: "now",
        inputHashes: {},
        outputHash: "output",
        scopeTier: state.scopeTier,
        capabilities: state.requirements.requiredCapabilities,
        validity: "valid" as const,
    })
    for (const name of [
        "routing",
        "exploration",
        "proposal",
        "tasks",
        "implementation",
        "verification",
        "correctness-judgment",
        "review-ledger",
    ] as const) {
        state.artifacts[name] = artifact(name)
    }
    state.dispatches.push({
        ...dispatch("risk", "general-risk", "independent-review"),
        status: "completed",
    })
}

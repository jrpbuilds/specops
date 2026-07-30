import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { AGENT_IDS } from "../src/capabilities/ids.js"
import { DEFAULT_CONFIG } from "../src/config.js"
import { applyEscalation, decideEscalation } from "../src/escalation/policy.js"
import { onboard } from "../src/openspec.js"
import { promptText } from "../src/prompts.generated.js"
import { requirementsFor, scopeForActualDiff } from "../src/routing/policy.js"
import { changeRoot, readRun, writeRun } from "../src/state/store.js"
import type { ArtifactId, Assessment, DispatchRecord, RunState } from "../src/types.js"
import { completeAction, finalizeRun, issueDirective, startRun } from "../src/workflow/engine.js"
import { nextAction } from "../src/workflow/scheduler.js"
import { JUDGMENT_CONTRACT, REVIEW_LEDGER_CONTRACT } from "../src/workflow/contracts.generated.js"
import { parseWorkerOutput } from "../src/worker_output.js"

const assessment: Assessment = {
    changeKind: "documentation",
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
    inspectedPaths: ["README.md"],
    unresolvedQuestions: [],
    likelyValidations: [],
    facts: ["README.md is the requested documentation surface."],
    inferences: ["No product behavior changes are required."],
}

describe("compact Lean workflow", () => {
    it("materializes Lean exploration from the assessor without an explorer dispatch", async () => {
        const directory = await initializedRepository()
        await onboard(directory)

        const started = await startRun(directory, DEFAULT_CONFIG, {
            goal: "Update README wording",
            assessmentOutput: JSON.stringify(assessment),
            requestedTier: "auto",
            mode: "interactive",
        })

        expect(started.state.artifacts.exploration).toMatchObject({
            producer: AGENT_IDS.core.assessor,
            validity: "valid",
        })
        expect(started.state.dispatches).toHaveLength(0)
        expect(nextAction(started.state)).toMatchObject({
            capability: "planning",
            mode: "lean-plan",
        })
        await expect(
            readFile(path.join(changeRoot(directory, started.change), "exploration.md"), "utf8"),
        ).resolves.toContain("README.md is the requested documentation surface.")
    })

    it.each(["interactive", "automatic"] as const)(
        "uses the same four-call path in %s mode",
        mode => {
            const state = leanState(mode)
            const controller =
                mode === "interactive"
                    ? AGENT_IDS.controller.interactive
                    : AGENT_IDS.controller.automatic
            expect(promptText(controller)).toContain(AGENT_IDS.core.assessor)
            state.artifacts.routing = validArtifact(state, "routing")
            state.artifacts.exploration = validArtifact(state, "exploration")

            const plan = nextAction(state)
            expect(plan).toMatchObject({
                capability: "planning",
                agent: AGENT_IDS.core.planner,
                mode: "lean-plan",
            })
            state.artifacts.tasks = validArtifact(state, "tasks")

            const implementation = nextAction(state)
            expect(implementation).toMatchObject({
                capability: "implementation",
                agent: AGENT_IDS.core.implementer,
            })
            state.artifacts.implementation = validArtifact(state, "implementation")

            const verification = nextAction(state)
            expect(verification).toMatchObject({
                capability: "verification",
                agent: AGENT_IDS.core.verifier,
                mode: "lean-assurance-bundle",
            })
            // Lean assurance output is parsed by the same judgment and
            // review-ledger parsers, so the dispatch prompt must carry the
            // generated contracts for both nested JSON members.
            expect(verification?.prompt).toContain(JUDGMENT_CONTRACT)
            expect(verification?.prompt).toContain(REVIEW_LEDGER_CONTRACT)
            state.artifacts.verification = validArtifact(state, "verification")
            state.artifacts["correctness-judgment"] = validArtifact(state, "correctness-judgment")
            state.artifacts["review-ledger"] = validArtifact(state, "review-ledger")

            expect(nextAction(state)).toBeUndefined()
            expect(state.requirements.requiredCapabilities).toEqual([
                "assessment",
                "planning",
                "implementation",
                "verification",
            ])
        },
    )

    it.each(["interactive", "automatic"] as const)(
        "finalizes the complete four-call Lean lifecycle in %s mode",
        async mode => {
            const directory = await initializedRepository()
            await onboard(directory)
            const started = await startRun(directory, DEFAULT_CONFIG, {
                goal: "Update README wording",
                assessmentOutput: JSON.stringify(assessment),
                requestedTier: "auto",
                mode,
            })

            const planning = await issueDirective(directory, started.change, DEFAULT_CONFIG)
            expect(planning.type).toBe("dispatch")
            if (planning.type !== "dispatch") throw new Error("expected planning dispatch")
            expect(planning.action).toMatchObject({
                capability: "planning",
                mode: "lean-plan",
            })
            await completeAction(
                directory,
                started.change,
                planning.action.id,
                "# Tasks\n\n- Update the README wording.",
                DEFAULT_CONFIG,
            )

            const implementation = await issueDirective(directory, started.change, DEFAULT_CONFIG)
            expect(implementation.type).toBe("dispatch")
            if (implementation.type !== "dispatch") {
                throw new Error("expected implementation dispatch")
            }
            expect(implementation.action.capability).toBe("implementation")
            await writeFile(path.join(directory, "README.md"), "# Updated test\n")
            await completeAction(
                directory,
                started.change,
                implementation.action.id,
                "Updated README wording.",
                DEFAULT_CONFIG,
            )

            const verification = await issueDirective(directory, started.change, DEFAULT_CONFIG)
            expect(verification.type).toBe("dispatch")
            if (verification.type !== "dispatch") throw new Error("expected verifier dispatch")
            expect(verification.action).toMatchObject({
                capability: "verification",
                mode: "lean-assurance-bundle",
            })
            await completeAction(
                directory,
                started.change,
                verification.action.id,
                assuranceBundle(),
                DEFAULT_CONFIG,
            )

            await expect(
                issueDirective(directory, started.change, DEFAULT_CONFIG),
            ).resolves.toMatchObject({ type: "finalize" })
            const finalized = await finalizeRun(directory, started.change, DEFAULT_CONFIG)

            expect(finalized.status, finalized.outcome?.message).toBe("passed")
            expect(finalized.artifacts.receipt?.validity).toBe("valid")
            expect(finalized.dispatches).toHaveLength(3)
            expect(finalized.dispatches.map(dispatch => dispatch.agent)).toEqual([
                AGENT_IDS.core.planner,
                AGENT_IDS.core.implementer,
                AGENT_IDS.core.verifier,
            ])
            await expect(
                readFile(
                    path.join(changeRoot(directory, started.change), "specops-receipt.json"),
                    "utf8",
                ),
            ).resolves.toContain('"category": "completed"')
        },
    )

    it("finalizes Standard through the supported strict OpenSpec change validator", async () => {
        const directory = await initializedRepository()
        await onboard(directory)
        const started = await startRun(directory, DEFAULT_CONFIG, {
            goal: "Document a compatible behavior",
            assessmentOutput: JSON.stringify({
                ...assessment,
                changeKind: "feature",
                changesRequirements: true,
                suggestedTier: "standard",
            } satisfies Assessment),
            requestedTier: "auto",
            mode: "automatic",
        })
        const root = changeRoot(directory, started.change)
        await mkdir(path.join(root, "specs", "readme"), { recursive: true })
        await writeFile(path.join(root, "exploration.md"), "# Exploration\n\nREADME inspected.\n")
        await writeFile(
            path.join(root, "proposal.md"),
            "# Proposal\n\nDocument compatible behavior.\n",
        )
        await writeFile(
            path.join(root, "specs", "readme", "spec.md"),
            [
                "## ADDED Requirements",
                "",
                "### Requirement: Document compatible behavior",
                "The README SHALL describe the compatible behavior.",
                "",
                "#### Scenario: Reader opens the README",
                "- **WHEN** a reader opens the README",
                "- **THEN** the compatible behavior is described",
                "",
            ].join("\n"),
        )
        await writeFile(path.join(root, "tasks.md"), "# Tasks\n\n- [x] Update README.\n")
        await writeFile(path.join(root, "verification.md"), "# Verification\n\nREADME reviewed.\n")
        await writeFile(
            path.join(root, "judgment-correctness.json"),
            JSON.stringify({ verdict: "PASS", summary: "Correct.", findings: [] }),
        )
        await writeFile(
            path.join(root, "judgment-compliance.json"),
            JSON.stringify({ verdict: "PASS", summary: "Compliant.", findings: [] }),
        )
        await writeFile(path.join(root, "review-ledger.json"), JSON.stringify({ findings: [] }))

        for (const artifact of started.state.requirements.requiredArtifacts.filter(
            artifact => artifact !== "routing" && artifact !== "receipt",
        )) {
            started.state.artifacts[artifact] = validArtifact(started.state, artifact)
        }
        started.state.dispatches.push({
            id: "general-risk-review",
            action: "general-risk",
            agent: AGENT_IDS.review.risk,
            capability: "general-risk",
            purpose: "independent-review",
            independent: true,
            inputHash: "input",
            outputHash: "output",
            status: "completed",
            at: "now",
        })
        await writeRun(directory, started.change, started.state)

        const finalized = await finalizeRun(directory, started.change, DEFAULT_CONFIG)
        expect(finalized.status, finalized.outcome?.message).toBe("passed")
        expect(finalized.artifacts.receipt?.validity).toBe("valid")
    })

    it("persists a complete Lean assurance bundle from one verifier dispatch", async () => {
        const { directory, change } = await persistedLeanVerification("lean-bundle")

        const completed = await completeAction(
            directory,
            change,
            "verification",
            assuranceBundle(),
            DEFAULT_CONFIG,
        )

        expect(completed.pendingRepair).toBeUndefined()
        expect(completed.artifacts.verification?.validity).toBe("valid")
        expect(completed.artifacts["correctness-judgment"]?.validity).toBe("valid")
        expect(completed.artifacts["review-ledger"]?.validity).toBe("valid")
        expect(nextAction(completed)).toBeUndefined()
        await expect(
            readFile(path.join(changeRoot(directory, change), "verification.md"), "utf8"),
        ).resolves.toContain("README links pass")
        await expect(
            readFile(path.join(changeRoot(directory, change), "judgment-correctness.json"), "utf8"),
        ).resolves.toContain('"verdict":"PASS"')
    })

    it("rejects a malformed assurance bundle before publishing partial artifacts", async () => {
        const { directory, change } = await persistedLeanVerification("lean-malformed")

        await expect(
            completeAction(
                directory,
                change,
                "verification",
                JSON.stringify({
                    verification: "# Verification",
                    correctnessJudgment: {
                        verdict: "PASS",
                        summary: "Valid.",
                        findings: [],
                    },
                }),
                DEFAULT_CONFIG,
            ),
        ).rejects.toThrow("reviewLedger")

        const recovered = await readRun(directory, change)
        expect(recovered.artifacts.verification).toBeUndefined()
        expect(recovered.artifacts["correctness-judgment"]).toBeUndefined()
        expect(recovered.artifacts["review-ledger"]).toBeUndefined()
        expect(recovered.dispatches.at(-1)?.status).toBe("failed")
    })

    it("turns a failed bundled judgment into the existing bounded repair path", async () => {
        const { directory, change } = await persistedLeanVerification("lean-failure")

        const completed = await completeAction(
            directory,
            change,
            "verification",
            assuranceBundle({
                verdict: "FAIL",
                summary: "The README example is incorrect.",
                findings: ["incorrect example"],
            }),
            DEFAULT_CONFIG,
        )

        expect(completed.pendingRepair).toMatchObject({
            mode: "implementation-defect",
            summary: "The README example is incorrect.",
        })
        expect(completed.artifacts.implementation?.validity).toBe("stale")
        expect(completed.artifacts.verification?.validity).toBe("stale")
    })

    it("mechanically raises actual Lean diffs at Standard and Full thresholds", () => {
        const thresholds = DEFAULT_CONFIG.workflow.scopeThresholds
        expect(scopeForActualDiff("lean", ["README.md", "CHANGELOG.md"], thresholds)).toBe("lean")
        expect(
            scopeForActualDiff("lean", ["src/a.ts", "tests/a.ts", "README.md"], thresholds),
        ).toBe("standard")
        expect(
            scopeForActualDiff(
                "lean",
                Array.from({ length: thresholds.fullMinFiles }, (_, index) => `src/${index}.ts`),
                thresholds,
            ),
        ).toBe("full")
        expect(
            scopeForActualDiff("standard", ["src/a.ts", "tests/a.ts", "docs/a.md", "app/a.ts"], {
                ...thresholds,
                fullMinModules: 4,
            }),
        ).toBe("full")
    })

    it("upgrades and invalidates a Lean implementation when the real diff overflows", async () => {
        const directory = await initializedRepository()
        const change = "actual-diff-overflow"
        await mkdir(changeRoot(directory, change), { recursive: true })
        await mkdir(path.join(directory, "src"), { recursive: true })
        await mkdir(path.join(directory, "tests"), { recursive: true })
        await writeFile(path.join(directory, "src", "feature.ts"), "export const feature = true\n")
        await writeFile(path.join(directory, "tests", "feature.test.ts"), "export {}\n")
        await writeFile(path.join(directory, "CHANGELOG.md"), "# Change\n")
        const state = leanState("automatic")
        for (const artifact of ["routing", "exploration", "tasks"] as ArtifactId[]) {
            state.artifacts[artifact] = validArtifact(state, artifact)
        }
        state.dispatches.push({
            id: "implementation",
            action: "implementation",
            agent: AGENT_IDS.core.implementer,
            capability: "implementation",
            purpose: "workflow",
            independent: false,
            inputHash: "input",
            status: "issued",
            at: "now",
        })
        await writeRun(directory, change, state)

        const completed = await completeAction(
            directory,
            change,
            "implementation",
            "Implementation complete.",
            DEFAULT_CONFIG,
        )

        expect(completed.scopeTier).toBe("standard")
        expect(completed.artifacts.implementation?.validity).toBe("stale")
        expect(completed.requirements.requiredArtifacts).toContain("proposal")
        expect(nextAction(completed)).toMatchObject({
            capability: "planning",
            mode: "standard-bundle",
        })
    })

    it("rebuilds complete Standard requirements when Lean discovers a risk facet", () => {
        const state = leanState("automatic")
        const decision = decideEscalation(
            state,
            {
                category: "risk-discovery",
                confidence: "high",
                summary: "Authentication documentation exposes a public contract.",
                evidence: [{ kind: "repository-path", path: "README.md" }],
                boundaryCrossed: "Lean risk boundary",
                whyCurrentRequirementsAreInsufficient: "Public-contract review is required.",
                requestedPatch: {
                    addReviewFacets: ["public-contract"],
                },
            },
            DEFAULT_CONFIG,
        )
        applyEscalation(state, decision.appliedPatch)

        expect(state.scopeTier).toBe("standard")
        expect(state.requirements.requiredArtifacts).toEqual(
            expect.arrayContaining([
                "proposal",
                "specs",
                "tasks",
                "compliance-judgment",
                "review-ledger",
            ]),
        )
        expect(state.requirements.requiredCapabilities).toEqual(
            expect.arrayContaining([
                "exploration",
                "planning",
                "general-risk",
                "correctness-judgment",
                "compliance-judgment",
                "public-contract",
            ]),
        )
        expect(state.requirements.requiredReviewFacets).toContain("public-contract")
    })

    it("normalizes a specialist capability into consultation and independent review", () => {
        const state = leanState("automatic")
        const decision = decideEscalation(
            state,
            {
                category: "risk-discovery",
                confidence: "high",
                summary: "Security-sensitive behavior was discovered.",
                evidence: [{ kind: "repository-path", path: "README.md" }],
                boundaryCrossed: "Lean security boundary",
                whyCurrentRequirementsAreInsufficient: "Security review is required.",
                requestedPatch: {
                    addCapabilities: ["security"],
                },
            },
            DEFAULT_CONFIG,
        )

        expect(decision.appliedPatch).toMatchObject({
            raiseScopeTier: "standard",
            addCapabilities: ["security"],
            addReviewFacets: ["security"],
        })
        applyEscalation(state, decision.appliedPatch)
        expect(state.requirements.requiredCapabilities).toContain("security")
        expect(state.requirements.requiredReviewFacets).toContain("security")
    })

    it.each([
        {
            label: "missing requestedPatch",
            claim: {
                category: "risk-discovery",
                confidence: "high",
                summary: "Risk discovered.",
                evidence: [],
                boundaryCrossed: "Lean boundary",
                whyCurrentRequirementsAreInsufficient: "Review is required.",
            },
            expected: "requestedPatch",
        },
        {
            label: "invented capability",
            claim: {
                category: "risk-discovery",
                confidence: "high",
                summary: "Risk discovered.",
                evidence: [],
                boundaryCrossed: "Lean boundary",
                whyCurrentRequirementsAreInsufficient: "Review is required.",
                requestedPatch: { addCapabilities: ["root-access"] },
            },
            expected: "addCapabilities",
        },
        {
            label: "malformed command validation",
            claim: {
                category: "validation-gap",
                confidence: "high",
                summary: "Validation is missing.",
                evidence: [],
                boundaryCrossed: "Validation boundary",
                whyCurrentRequirementsAreInsufficient: "A command must run.",
                requestedPatch: {
                    addValidations: [{ id: "test", kind: "command", executable: "npm" }],
                },
            },
            expected: "command validation",
        },
    ])("rejects escalation marker with $label", ({ claim, expected }) => {
        expect(() =>
            parseWorkerOutput(
                `<!-- specops-escalation: ${JSON.stringify(claim)} -->`,
                DEFAULT_CONFIG,
                "implementation",
                "implementation",
            ),
        ).toThrow(expected)
    })

    it("invalidates the compact plan when a Lean worker raises scope", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-lean-escalation-"))
        const change = "lean-scope-raise"
        await mkdir(changeRoot(directory, change), { recursive: true })
        const state = leanState("interactive")
        state.artifacts.routing = validArtifact(state, "routing")
        state.artifacts.exploration = validArtifact(state, "exploration")
        state.dispatches.push({
            id: "lean-plan",
            action: "lean-plan",
            agent: AGENT_IDS.core.planner,
            capability: "planning",
            purpose: "workflow",
            independent: false,
            inputHash: "input",
            status: "issued",
            at: "now",
        })
        await writeRun(directory, change, state)
        const escalation = {
            category: "risk-discovery",
            confidence: "high",
            summary: "The documentation defines a public contract.",
            evidence: [{ kind: "repository-path", path: "README.md" }],
            boundaryCrossed: "Lean contract boundary",
            whyCurrentRequirementsAreInsufficient: "Compliance review is required.",
            requestedPatch: {
                addReviewFacets: ["public-contract"],
            },
        }

        const completed = await completeAction(
            directory,
            change,
            "lean-plan",
            `# Tasks\n\n- Update the contract.\n<!-- specops-escalation: ${JSON.stringify(escalation)} -->`,
            DEFAULT_CONFIG,
        )

        expect(completed.scopeTier).toBe("standard")
        expect(completed.artifacts.tasks?.validity).toBe("stale")
        expect(nextAction(completed)).toMatchObject({
            capability: "planning",
            mode: "standard-bundle",
        })
    })

    it("respects configured force-Full facets during dynamic escalation", () => {
        const state = leanState("interactive")
        const decision = decideEscalation(
            state,
            {
                category: "risk-discovery",
                confidence: "high",
                summary: "Security-sensitive behavior was discovered.",
                evidence: [{ kind: "repository-path", path: "README.md" }],
                boundaryCrossed: "Lean risk boundary",
                whyCurrentRequirementsAreInsufficient: "Full security review is configured.",
                requestedPatch: { addReviewFacets: ["security"] },
            },
            {
                ...DEFAULT_CONFIG,
                routing: { forceFullForFacets: ["security"] },
            },
        )

        expect(decision.appliedPatch.raiseScopeTier).toBe("full")
    })

    it("retains independent assurance requirements for Standard and Full", () => {
        const standard = requirementsFor(
            {
                ...assessment,
                changeKind: "feature",
                changesRequirements: true,
                suggestedTier: "standard",
            },
            "auto",
            DEFAULT_CONFIG,
        ).requirements
        expect(standard.scopeTier).toBe("standard")
        expect(standard.requiredArtifacts).toEqual(
            expect.arrayContaining([
                "proposal",
                "specs",
                "tasks",
                "correctness-judgment",
                "compliance-judgment",
                "review-ledger",
            ]),
        )
        expect(standard.requiredCapabilities).toEqual(
            expect.arrayContaining([
                "exploration",
                "general-risk",
                "correctness-judgment",
                "compliance-judgment",
            ]),
        )

        const full = requirementsFor(
            {
                ...assessment,
                changeKind: "migration",
                riskFacets: ["migration"],
                suggestedTier: "full",
            },
            "auto",
            DEFAULT_CONFIG,
        ).requirements
        expect(full.scopeTier).toBe("full")
        expect(full.requiredArtifacts).toContain("design")
        expect(full.requiredCapabilities).toEqual(expect.arrayContaining(["design", "migration"]))
    })
})

function leanState(mode: RunState["mode"]): RunState {
    const requirements = requirementsFor(assessment, "auto", DEFAULT_CONFIG).requirements
    return {
        version: 2,
        mode,
        goal: "Update README",
        baseline: "baseline",
        requestedTier: "auto",
        scopeTier: "lean",
        assessment,
        requirements,
        riskFacets: [],
        uncertainty: assessment.uncertainty,
        routingReasons: [],
        decisions: [],
        budgetUsage: {},
        dispatches: [],
        artifacts: {},
        invalidations: [],
        repairs: [],
        frontierPolicy: structuredClone(DEFAULT_CONFIG.frontier),
        frontierUsage: { escalations: 0, dispatches: 0, highDispatches: 0 },
        frontierHistory: [],
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

async function persistedLeanVerification(
    change: string,
): Promise<{ directory: string; change: string; state: RunState }> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "specops-lean-"))
    await mkdir(changeRoot(directory, change), { recursive: true })
    const state = leanState("automatic")
    for (const artifact of ["routing", "exploration", "tasks", "implementation"] as ArtifactId[]) {
        state.artifacts[artifact] = validArtifact(state, artifact)
    }
    state.dispatches.push(verificationDispatch())
    await writeRun(directory, change, state)
    return { directory, change, state }
}

function verificationDispatch(): DispatchRecord {
    return {
        id: "verification",
        action: "lean-assurance-bundle",
        agent: AGENT_IDS.core.verifier,
        capability: "verification",
        purpose: "workflow",
        independent: false,
        inputHash: "input",
        status: "issued",
        at: "now",
    }
}

function validArtifact(
    state: RunState,
    artifact: ArtifactId,
): NonNullable<RunState["artifacts"][ArtifactId]> {
    return {
        artifact,
        producer: "test",
        purpose: "workflow",
        generatedAt: "now",
        inputHashes: {},
        outputHash: artifact,
        scopeTier: state.scopeTier,
        capabilities: state.requirements.requiredCapabilities,
        validity: "valid",
    }
}

function assuranceBundle(
    judgment: { verdict: "PASS" | "FAIL"; summary: string; findings: unknown[] } = {
        verdict: "PASS",
        summary: "The documentation change is correct.",
        findings: [],
    },
): string {
    return JSON.stringify({
        verification: "# Verification\n\nREADME links pass.",
        correctnessJudgment: judgment,
        reviewLedger: { findings: [] },
    })
}

async function initializedRepository(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "specops-lean-repository-"))
    execFileSync("git", ["init", "--quiet"], { cwd: directory })
    execFileSync("git", ["config", "user.email", "specops@example.test"], { cwd: directory })
    execFileSync("git", ["config", "user.name", "SpecOps Test"], { cwd: directory })
    await writeFile(path.join(directory, "README.md"), "# Test\n")
    execFileSync("git", ["add", "README.md"], { cwd: directory })
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: directory })
    return directory
}

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { AGENT_IDS } from "../src/capabilities/ids.js"
import { agentForCapability } from "../src/capabilities/registry.js"
import { DEFAULT_CONFIG, validateConfig } from "../src/config.js"
import { migrateLegacyFrontierManifest, DEFAULT_MANIFEST } from "../src/manifest.js"
import { requirementsFor } from "../src/routing/policy.js"
import { changeRoot, readRun, writeRun } from "../src/state/store.js"
import type {
    Assessment,
    ArtifactId,
    CapabilityId,
    CommandEvidence,
    DispatchPurpose,
    DispatchRecord,
    FrontierRequest,
    RunState,
} from "../src/types.js"
import { cancelRun, completeAction, issueDirective } from "../src/workflow/engine.js"
import { parseFrontierResponse, verifyFrontierEvidence } from "../src/frontier/policy.js"
import { parseWorkerOutput } from "../src/worker_output.js"

const assessment: Assessment = {
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
    inspectedPaths: ["target.ts"],
    unresolvedQuestions: [],
    likelyValidations: [],
    facts: ["localized"],
    inferences: [],
}

const adaptiveConfig = {
    ...DEFAULT_CONFIG,
    frontier: { ...DEFAULT_CONFIG.frontier, mode: "adaptive" as const },
}

describe("adaptive frontier escalation", () => {
    it("parses a strict evidence-backed frontier marker", () => {
        const output = [
            "Best effort.",
            '<!-- specops-frontier: {"tier":"low","task":"Resolve the implementation blocker","whyNormalPathIsInsufficient":"The attempted API shape conflicts with the existing contract.","impact":"implementation","evidence":[{"kind":"repository-path","path":"src/types.ts"}],"attempts":["Inspected and attempted the existing adapter."]} -->',
        ].join("\n")
        const parsed = parseWorkerOutput(output, adaptiveConfig, "implementation", "implementation")
        expect(parsed.prose).toBe("Best effort.")
        expect(parsed.frontier?.tier).toBe("low")
        expect(parsed.frontier?.evidence).toHaveLength(1)
    })

    it("routes one logical capability to low and high backing agents", () => {
        expect(agentForCapability("frontier", "frontier-escalation", "low")).toBe(
            AGENT_IDS.review.frontierLow,
        )
        expect(agentForCapability("frontier", "frontier-escalation", "high")).toBe(
            AGENT_IDS.review.frontierHigh,
        )
    })

    it("defaults missing project frontier policy to disabled", () => {
        const input = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>
        delete input.frontier
        expect(validateConfig(input).frontier).toEqual(DEFAULT_CONFIG.frontier)
    })

    it("rejects invalid adaptive frontier budget relationships", () => {
        expect(() =>
            validateConfig({
                ...DEFAULT_CONFIG,
                frontier: {
                    mode: "adaptive",
                    maxEscalationsPerRun: 1,
                    maxDispatchesPerRun: 1,
                    maxHighDispatchesPerRun: 2,
                },
            }),
        ).toThrow("frontier")
        expect(() =>
            validateConfig({
                ...DEFAULT_CONFIG,
                frontier: {
                    mode: "adaptive",
                    maxEscalationsPerRun: 0,
                    maxDispatchesPerRun: 1,
                    maxHighDispatchesPerRun: 0,
                },
            }),
        ).toThrow("frontier")
    })

    it("preserves legacy manifest choices while adding frontier agents", () => {
        const legacy = structuredClone(DEFAULT_MANIFEST)
        delete (legacy.agents as Partial<typeof legacy.agents>)[AGENT_IDS.review.frontierLow]
        delete (legacy.agents as Partial<typeof legacy.agents>)[AGENT_IDS.review.frontierHigh]
        legacy.agents[AGENT_IDS.core.planner].model = "custom/planner"
        legacy.agents[AGENT_IDS.core.planner].steps = 77
        legacy.agents[AGENT_IDS.core.planner].reasoningEffort = "high"

        const migrated = migrateLegacyFrontierManifest(legacy)
        expect(migrated?.agents[AGENT_IDS.core.planner].model).toBe("custom/planner")
        expect(migrated?.agents[AGENT_IDS.core.planner].steps).toBe(77)
        expect(migrated?.agents[AGENT_IDS.core.planner].reasoningEffort).toBe("high")
        expect(migrated?.agents[AGENT_IDS.review.frontierLow].model).toBeTruthy()
        expect(migrated?.agents[AGENT_IDS.review.frontierHigh].model).toBeTruthy()
    })

    it("replays a stuck implementation and promotes one recurrence to high", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-frontier-"))
        const change = "frontier-replay"
        await mkdir(changeRoot(directory, change), { recursive: true })
        await writeFile(path.join(directory, "target.ts"), "export const target = true\n")
        const state = completedPlanningState()
        state.dispatches.push({
            id: "implementation-attempt",
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

        const marker = {
            tier: "low",
            task: "Resolve the target implementation blocker.",
            whyNormalPathIsInsufficient:
                "The first implementation attempt could not preserve the contract.",
            impact: "implementation",
            evidence: [{ kind: "repository-path", path: "target.ts" }],
            attempts: ["Attempted the existing implementation path."],
        }
        const queued = await completeAction(
            directory,
            change,
            "implementation-attempt",
            `Best effort.\n<!-- specops-frontier: ${JSON.stringify(marker)} -->`,
            adaptiveConfig,
        )
        expect(queued.pendingFrontier?.selectedTier).toBe("low")

        const frontier = await issueDirective(directory, change, adaptiveConfig)
        expect(frontier.type).toBe("dispatch")
        if (frontier.type !== "dispatch") throw new Error("expected frontier dispatch")
        expect(frontier.action.agent).toBe(AGENT_IDS.review.frontierLow)

        await completeAction(
            directory,
            change,
            frontier.action.id,
            JSON.stringify({
                disposition: "ADVISE",
                summary: "Use the existing adapter boundary.",
                instruction: "Implement through the existing adapter and preserve its return type.",
                evidence: [],
            }),
            adaptiveConfig,
        )

        const replay = await issueDirective(directory, change, adaptiveConfig)
        expect(replay.type).toBe("dispatch")
        if (replay.type !== "dispatch") throw new Error("expected implementation replay")
        expect(replay.action.capability).toBe("implementation")
        expect(replay.action.prompt).toContain("Implement through the existing adapter")

        const repeated = {
            ...marker,
            attempts: [
                "Attempted the existing implementation path.",
                "Applied Luna advice but the same adapter conflict remained.",
            ],
        }
        const promoted = await completeAction(
            directory,
            change,
            replay.action.id,
            `Second best effort.\n<!-- specops-frontier: ${JSON.stringify(repeated)} -->`,
            adaptiveConfig,
        )
        expect(promoted.pendingFrontier?.selectedTier).toBe("high")

        const high = await issueDirective(directory, change, adaptiveConfig)
        expect(high.type).toBe("dispatch")
        if (high.type !== "dispatch") throw new Error("expected high frontier dispatch")
        expect(high.action.agent).toBe(AGENT_IDS.review.frontierHigh)

        await completeAction(
            directory,
            change,
            high.action.id,
            JSON.stringify({
                disposition: "ADVISE",
                summary: "Use the narrow compatibility shim.",
                instruction:
                    "Implement a compatibility shim without changing the public return type.",
                evidence: [{ kind: "repository-path", path: "target.ts" }],
            }),
            adaptiveConfig,
        )
        const finalReplay = await issueDirective(directory, change, adaptiveConfig)
        if (finalReplay.type !== "dispatch") throw new Error("expected final implementation replay")
        const exhausted = await completeAction(
            directory,
            change,
            finalReplay.action.id,
            `Still blocked.\n<!-- specops-frontier: ${JSON.stringify(repeated)} -->`,
            adaptiveConfig,
        )
        expect(exhausted.status).toBe("blocked")
        expect(exhausted.blockReason).toBe("budget-exhausted")
        expect(exhausted.artifacts.implementation).toBeUndefined()
        const audit = JSON.parse(
            await readFile(
                path.join(changeRoot(directory, change), "specops-frontier.json"),
                "utf8",
            ),
        ) as {
            usage: { dispatches: number; highDispatches: number }
            episodes: Array<{ selectedTier: string }>
        }
        expect(audit.usage).toMatchObject({ dispatches: 2, highDispatches: 1 })
        expect(audit.episodes[0].selectedTier).toBe("high")
    })

    it("adjudicates a failed standard judgment before scheduling repair", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-frontier-review-"))
        const change = "frontier-review"
        await mkdir(changeRoot(directory, change), { recursive: true })
        await writeFile(path.join(directory, "target.ts"), "export const target = true\n")
        const state = completedPlanningState()
        state.dispatches.push({
            id: "correctness",
            action: "correctness-judgment",
            agent: AGENT_IDS.review.correctnessJudge,
            capability: "correctness-judgment",
            purpose: "judgment",
            independent: true,
            inputHash: "input",
            status: "issued",
            at: "now",
        })
        await writeRun(directory, change, state)

        const failed = await completeAction(
            directory,
            change,
            "correctness",
            JSON.stringify({
                verdict: "FAIL",
                summary: "The adapter may return the wrong type.",
                findings: [],
            }),
            adaptiveConfig,
        )
        expect(failed.pendingFrontier?.trigger).toBe("review-blocker")
        expect(failed.pendingRepair).toBeUndefined()

        const frontier = await issueDirective(directory, change, adaptiveConfig)
        if (frontier.type !== "dispatch") throw new Error("expected frontier dispatch")
        const dismissed = await completeAction(
            directory,
            change,
            frontier.action.id,
            JSON.stringify({
                disposition: "DISMISS_BLOCKER",
                summary: "The persisted contract confirms the return type is correct.",
                evidence: [{ kind: "repository-path", path: "target.ts" }],
            }),
            adaptiveConfig,
        )
        expect(dismissed.pendingFrontier).toBeUndefined()
        expect(dismissed.pendingRepair).toBeUndefined()
    })

    it("blocks adaptive escalation when repository evidence cannot be verified", async () => {
        const { directory, change, state } = await persistedFrontierRun("invalid-evidence")
        state.dispatches.push(
            issuedDispatch("implementation-attempt", "implementation", "workflow"),
        )
        await writeRun(directory, change, state)

        const completed = await completeAction(
            directory,
            change,
            "implementation-attempt",
            frontierOutput({
                evidence: [{ kind: "repository-path", path: "../outside.ts" }],
            }),
            adaptiveConfig,
        )

        expect(completed.status).toBe("blocked")
        expect(completed.blockReason).toBe("policy-rejected")
        expect(completed.frontierUsage?.dispatches).toBe(0)
        expect(completed.artifacts.implementation).toBeUndefined()
    })

    it("selects high tier directly only when critical run evidence supports it", async () => {
        const { directory, change, state } = await persistedFrontierRun("critical-high")
        state.riskFacets = ["security"]
        state.dispatches.push(
            issuedDispatch("implementation-attempt", "implementation", "workflow"),
        )
        await writeRun(directory, change, state)

        const queued = await completeAction(
            directory,
            change,
            "implementation-attempt",
            frontierOutput({ tier: "high" }),
            adaptiveConfig,
        )
        expect(queued.pendingFrontier?.selectedTier).toBe("high")
        expect(queued.frontierUsage).toMatchObject({
            escalations: 1,
            dispatches: 0,
            highDispatches: 0,
        })
    })

    it("allows one evidence-bounded low-tier response to promote to high", async () => {
        const { directory, change, state } = await persistedFrontierRun("explicit-promotion")
        state.dispatches.push(
            issuedDispatch("implementation-attempt", "implementation", "workflow"),
        )
        await writeRun(directory, change, state)
        await completeAction(
            directory,
            change,
            "implementation-attempt",
            frontierOutput(),
            adaptiveConfig,
        )
        const low = await issueDirective(directory, change, adaptiveConfig)
        if (low.type !== "dispatch") throw new Error("expected low frontier dispatch")

        const promoted = await completeAction(
            directory,
            change,
            low.action.id,
            JSON.stringify({
                disposition: "PROMOTE",
                summary: "The blocker requires deeper contract reasoning.",
                evidence: [{ kind: "repository-path", path: "target.ts" }],
            }),
            adaptiveConfig,
        )
        expect(promoted.pendingFrontier?.selectedTier).toBe("high")
        expect(promoted.frontierHistory?.[0].status).toBe("promoted")

        const high = await issueDirective(directory, change, adaptiveConfig)
        if (high.type !== "dispatch") throw new Error("expected high frontier dispatch")
        expect(high.action.agent).toBe(AGENT_IDS.review.frontierHigh)
    })

    it("preserves normal routing and consumes no budget when frontier mode is disabled", async () => {
        const { directory, change, state } = await persistedFrontierRun("disabled-frontier")
        state.frontierPolicy = structuredClone(DEFAULT_CONFIG.frontier)
        state.requirements.requiredCapabilities.push("security")
        state.dispatches.push(issuedDispatch("security-consultation", "security", "consultation"))
        await writeRun(directory, change, state)

        const completed = await completeAction(
            directory,
            change,
            "security-consultation",
            frontierOutput({ impact: "design" }),
            DEFAULT_CONFIG,
        )
        expect(completed.pendingFrontier).toBeUndefined()
        expect(completed.frontierHistory).toEqual([])
        expect(completed.frontierUsage).toMatchObject({
            escalations: 0,
            dispatches: 0,
            highDispatches: 0,
        })
        expect(completed.dispatches.at(-1)?.status).toBe("completed")
    })

    it("replays a specialist consultation for its exact purpose exactly once", async () => {
        const { directory, change, state } = await persistedFrontierRun("consultation-replay")
        state.requirements.requiredCapabilities.push("security")
        state.dispatches.push(issuedDispatch("security-consultation", "security", "consultation"))
        await writeRun(directory, change, state)

        await completeAction(
            directory,
            change,
            "security-consultation",
            frontierOutput({ impact: "design" }),
            adaptiveConfig,
        )
        const frontier = await issueDirective(directory, change, adaptiveConfig)
        if (frontier.type !== "dispatch") throw new Error("expected frontier dispatch")
        await completeAction(
            directory,
            change,
            frontier.action.id,
            JSON.stringify({
                disposition: "ADVISE",
                summary: "Preserve the existing authorization boundary.",
                instruction: "Inspect and preserve the current authorization boundary.",
                evidence: [{ kind: "repository-path", path: "target.ts" }],
            }),
            adaptiveConfig,
        )

        const replay = await issueDirective(directory, change, adaptiveConfig)
        if (replay.type !== "dispatch") throw new Error("expected consultation replay")
        expect(replay.action.capability).toBe("security")
        expect(replay.action.purpose).toBe("consultation")
        expect(replay.action.prompt).toContain("current authorization boundary")

        const issuedState = await readRun(directory, change)
        const replayRecord = issuedState.dispatches.find(item => item.id === replay.action.id)
        expect(replayRecord?.frontierResume).toMatchObject({
            capability: "security",
            purpose: "consultation",
            action: "security",
        })

        await completeAction(
            directory,
            change,
            replay.action.id,
            "Consultation complete.",
            adaptiveConfig,
        )
        const following = await issueDirective(directory, change, adaptiveConfig)
        if (following.type !== "dispatch") throw new Error("expected following workflow action")
        expect(following.action.purpose).not.toBe("consultation")
    })

    it("requires bounded evidence-backed blocker adjudication responses", () => {
        expect(() =>
            parseFrontierResponse(
                JSON.stringify({
                    disposition: "DISMISS_BLOCKER",
                    summary: "Dismiss without proof.",
                    evidence: [],
                }),
            ),
        ).toThrow("requires evidence")
        expect(() =>
            parseFrontierResponse(
                JSON.stringify({
                    disposition: "DISMISS_BLOCKER",
                    summary: "Dismiss based only on uncertainty.",
                    evidence: [
                        {
                            kind: "unresolved-unknown",
                            question: "Is the blocker real?",
                            inspectionsPerformed: ["standard review"],
                        },
                    ],
                }),
            ),
        ).toThrow("verifiable evidence")
        expect(() =>
            parseFrontierResponse(
                JSON.stringify({
                    disposition: "ADVISE",
                    summary: "x".repeat(2_001),
                    instruction: "Inspect the adapter.",
                    evidence: [],
                }),
            ),
        ).toThrow("bounded")
        expect(() =>
            parseFrontierResponse(
                JSON.stringify({
                    disposition: "ADVISE",
                    summary: "Bounded summary.",
                    instruction: "x".repeat(4_001),
                    evidence: [],
                }),
            ),
        ).toThrow("bounded")
    })

    it("verifies command-shaped evidence against the persisted command identity", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-frontier-command-"))
        const command = commandEvidence("command-1", 1)
        await expect(
            verifyFrontierEvidence(
                directory,
                [{ kind: "command", commandId: "fabricated", exitCode: 1 }],
                [command],
            ),
        ).resolves.toBe(false)
        await expect(
            verifyFrontierEvidence(
                directory,
                [{ kind: "command", commandId: "command-1", exitCode: 1 }],
                [command],
            ),
        ).resolves.toBe(true)
        await expect(
            verifyFrontierEvidence(
                directory,
                [{ kind: "test-failure", commandId: "command-1", test: "adapter contract" }],
                [command],
            ),
        ).resolves.toBe(true)
    })

    it("falls back safely from malformed frontier output without orphaning state", async () => {
        const { directory, change, state } = await persistedFrontierRun("malformed-response")
        state.dispatches.push(
            issuedDispatch("implementation-attempt", "implementation", "workflow"),
        )
        await writeRun(directory, change, state)
        await completeAction(
            directory,
            change,
            "implementation-attempt",
            frontierOutput(),
            adaptiveConfig,
        )
        const frontier = await issueDirective(directory, change, adaptiveConfig)
        if (frontier.type !== "dispatch") throw new Error("expected frontier dispatch")

        await expect(
            completeAction(directory, change, frontier.action.id, "not json", adaptiveConfig),
        ).rejects.toThrow("not valid JSON")
        const recovered = await readRun(directory, change)
        expect(recovered.pendingFrontier).toBeUndefined()
        expect(recovered.frontierResume?.purpose).toBe("workflow")
        expect(recovered.frontierHistory?.[0].status).toBe("insufficient")
    })

    it("preserves the original review repair when frontier adjudication is malformed", async () => {
        const { directory, change, state } = await persistedFrontierRun("malformed-review")
        state.dispatches.push(issuedDispatch("correctness", "correctness-judgment", "judgment"))
        await writeRun(directory, change, state)
        await completeAction(
            directory,
            change,
            "correctness",
            JSON.stringify({
                verdict: "FAIL",
                summary: "The adapter contract is violated.",
                findings: [],
            }),
            adaptiveConfig,
        )
        const frontier = await issueDirective(directory, change, adaptiveConfig)
        if (frontier.type !== "dispatch") throw new Error("expected frontier dispatch")

        await expect(
            completeAction(directory, change, frontier.action.id, "malformed", adaptiveConfig),
        ).rejects.toThrow("not valid JSON")
        const recovered = await readRun(directory, change)
        expect(recovered.pendingFrontier).toBeUndefined()
        expect(recovered.pendingRepair).toMatchObject({
            mode: "implementation-defect",
            summary: "The adapter contract is violated.",
        })
    })

    it("upholds a review blocker with targeted repair and invalidation", async () => {
        const { directory, change, state } = await persistedFrontierRun("upheld-review")
        state.dispatches.push(issuedDispatch("correctness", "correctness-judgment", "judgment"))
        await writeRun(directory, change, state)
        await completeAction(
            directory,
            change,
            "correctness",
            JSON.stringify({
                verdict: "FAIL",
                summary: "The implementation violates the adapter contract.",
                findings: [],
            }),
            adaptiveConfig,
        )
        const frontier = await issueDirective(directory, change, adaptiveConfig)
        if (frontier.type !== "dispatch") throw new Error("expected frontier dispatch")
        const pending = await readRun(directory, change)
        pending.artifacts.implementation = validArtifact("implementation")
        pending.artifacts.verification = validArtifact("verification")
        await writeRun(directory, change, pending)

        const repaired = await completeAction(
            directory,
            change,
            frontier.action.id,
            JSON.stringify({
                disposition: "UPHOLD_BLOCKER",
                summary: "The adapter return type is incorrect.",
                instruction: "Restore the documented adapter return type.",
                repairMode: "implementation-defect",
                evidence: [{ kind: "repository-path", path: "target.ts" }],
            }),
            adaptiveConfig,
        )
        expect(repaired.pendingRepair).toMatchObject({
            mode: "implementation-defect",
            instruction: "Restore the documented adapter return type.",
        })
        expect(repaired.artifacts.implementation?.validity).toBe("stale")
        expect(repaired.artifacts.verification?.validity).toBe("stale")
    })

    it("clears pending frontier and replay state when a run is cancelled", async () => {
        const { directory, change, state } = await persistedFrontierRun("cancel-frontier")
        state.pendingFrontier = {
            episodeId: "episode",
            request: frontierMarker(),
            trigger: "worker-request",
            fingerprint: "fingerprint",
            phase: "implementation",
            capability: "implementation",
            purpose: "workflow",
            action: "implementation",
            originalDispatchId: "origin",
            selectedTier: "low",
        }
        state.frontierResume = {
            episodeId: "episode",
            originalDispatchId: "origin",
            phase: "implementation",
            capability: "implementation",
            purpose: "workflow",
            action: "implementation",
            advice: "Advice.",
            adviceHash: "hash",
        }
        await writeRun(directory, change, state)

        const cancelled = await cancelRun(directory, change, "User cancelled.")
        expect(cancelled.pendingFrontier).toBeUndefined()
        expect(cancelled.frontierResume).toBeUndefined()
        expect(cancelled.status).toBe("cancelled")
    })

    it("loads pre-frontier version-2 state with safe disabled defaults", async () => {
        const { directory, change, state } = await persistedFrontierRun("legacy-state")
        state.frontierPolicy = undefined
        state.frontierUsage = undefined
        state.frontierHistory = undefined
        await writeRun(directory, change, state)

        const loaded = await readRun(directory, change)
        expect(loaded.frontierPolicy).toEqual(DEFAULT_CONFIG.frontier)
        expect(loaded.frontierUsage).toEqual({
            escalations: 0,
            dispatches: 0,
            highDispatches: 0,
        })
        expect(loaded.frontierHistory).toEqual([])
    })
})

function completedPlanningState(): RunState {
    const requirements = requirementsFor(assessment, "auto", adaptiveConfig).requirements
    const state: RunState = {
        version: 2,
        mode: "automatic",
        goal: "test frontier replay",
        baseline: "abc",
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
        frontierPolicy: structuredClone(adaptiveConfig.frontier),
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
    for (const artifact of ["routing", "exploration", "proposal", "tasks"] as ArtifactId[]) {
        state.artifacts[artifact] = {
            artifact,
            producer: "test",
            purpose: "workflow",
            generatedAt: "now",
            inputHashes: {},
            outputHash: artifact,
            scopeTier: "lean",
            capabilities: requirements.requiredCapabilities,
            validity: "valid",
        }
    }
    return state
}

async function persistedFrontierRun(
    change: string,
): Promise<{ directory: string; change: string; state: RunState }> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "specops-frontier-case-"))
    await mkdir(changeRoot(directory, change), { recursive: true })
    await writeFile(path.join(directory, "target.ts"), "export const target = true\n")
    return { directory, change, state: completedPlanningState() }
}

function issuedDispatch(
    id: string,
    capability: CapabilityId,
    purpose: DispatchPurpose,
): DispatchRecord {
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

function frontierMarker(overrides: Partial<FrontierRequest> = {}): FrontierRequest {
    return {
        tier: "low",
        task: "Resolve the target implementation blocker.",
        whyNormalPathIsInsufficient:
            "The attempted implementation could not preserve the existing contract.",
        impact: "implementation",
        evidence: [{ kind: "repository-path", path: "target.ts" }],
        attempts: ["Inspected and attempted the existing implementation path."],
        ...overrides,
    }
}

function frontierOutput(overrides: Partial<FrontierRequest> = {}): string {
    return `Best effort.\n<!-- specops-frontier: ${JSON.stringify(frontierMarker(overrides))} -->`
}

function validArtifact(artifact: ArtifactId): NonNullable<RunState["artifacts"][ArtifactId]> {
    return {
        artifact,
        producer: "test",
        purpose: "workflow",
        generatedAt: "now",
        inputHashes: {},
        outputHash: artifact,
        scopeTier: "lean",
        capabilities: [],
        validity: "valid",
    }
}

function commandEvidence(id: string, exitCode: number): CommandEvidence {
    return {
        id,
        executable: "test",
        args: [],
        cwd: ".",
        startedAt: "now",
        finishedAt: "now",
        exitCode,
        stdoutHash: "stdout",
        stderrHash: "stderr",
        stdoutExcerpt: "",
        stderrExcerpt: "",
        validationId: "validation",
        dispatchId: "dispatch",
    }
}

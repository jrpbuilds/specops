import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { AGENT_IDS } from "../src/agents/ids.js"
import {
    startOrResumePlanning,
    type CoordinatorOpenSpecAdapter,
    type CoordinatorOptions,
} from "../src/workflow/coordinator.js"
import { planningOverview, resolvePlanningCheckpoint } from "../src/workflow/planning-checkpoint.js"
import {
    revalidatePlanningArtifact,
    retryPlanningArtifact,
    type PlanningAgentRequest,
} from "../src/workflow/planning.js"
import {
    isPlanningMaterialQuestion,
    routePlanningWorkerQuestion,
} from "../src/workflow/planning-questions.js"
import { explorationPath } from "../src/state/paths.js"
import { createV1Run, readV1Run, updateV1Run } from "../src/state/store.js"
import type { OpenSpecChangeStatus } from "../src/openspec/status.js"
import type { OpenSpecValidationResult } from "../src/openspec/validation.js"
import { OpenSpecOperationalError } from "../src/openspec/errors.js"
import type { ValidationCommand, ValidationRecommendation } from "../src/validation/registry.js"

const identity = "a".repeat(64)
const change = "planning-test"
const artifacts = ["proposal", "specs", "design", "tasks"] as const

async function directory(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "specops-planning-"))
}

function validation(valid: boolean, issues: unknown[] = []): OpenSpecValidationResult {
    return { valid, issues, raw: { items: [{ valid, issues }] } }
}

class FakeAdapter implements CoordinatorOpenSpecAdapter {
    created = false
    completed = new Set<string>()
    validations: OpenSpecValidationResult[]
    instructionsRequested: string[] = []
    statusCalls: string[] = []

    constructor(validations: OpenSpecValidationResult[] = []) {
        this.validations = validations
    }

    async version(): Promise<string> {
        return "1.7.0"
    }

    async assertStandardSchema(): Promise<string> {
        return "spec-driven"
    }

    async createChange(): Promise<void> {
        this.created = true
    }

    async status(requestedChange: string): Promise<OpenSpecChangeStatus> {
        this.statusCalls.push(requestedChange)
        if (!this.created) throw new Error("change not found")
        return {
            changeName: requestedChange,
            schemaName: "spec-driven",
            changeRoot: `/project/openspec/changes/${requestedChange}`,
            isComplete: artifacts.every(artifact => this.completed.has(artifact)),
            artifacts: artifacts.map(artifact => ({
                id: artifact,
                outputPath: artifact === "specs" ? "specs/**/*.md" : `${artifact}.md`,
                status: this.completed.has(artifact) ? "done" : "ready",
                requires: [],
            })),
            artifactPaths: Object.fromEntries(
                artifacts.map(artifact => [
                    artifact,
                    {
                        outputPath: artifact === "specs" ? "specs/**/*.md" : `${artifact}.md`,
                        resolvedOutputPath: `/project/openspec/changes/${requestedChange}/${artifact}.md`,
                        existingOutputPaths: [],
                    },
                ]),
            ),
        }
    }

    async instructions(artifact: string, requestedChange: string) {
        this.instructionsRequested.push(artifact)
        return {
            artifactId: artifact,
            schemaName: "spec-driven",
            outputPath: `${artifact}.md`,
            resolvedOutputPath: `/project/openspec/changes/${requestedChange}/${artifact}.md`,
            description: `${artifact} instructions`,
            instruction: `OpenSpec instructions for ${artifact}`,
            template: "",
            dependencies: [],
        }
    }

    async validate(): Promise<OpenSpecValidationResult> {
        return this.validations.shift() ?? validation(true)
    }
}

async function options(
    root: string,
    adapter = new FakeAdapter(),
): Promise<CoordinatorOptions & { adapter: FakeAdapter; requests: PlanningAgentRequest[] }> {
    const requests: PlanningAgentRequest[] = []
    return {
        directory: root,
        adapter,
        captureBaseline: async () => ({ identity, changedFiles: [] }),
        explorer: {
            run: async () => {
                await mkdir(path.dirname(explorationPath(root, change)), { recursive: true })
                await writeFile(explorationPath(root, change), "# Exploration\n")
            },
        },
        planners: {
            run: async request => {
                requests.push(request)
                adapter.completed.add(request.artifact)
            },
        },
        requests,
    }
}

describe("V1 planning workflow", () => {
    it("creates a run, captures a baseline, explores, queries readiness, and authors every artifact in order", async () => {
        const root = await directory()
        const context = await options(root)

        const result = await startOrResumePlanning(context, { change, goal: "Plan the feature" })

        expect(result).toMatchObject({ kind: "checkpoint", resumed: false })
        expect(context.adapter.created).toBe(true)
        expect(context.requests.map(request => request.artifact)).toEqual(artifacts)
        expect(
            context.requests.every(request =>
                request.instructions.instruction.startsWith("OpenSpec"),
            ),
        ).toBe(true)
        await expect(readV1Run(root, change)).resolves.toMatchObject({
            baselineRepositoryState: identity,
            status: "awaiting-user",
            stage: "implementation",
        })
        await expect(readFile(explorationPath(root, change), "utf8")).resolves.toContain(
            "Exploration",
        )
    })

    it("passes valid artifacts on their first attempt", async () => {
        const context = await options(await directory())
        await startOrResumePlanning(context, { change, goal: "Plan the feature" })
        expect(context.requests.every(request => request.kind === "initial")).toBe(true)
    })

    it("does not request an artifact before OpenSpec marks it ready", async () => {
        const adapter = new FakeAdapter()
        const status = adapter.status.bind(adapter)
        adapter.status = async requestedChange => {
            const current = await status(requestedChange)
            return {
                ...current,
                artifacts: current.artifacts.map(artifact =>
                    artifact.id === "proposal" ? { ...artifact, status: "blocked" } : artifact,
                ),
            }
        }
        const context = await options(await directory(), adapter)
        await expect(
            startOrResumePlanning(context, { change, goal: "Plan the feature" }),
        ).rejects.toThrow("does not report proposal as ready")
        expect(context.requests).toEqual([])
    })

    it("returns exact OpenSpec errors to the owning agent and succeeds after correction", async () => {
        const issue = { path: "proposal.md", message: "missing Why" }
        const context = await options(
            await directory(),
            new FakeAdapter([validation(false, [issue]), validation(true)]),
        )
        await startOrResumePlanning(context, { change, goal: "Plan the feature" })
        const proposalRequests = context.requests.filter(request => request.artifact === "proposal")
        expect(proposalRequests).toHaveLength(2)
        expect(proposalRequests[1]).toMatchObject({
            agent: AGENT_IDS.planner,
            kind: "correction",
            correctionAttempt: 1,
            validationErrors: [issue],
        })
    })

    it("pauses after the initial attempt and two failed corrections", async () => {
        const context = await options(
            await directory(),
            new FakeAdapter([
                validation(false, ["first"]),
                validation(false, ["second"]),
                validation(false, ["third"]),
            ]),
        )
        const result = await startOrResumePlanning(context, { change, goal: "Plan the feature" })
        expect(result).toMatchObject({ kind: "correction-exhausted", artifact: "proposal" })
        expect(context.requests.filter(request => request.artifact === "proposal")).toHaveLength(3)
        await expect(readV1Run(context.directory, change)).resolves.toMatchObject({
            status: "awaiting-user",
            stage: "proposal",
            artifactCorrectionAttempts: { proposal: 2 },
        })
    })

    it("persists an OpenSpec operational failure instead of requesting a correction", async () => {
        const adapter = new FakeAdapter()
        const validate = adapter.validate.bind(adapter)
        adapter.validate = async () => {
            await validate()
            throw new OpenSpecOperationalError("OpenSpec unavailable")
        }
        const context = await options(await directory(), adapter)
        await expect(
            startOrResumePlanning(context, { change, goal: "Plan the feature" }),
        ).rejects.toThrow("OpenSpec unavailable")
        expect(context.requests).toHaveLength(1)
        await expect(readV1Run(context.directory, change)).resolves.toMatchObject({
            status: "failed",
            failure: { kind: "operational", message: "OpenSpec unavailable" },
        })
    })

    it("revalidates a manual edit without dispatching an artifact writer", async () => {
        const adapter = new FakeAdapter([
            validation(false),
            validation(false),
            validation(false),
            validation(true),
        ])
        const context = await options(await directory(), adapter)
        const exhausted = await startOrResumePlanning(context, { change, goal: "Plan the feature" })
        if (exhausted.kind !== "correction-exhausted") throw new Error("expected correction pause")
        const calls = context.requests.length
        await revalidatePlanningArtifact(
            { directory: context.directory, adapter, agents: context.planners },
            exhausted.state,
        )
        expect(context.requests.length).toBeGreaterThan(calls)
        expect(context.requests[calls].artifact).toBe("specs")
    })

    it("retries with a selected replacement model after correction exhaustion", async () => {
        const adapter = new FakeAdapter([
            validation(false),
            validation(false),
            validation(false),
            validation(true),
        ])
        const context = await options(await directory(), adapter)
        const exhausted = await startOrResumePlanning(context, { change, goal: "Plan the feature" })
        if (exhausted.kind !== "correction-exhausted") throw new Error("expected correction pause")
        await retryPlanningArtifact(
            { directory: context.directory, adapter, agents: context.planners },
            exhausted.state,
            "replacement-model",
        )
        expect(context.requests[3]).toMatchObject({
            artifact: "proposal",
            model: "replacement-model",
        })
    })

    it("permits only material worker questions at the coordinator boundary", () => {
        const material = {
            prompt: "Choose data retention policy",
            outcomes: ["keep", "delete"],
            repositoryResolvable: false,
            affectsMaterialOutcome: true,
            reversibleLowRiskAssumptionAvailable: false,
        }
        expect(isPlanningMaterialQuestion(material)).toBe(true)
        expect(routePlanningWorkerQuestion(material)).toMatchObject({ kind: "ask" })
        expect(routePlanningWorkerQuestion({ ...material, repositoryResolvable: true })).toEqual({
            kind: "continue",
        })
    })

    it("presents a planning-only overview and continues only after the single checkpoint", async () => {
        const context = await options(await directory())
        const checkpoint = await startOrResumePlanning(context, {
            change,
            goal: "Plan the feature",
        })
        if (checkpoint.kind !== "checkpoint") throw new Error("expected checkpoint")
        expect(planningOverview(checkpoint.state)).toEqual({
            change,
            goal: "Plan the feature",
            artifacts,
        })
        const continued = await resolvePlanningCheckpoint(
            { directory: context.directory, adapter: context.adapter, agents: context.planners },
            checkpoint.state,
            { kind: "continue" },
        )
        expect(continued).toMatchObject({ kind: "continued", state: { stage: "implementation" } })
    })

    it("persists only explicitly accepted explorer validation recommendations at the planning checkpoint", async () => {
        const configured: ValidationCommand = {
            id: "typecheck",
            executable: "node",
            args: ["--version"],
            timeoutMs: 1_000,
            maxOutputBytes: 1_024,
        }
        const recommended: ValidationRecommendation = {
            ...configured,
            id: "test",
            source: "explorer",
        }
        const context = await options(await directory())
        const checkpoint = await startOrResumePlanning(context, {
            change,
            goal: "Plan the feature",
        })
        if (checkpoint.kind !== "checkpoint") throw new Error("expected checkpoint")

        const continued = await resolvePlanningCheckpoint(
            {
                directory: context.directory,
                adapter: context.adapter,
                agents: context.planners,
                validationCommands: [configured],
                validationRecommendations: [recommended],
            },
            checkpoint.state,
            { kind: "continue", acceptedRecommendationIds: [recommended.id] },
        )

        expect(continued).toMatchObject({
            kind: "continued",
            commands: { required: [configured, recommended] },
            state: { acceptedValidationRecommendationIds: [recommended.id] },
        })
    })

    it("routes feedback to each selected owner, revalidates, and re-presents the checkpoint", async () => {
        for (const artifact of artifacts) {
            const context = await options(await directory())
            const checkpoint = await startOrResumePlanning(context, {
                change,
                goal: "Plan the feature",
            })
            if (checkpoint.kind !== "checkpoint") throw new Error("expected checkpoint")
            const result = await resolvePlanningCheckpoint(
                {
                    directory: context.directory,
                    adapter: context.adapter,
                    agents: context.planners,
                },
                checkpoint.state,
                { kind: "request-changes", feedback: { [artifact]: `revise ${artifact}` } },
            )
            expect(result).toMatchObject({ kind: "checkpoint" })
            expect(context.requests.at(-1)).toMatchObject({
                artifact,
                kind: "feedback",
                agent: artifact === "design" ? AGENT_IDS.designer : AGENT_IDS.planner,
            })
        }
    })

    it("cancels from the planning checkpoint without deleting work", async () => {
        const context = await options(await directory())
        const checkpoint = await startOrResumePlanning(context, {
            change,
            goal: "Plan the feature",
        })
        if (checkpoint.kind !== "checkpoint") throw new Error("expected checkpoint")
        const cancelled = await resolvePlanningCheckpoint(
            { directory: context.directory, adapter: context.adapter, agents: context.planners },
            checkpoint.state,
            { kind: "cancel" },
        )
        expect(cancelled).toMatchObject({ kind: "cancelled", state: { status: "cancelled" } })
    })

    it("resumes from each persisted planning boundary without replaying earlier stages", async () => {
        for (const stage of ["exploration", ...artifacts] as const) {
            const root = await directory()
            const adapter = new FakeAdapter()
            adapter.created = true
            if (stage !== "exploration") {
                for (const completed of artifacts.slice(0, artifacts.indexOf(stage))) {
                    adapter.completed.add(completed)
                }
            }
            const context = await options(root, adapter)
            context.recover = async (_directory, resumedChange) => ({
                state: await readV1Run(root, resumedChange),
            })
            await createV1Run(root, {
                change,
                goal: "Plan the feature",
                baselineRepositoryState: identity,
            })
            if (stage !== "exploration") {
                await updateV1Run(root, change, state => ({ ...state, stage }))
            }
            const result = await startOrResumePlanning(context, {
                change,
                goal: "ignored on resume",
            })
            expect(result.resumed).toBe(true)
            expect(context.requests[0]?.artifact).toBe(stage === "exploration" ? "proposal" : stage)
        }
    })
})

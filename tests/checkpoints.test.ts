import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { AGENT_IDS } from "../src/capabilities/ids.js"
import { DEFAULT_CONFIG } from "../src/config.js"
import { changeRoot, readRun, writeRun } from "../src/state/store.js"
import type {
    ArtifactId,
    Assessment,
    CheckpointArtifactSnapshot,
    DispatchRecord,
    RunState,
} from "../src/types.js"
import {
    cancelRun,
    completeAction,
    finalizeRun,
    issueDirective,
    resumeCheckpointAction,
} from "../src/workflow/engine.js"
import {
    checkpointArtifactsFor,
    computeCheckpointBindingHash,
    hasCheckpointFor,
    isCheckpointBindingCurrent,
    nextAction,
    nextDirective,
    snapshotCheckpointArtifacts,
} from "../src/workflow/scheduler.js"
import {
    invalidationForCheckpoint,
    pendingCheckpointBlockView,
    resumePromptForCheckpoint,
} from "../src/workflow/questions.js"

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

function leanState(mode: RunState["mode"]): RunState {
    const requirements = {
        scopeTier: "lean" as const,
        requiredArtifacts: [
            "routing",
            "exploration",
            "tasks",
            "implementation",
            "verification",
            "correctness-judgment",
            "review-ledger",
            "receipt",
        ] as ArtifactId[],
        requiredCapabilities: ["assessment", "planning", "implementation", "verification"] as never,
        requiredReviewFacets: [],
        requiredValidations: [
            { id: "openspec-strict", kind: "openspec-strict" as const },
            { id: "traceability", kind: "traceability" as const },
        ],
        judgePolicy: { required: ["correctness"] as ["correctness"] },
        refuterPolicy: { mode: "conditional" as const, triggers: ["findings"] as ["findings"] },
        budgets: { ...DEFAULT_CONFIG.escalation.budgets },
        policyHash: "policy",
    }
    return {
        version: 4,
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

function validArtifact(state: RunState, artifact: ArtifactId, hash: string = artifact) {
    return {
        artifact,
        producer: "test",
        purpose: "workflow" as const,
        generatedAt: "now",
        inputHashes: {},
        outputHash: hash,
        scopeTier: state.scopeTier,
        capabilities: state.requirements.requiredCapabilities,
        validity: "valid" as const,
    }
}

function planningDispatch(): DispatchRecord {
    return {
        id: "planning",
        action: "lean-plan",
        agent: AGENT_IDS.core.planner,
        capability: "planning" as never,
        purpose: "workflow",
        independent: false,
        inputHash: "input",
        status: "issued",
        at: "now",
    }
}

function verificationDispatch(): DispatchRecord {
    return {
        id: "verification",
        action: "verification",
        agent: AGENT_IDS.core.verifier,
        capability: "verification" as never,
        purpose: "workflow",
        independent: false,
        inputHash: "input",
        status: "completed",
        at: "now",
    }
}

const tmpDirectories: string[] = []

async function initializedRepository(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "specops-checkpoint-"))
    tmpDirectories.push(directory)
    await writeFile(path.join(directory, "README.md"), "# Test\n")
    return directory
}

afterEach(async () => {
    for (const dir of tmpDirectories.splice(0)) {
        try {
            await import("node:fs/promises").then(fs =>
                fs.rm(dir, { recursive: true, force: true }),
            )
        } catch {
            // ignore cleanup errors
        }
    }
})

function snapshot(artifact: ArtifactId, hash: string = artifact): CheckpointArtifactSnapshot {
    return { artifact, outputHash: hash }
}

describe("checkpoint artifact groups", () => {
    it("identifies lean planning as a tasks-only checkpoint", () => {
        const state = leanState("interactive")
        const action = {
            id: "d1",
            capability: "planning" as const,
            agent: AGENT_IDS.core.planner,
            purpose: "workflow" as const,
            independent: false,
            mode: "lean-plan",
            prompt: "",
        }
        state.artifacts.tasks = validArtifact(state, "tasks")
        expect(checkpointArtifactsFor(state, action)).toEqual(["tasks"])
    })

    it("identifies standard planning as a proposal+tasks checkpoint bundle", () => {
        const state = leanState("interactive")
        const action = {
            id: "d1",
            capability: "planning" as const,
            agent: AGENT_IDS.core.planner,
            purpose: "workflow" as const,
            independent: false,
            mode: "standard-bundle",
            prompt: "",
        }
        state.artifacts.proposal = validArtifact(state, "proposal")
        state.artifacts.tasks = validArtifact(state, "tasks")
        expect(checkpointArtifactsFor(state, action)).toEqual(["proposal", "tasks"])
    })

    it("identifies implementation and verification checkpoints", () => {
        const state = leanState("interactive")
        const implAction = {
            id: "d1",
            capability: "implementation" as const,
            agent: AGENT_IDS.core.implementer,
            purpose: "workflow" as const,
            independent: false,
            prompt: "",
        }
        state.artifacts.implementation = validArtifact(state, "implementation")
        expect(checkpointArtifactsFor(state, implAction)).toEqual(["implementation"])

        const verAction = {
            id: "d2",
            capability: "verification" as const,
            agent: AGENT_IDS.core.verifier,
            purpose: "workflow" as const,
            independent: false,
            mode: "lean-assurance-bundle",
            prompt: "",
        }
        state.artifacts.verification = validArtifact(state, "verification")
        expect(checkpointArtifactsFor(state, verAction)).toEqual(["verification"])
    })

    it("excludes repair dispatches even when they share a capability/mode", () => {
        const state = leanState("interactive")
        const repairAction = {
            id: "d1",
            capability: "planning" as const,
            agent: AGENT_IDS.core.planner,
            purpose: "repair" as const,
            independent: false,
            mode: "lean-plan",
            prompt: "",
        }
        state.artifacts.tasks = validArtifact(state, "tasks")
        expect(checkpointArtifactsFor(state, repairAction)).toEqual([])

        const designRepair = {
            id: "d2",
            capability: "design" as const,
            agent: AGENT_IDS.core.designer,
            purpose: "repair" as const,
            independent: false,
            mode: "artifact-repair",
            prompt: "",
        }
        state.artifacts.design = validArtifact(state, "design")
        expect(checkpointArtifactsFor(state, designRepair)).toEqual([])
    })

    it("returns an empty array for non-checkpoint dispatches", () => {
        const state = leanState("interactive")
        const consultation = {
            id: "d1",
            capability: "security" as const,
            agent: AGENT_IDS.specialist.security,
            purpose: "consultation" as const,
            independent: false,
            prompt: "",
        }
        expect(checkpointArtifactsFor(state, consultation)).toEqual([])

        const review = {
            id: "d2",
            capability: "general-risk" as const,
            agent: AGENT_IDS.review.risk,
            purpose: "independent-review" as const,
            independent: true,
            prompt: "",
        }
        expect(checkpointArtifactsFor(state, review)).toEqual([])
    })
})

describe("checkpoint binding and duplicate detection", () => {
    it("produces a stable binding hash from the dispatch input and artifact snapshots", () => {
        const state = leanState("interactive")
        const dispatch = planningDispatch()
        state.dispatches.push(dispatch)
        state.artifacts.tasks = validArtifact(state, "tasks", "hash-1")
        const snap = snapshotCheckpointArtifacts(state, ["tasks"])
        const first = computeCheckpointBindingHash(state, dispatch, snap)
        state.artifacts.tasks = validArtifact(state, "tasks", "hash-2")
        const snap2 = snapshotCheckpointArtifacts(state, ["tasks"])
        const second = computeCheckpointBindingHash(state, dispatch, snap2)
        expect(first).not.toBe(second)
    })

    it("records a checkpoint only once for a given dispatch and output snapshot", () => {
        const state = leanState("interactive")
        const dispatch = planningDispatch()
        state.dispatches.push(dispatch)
        state.artifacts.tasks = validArtifact(state, "tasks", "hash-1")
        const snap = snapshotCheckpointArtifacts(state, ["tasks"])
        expect(hasCheckpointFor(state, dispatch.id, snap)).toBe(false)
        state.checkpointHistory!.push({
            dispatchId: dispatch.id,
            capability: "planning" as never,
            purpose: "workflow",
            action: "lean-plan",
            artifacts: snap,
            policyHash: state.requirements.policyHash,
            implementationDiffHash: state.implementationDiffHash,
            bindingHash: computeCheckpointBindingHash(state, dispatch, snap),
            raisedAt: "now",
            resolvedAt: "now",
            outcome: "continued",
            invalidatedArtifacts: [],
        })
        expect(hasCheckpointFor(state, dispatch.id, snap)).toBe(true)
    })

    it("allows a new checkpoint when the output hash differs", () => {
        const state = leanState("interactive")
        const dispatch = planningDispatch()
        state.dispatches.push(dispatch)
        state.artifacts.tasks = validArtifact(state, "tasks", "hash-1")
        const snap1 = snapshotCheckpointArtifacts(state, ["tasks"])
        state.checkpointHistory!.push({
            dispatchId: dispatch.id,
            capability: "planning" as never,
            purpose: "workflow",
            action: "lean-plan",
            artifacts: snap1,
            policyHash: state.requirements.policyHash,
            implementationDiffHash: state.implementationDiffHash,
            bindingHash: computeCheckpointBindingHash(state, dispatch, snap1),
            raisedAt: "now",
            resolvedAt: "now",
            outcome: "continued",
            invalidatedArtifacts: [],
        })
        state.artifacts.tasks = validArtifact(state, "tasks", "hash-2")
        const snap2 = snapshotCheckpointArtifacts(state, ["tasks"])
        expect(hasCheckpointFor(state, dispatch.id, snap2)).toBe(false)
    })
})

describe("interactive mode queuing", () => {
    it("queues a checkpoint after a successful interactive dispatch", async () => {
        const directory = await initializedRepository()
        const change = "ckpt-1"
        await mkdir(changeRoot(directory, change), { recursive: true })

        const state = leanState("interactive")
        state.dispatches.push(planningDispatch())
        await writeRun(directory, change, state)

        const after = await completeAction(
            directory,
            change,
            "planning",
            "# Tasks\n\n- Do work.",
            DEFAULT_CONFIG,
        )
        expect(after.status).toBe("paused")
        expect(after.pauseReason).toBe("checkpoint")
        expect(after.resumable).toBe(true)
        expect(after.pendingCheckpoint).toBeDefined()
        expect(after.pendingCheckpoint?.artifacts.map(s => s.artifact)).toEqual(["tasks"])
    })

    it("never queues a checkpoint in automatic mode", async () => {
        const directory = await initializedRepository()
        const change = "ckpt-2"
        await mkdir(changeRoot(directory, change), { recursive: true })

        const state = leanState("automatic")
        state.dispatches.push(planningDispatch())
        await writeRun(directory, change, state)

        const after = await completeAction(
            directory,
            change,
            "planning",
            "# Tasks\n\n- Do work.",
            DEFAULT_CONFIG,
        )
        expect(after.status).toBe("running")
        expect(after.pendingCheckpoint).toBeUndefined()
    })

    it("returns a checkpoint directive from nextDirective when paused", async () => {
        const directory = await initializedRepository()
        const change = "ckpt-3"
        await mkdir(changeRoot(directory, change), { recursive: true })

        const state = leanState("interactive")
        state.dispatches.push(planningDispatch())
        await writeRun(directory, change, state)
        await completeAction(directory, change, "planning", "# Tasks", DEFAULT_CONFIG)

        const directive = await issueDirective(directory, change, DEFAULT_CONFIG)
        expect(directive.type).toBe("checkpoint")
        if (directive.type !== "checkpoint") return
        expect(directive.checkpoint.artifacts.map(s => s.artifact)).toEqual(["tasks"])
        expect(directive.questionTool).toBeDefined()
        expect(directive.questionTool.question).toBeTruthy()
        expect(directive.questionTool.header).toBeTruthy()
        expect(directive.questionTool.header.length).toBeLessThanOrEqual(30)
        expect(directive.questionTool.options).toHaveLength(2)
        expect(directive.questionTool.options[0].label).toBe("Continue")
        expect(directive.questionTool.custom).toBe(true)
    })

    it("does not queue a duplicate checkpoint for the same dispatch and outputs", async () => {
        const directory = await initializedRepository()
        const change = "ckpt-4"
        await mkdir(changeRoot(directory, change), { recursive: true })

        const state = leanState("interactive")
        state.dispatches.push(planningDispatch())
        await writeRun(directory, change, state)

        const first = await completeAction(directory, change, "planning", "# Tasks", DEFAULT_CONFIG)
        expect(first.pendingCheckpoint).toBeDefined()

        // Manually record the checkpoint in history and clear the pause.
        const pending = first.pendingCheckpoint!
        first.checkpointHistory!.push({
            dispatchId: pending.dispatchId,
            capability: pending.capability,
            purpose: pending.purpose,
            action: pending.action,
            artifacts: pending.artifacts,
            policyHash: pending.policyHash,
            implementationDiffHash: pending.implementationDiffHash,
            bindingHash: pending.bindingHash,
            raisedAt: pending.raisedAt,
            resolvedAt: "now",
            outcome: "continued",
            invalidatedArtifacts: [],
        })
        first.pendingCheckpoint = undefined
        first.status = "running"
        first.pauseReason = undefined
        first.resumable = undefined
        await writeRun(directory, change, first)

        const persisted = await readRun(directory, change)
        const snap = snapshotCheckpointArtifacts(persisted, ["tasks"])
        expect(hasCheckpointFor(persisted, "planning", snap)).toBe(true)
    })
})

describe("checkpoint resume", () => {
    it("routes explicit implementation-fix feedback directly to the implementer", async () => {
        const directory = await initializedRepository()
        const change = "resume-implementation-fixes"
        await mkdir(changeRoot(directory, change), { recursive: true })

        const state = leanState("interactive")
        const dispatch = verificationDispatch()
        state.dispatches.push(dispatch)
        state.artifacts.implementation = validArtifact(state, "implementation")
        state.artifacts.verification = validArtifact(state, "verification")
        const artifacts = snapshotCheckpointArtifacts(state, ["verification"])
        state.pendingCheckpoint = {
            dispatchId: dispatch.id,
            capability: dispatch.capability,
            purpose: dispatch.purpose,
            action: dispatch.action,
            artifacts,
            policyHash: state.requirements.policyHash,
            implementationDiffHash: state.implementationDiffHash,
            bindingHash: computeCheckpointBindingHash(state, dispatch, artifacts),
            raisedAt: "now",
        }
        state.status = "paused"
        state.pauseReason = "checkpoint"
        state.resumable = true
        await writeRun(directory, change, state)

        await resumeCheckpointAction(
            directory,
            change,
            "Fix the five verification findings in the working tree.",
            DEFAULT_CONFIG,
            "apply-implementation-fixes",
        )

        const directive = await issueDirective(directory, change, DEFAULT_CONFIG)
        expect(directive.type).toBe("dispatch")
        if (directive.type !== "dispatch") return
        expect(directive.action.capability).toBe("implementation")
        expect(directive.action.purpose).toBe("workflow")
        expect(directive.action.prompt).toContain("Fix the five verification findings")

        const persisted = await readRun(directory, change)
        expect(persisted.resumeTarget?.consumed).toBe(true)
        expect(persisted.checkpointHistory.at(-1)?.resolution).toBe("apply-implementation-fixes")
    })

    it("blocks a consultation-only cycle instead of dispatching indefinitely", () => {
        const state = leanState("interactive")
        state.requirements.requiredCapabilities.push(
            "public-contract" as never,
            "maintainability" as never,
            "usability" as never,
        )
        for (let index = 0; index < 12; index += 1) {
            const capability = (["public-contract", "maintainability", "usability"] as const)[
                index % 3
            ]
            state.dispatches.push({
                id: `consultation-${index}`,
                action: capability,
                agent:
                    capability === "public-contract"
                        ? AGENT_IDS.specialist.contract
                        : capability === "maintainability"
                          ? AGENT_IDS.specialist.maintainability
                          : AGENT_IDS.specialist.usability,
                capability,
                purpose: "consultation",
                independent: false,
                inputHash: `input-${index}`,
                status: "completed",
                at: "now",
            })
        }

        const directive = nextDirective(state)
        expect(directive).toEqual({
            type: "block",
            reason: "workflow-stalled",
            resumable: false,
        })
    })

    it("continues without invalidating anything when no feedback is provided", async () => {
        const directory = await initializedRepository()
        const change = "resume-1"
        await mkdir(changeRoot(directory, change), { recursive: true })

        const state = leanState("interactive")
        state.dispatches.push(planningDispatch())
        await writeRun(directory, change, state)
        await completeAction(directory, change, "planning", "# Tasks", DEFAULT_CONFIG)

        const resumed = await resumeCheckpointAction(directory, change, undefined, DEFAULT_CONFIG)
        expect(resumed.status).toBe("running")
        expect(resumed.pendingCheckpoint).toBeUndefined()
        expect(resumed.checkpointHistory).toHaveLength(1)
        expect(resumed.checkpointHistory![0].outcome).toBe("continued")
        expect(resumed.checkpointHistory![0].feedbackHash).toBeUndefined()
        expect(resumed.checkpointHistory![0].invalidatedArtifacts).toEqual([])
    })

    it("invalidates the checkpoint artifact group and downstream closure on feedback", async () => {
        const directory = await initializedRepository()
        const change = "resume-2"
        await mkdir(changeRoot(directory, change), { recursive: true })

        const state = leanState("interactive")
        state.dispatches.push(planningDispatch())
        await writeRun(directory, change, state)
        await completeAction(directory, change, "planning", "# Tasks", DEFAULT_CONFIG)

        const resumed = await resumeCheckpointAction(
            directory,
            change,
            "Add an acceptance test for the existing behavior.",
            DEFAULT_CONFIG,
        )
        expect(resumed.status).toBe("running")
        expect(resumed.resumeTarget).toBeDefined()
        expect(resumed.resumeTarget!.origin).toBe("checkpoint")
        expect(resumed.resumeTarget!.answerHash).toBeDefined()
        expect(resumed.resumeTarget!.purpose).toBe("workflow")
        expect(resumed.resumeTarget!.action).toBe("lean-plan")
        const record = resumed.checkpointHistory![0]
        expect(record.outcome).toBe("feedback")
        expect(record.feedbackHash).toBeDefined()
        expect(record.invalidatedArtifacts).toEqual(
            expect.arrayContaining([
                "tasks",
                "implementation",
                "verification",
                "correctness-judgment",
                "review-ledger",
                "receipt",
            ]),
        )
    })

    it("rejects empty feedback", async () => {
        const directory = await initializedRepository()
        const change = "resume-3"
        await mkdir(changeRoot(directory, change), { recursive: true })

        const state = leanState("interactive")
        state.dispatches.push(planningDispatch())
        await writeRun(directory, change, state)
        await completeAction(directory, change, "planning", "# Tasks", DEFAULT_CONFIG)

        await expect(
            resumeCheckpointAction(directory, change, "   ", DEFAULT_CONFIG),
        ).rejects.toThrow(/non-empty/)
    })

    it("accepts unbounded checkpoint feedback", async () => {
        const directory = await initializedRepository()
        const change = "resume-4"
        await mkdir(changeRoot(directory, change), { recursive: true })

        const state = leanState("interactive")
        state.dispatches.push(planningDispatch())
        await writeRun(directory, change, state)
        await completeAction(directory, change, "planning", "# Tasks", DEFAULT_CONFIG)

        const feedback = "x".repeat(10_000)
        const resumed = await resumeCheckpointAction(directory, change, feedback, DEFAULT_CONFIG)
        expect(resumed.status).toBe("running")
        expect(resumed.checkpointHistory[0]?.feedback).toBe(feedback)
    })

    it("refuses to resume when no checkpoint is pending", async () => {
        const directory = await initializedRepository()
        const change = "resume-5"
        await mkdir(changeRoot(directory, change), { recursive: true })

        const state = leanState("interactive")
        await writeRun(directory, change, state)

        await expect(
            resumeCheckpointAction(directory, change, undefined, DEFAULT_CONFIG),
        ).rejects.toThrow(/not pending/)
    })

    it("nextAction returns undefined while a checkpoint is pending", () => {
        const state = leanState("interactive")
        state.pendingCheckpoint = {
            dispatchId: "d1",
            capability: "planning" as never,
            purpose: "workflow",
            action: "lean-plan",
            artifacts: [snapshot("tasks")],
            policyHash: "p",
            implementationDiffHash: undefined,
            bindingHash: "h",
            raisedAt: "now",
        }
        state.status = "paused"
        state.pauseReason = "checkpoint"
        state.resumable = true
        expect(nextAction(state)).toBeUndefined()
    })

    it("records a stale outcome when the binding no longer matches", async () => {
        const directory = await initializedRepository()
        const change = "resume-stale"
        await mkdir(changeRoot(directory, change), { recursive: true })

        const state = leanState("interactive")
        state.dispatches.push(planningDispatch())
        await writeRun(directory, change, state)
        const completed = await completeAction(
            directory,
            change,
            "planning",
            "# Tasks",
            DEFAULT_CONFIG,
        )
        const original = completed.pendingCheckpoint
        expect(original).toBeDefined()

        // Mutate the tasks artifact output hash so the checkpoint binding is stale.
        completed.artifacts.tasks = validArtifact(completed, "tasks", "changed-hash")
        completed.pendingCheckpoint = {
            ...original!,
            artifacts: [snapshot("tasks", "old-hash")],
        }
        await writeRun(directory, change, completed)

        const resumed = await resumeCheckpointAction(
            directory,
            change,
            "This feedback should not apply.",
            DEFAULT_CONFIG,
        )
        expect(resumed.status).toBe("running")
        expect(resumed.resumeTarget).toBeUndefined()
        expect(resumed.checkpointHistory!.at(-1)?.outcome).toBe("stale")
    })
})

describe("invalidation and resume prompt", () => {
    it("propagates checkpoint invalidation through the artifact graph", () => {
        const invalidated = invalidationForCheckpoint([snapshot("proposal"), snapshot("tasks")])
        expect(invalidated).toEqual(
            expect.arrayContaining([
                "proposal",
                "specs",
                "design",
                "tasks",
                "implementation",
                "verification",
                "correctness-judgment",
                "compliance-judgment",
                "review-ledger",
                "receipt",
            ]),
        )
    })

    it("includes the feedback as untrusted content in the resume prompt", () => {
        const prompt = resumePromptForCheckpoint("Original prompt.", {
            dispatchId: "d1",
            capability: "planning" as never,
            purpose: "workflow",
            action: "lean-plan",
            artifacts: [snapshot("tasks")],
            policyHash: "p",
            implementationDiffHash: undefined,
            bindingHash: "h",
            raisedAt: "now",
            resolvedAt: "now",
            outcome: "feedback",
            feedback: "Add an acceptance test.",
            feedbackHash: "fh",
            invalidatedArtifacts: ["tasks"],
        })
        expect(prompt).toContain("Original prompt.")
        expect(prompt).toContain("Recorded checkpoint feedback")
        expect(prompt).toContain("<untrusted-feedback>")
        expect(prompt).toContain("Add an acceptance test.")
        expect(prompt).toContain("</untrusted-feedback>")
    })
})

describe("automatic-mode isolation", () => {
    it("never queues a checkpoint in automatic mode", async () => {
        const directory = await initializedRepository()
        const change = "auto-1"
        await mkdir(changeRoot(directory, change), { recursive: true })

        const state = leanState("automatic")
        state.dispatches.push(planningDispatch())
        await writeRun(directory, change, state)

        const after = await completeAction(directory, change, "planning", "# Tasks", DEFAULT_CONFIG)
        expect(after.pendingCheckpoint).toBeUndefined()
        expect(after.status).toBe("running")
    })
})

describe("finalizeRun with a pending checkpoint", () => {
    it("returns the persisted paused state without marking completion", async () => {
        const directory = await initializedRepository()
        const change = "fin-1"
        await mkdir(changeRoot(directory, change), { recursive: true })

        const state = leanState("interactive")
        state.dispatches.push(planningDispatch())
        await writeRun(directory, change, state)
        await completeAction(directory, change, "planning", "# Tasks", DEFAULT_CONFIG)

        const finalized = await finalizeRun(directory, change, DEFAULT_CONFIG)
        expect(finalized.status).toBe("paused")
        expect(finalized.outcome).toBeUndefined()
        expect(finalized.pendingCheckpoint).toBeDefined()

        const dto = pendingCheckpointBlockView(finalized, change)
        expect(dto).toBeDefined()
        expect(dto!.checkpoint.artifacts).toEqual(["tasks"])
    })
})

describe("cancelRun with a pending checkpoint", () => {
    it("records the checkpoint as cancelled and clears the pause", async () => {
        const directory = await initializedRepository()
        const change = "cancel-1"
        await mkdir(changeRoot(directory, change), { recursive: true })

        const state = leanState("interactive")
        state.dispatches.push(planningDispatch())
        await writeRun(directory, change, state)
        await completeAction(directory, change, "planning", "# Tasks", DEFAULT_CONFIG)

        const cancelled = await cancelRun(directory, change, "User cancelled.")
        expect(cancelled.status).toBe("cancelled")
        expect(cancelled.pendingCheckpoint).toBeUndefined()
        expect(cancelled.checkpointHistory).toHaveLength(1)
        expect(cancelled.checkpointHistory![0].outcome).toBe("cancelled")
    })
})

describe("store validator checkpoint invariants", () => {
    it("accepts a checkpoint-paused state with a pending checkpoint", async () => {
        const directory = await initializedRepository()
        const change = "inv-1"
        await mkdir(changeRoot(directory, change), { recursive: true })
        const state = leanState("interactive")
        state.status = "paused"
        state.pauseReason = "checkpoint"
        state.resumable = true
        state.pendingCheckpoint = {
            dispatchId: "d1",
            capability: "planning" as never,
            purpose: "workflow",
            action: "lean-plan",
            artifacts: [snapshot("tasks")],
            policyHash: "p",
            implementationDiffHash: undefined,
            bindingHash: "h",
            raisedAt: "now",
        }
        await writeRun(directory, change, state)
        const back = await readRun(directory, change)
        expect(back.status).toBe("paused")
        expect(back.pendingCheckpoint?.dispatchId).toBe("d1")
    })

    it("rejects a checkpoint-paused state that also has a pending question", async () => {
        const directory = await initializedRepository()
        const change = "inv-2"
        await mkdir(changeRoot(directory, change), { recursive: true })
        const state = leanState("interactive")
        state.status = "paused"
        state.pauseReason = "checkpoint"
        state.resumable = true
        state.pendingCheckpoint = {
            dispatchId: "d1",
            capability: "planning" as never,
            purpose: "workflow",
            action: "lean-plan",
            artifacts: [snapshot("tasks")],
            policyHash: "p",
            implementationDiffHash: undefined,
            bindingHash: "h",
            raisedAt: "now",
        }
        state.pendingQuestions = [
            {
                id: "q1",
                dispatchId: "d1",
                phase: "tasks",
                capability: "planning" as never,
                prompt: "p",
                options: [{ id: "a", label: "A" }],
                allowOther: false,
                impact: "requirements",
                policyHash: "p",
                bindingHash: "b",
                raisedAt: "now",
                dismissalCount: 0,
            },
        ]
        await writeRun(directory, change, state)
        await expect(readRun(directory, change)).rejects.toThrow(
            /must not also have pending questions/,
        )
    })
})

describe("binding validation", () => {
    it("isCheckpointBindingCurrent returns true for a fresh checkpoint", () => {
        const state = leanState("interactive")
        const dispatch = planningDispatch()
        state.dispatches.push(dispatch)
        state.artifacts.tasks = validArtifact(state, "tasks", "hash-1")
        const snap = snapshotCheckpointArtifacts(state, ["tasks"])
        const pending = {
            dispatchId: dispatch.id,
            capability: "planning" as never,
            purpose: "workflow" as const,
            action: "lean-plan",
            artifacts: snap,
            policyHash: state.requirements.policyHash,
            implementationDiffHash: state.implementationDiffHash,
            bindingHash: computeCheckpointBindingHash(state, dispatch, snap),
            raisedAt: "now",
        }
        expect(isCheckpointBindingCurrent(state, pending)).toBe(true)
    })

    it("isCheckpointBindingCurrent returns false when the artifact hash changed", () => {
        const state = leanState("interactive")
        const dispatch = planningDispatch()
        state.dispatches.push(dispatch)
        state.artifacts.tasks = validArtifact(state, "tasks", "hash-1")
        const snap = snapshotCheckpointArtifacts(state, ["tasks"])
        const pending = {
            dispatchId: dispatch.id,
            capability: "planning" as never,
            purpose: "workflow" as const,
            action: "lean-plan",
            artifacts: snap,
            policyHash: state.requirements.policyHash,
            implementationDiffHash: state.implementationDiffHash,
            bindingHash: computeCheckpointBindingHash(state, dispatch, snap),
            raisedAt: "now",
        }
        // Mutate the artifact hash; binding should be stale.
        state.artifacts.tasks = validArtifact(state, "tasks", "hash-2")
        expect(isCheckpointBindingCurrent(state, pending)).toBe(false)
    })

    it("isCheckpointBindingCurrent returns false when the policy hash changed", () => {
        const state = leanState("interactive")
        const dispatch = planningDispatch()
        state.dispatches.push(dispatch)
        state.artifacts.tasks = validArtifact(state, "tasks")
        const snap = snapshotCheckpointArtifacts(state, ["tasks"])
        const pending = {
            dispatchId: dispatch.id,
            capability: "planning" as never,
            purpose: "workflow" as const,
            action: "lean-plan",
            artifacts: snap,
            policyHash: state.requirements.policyHash,
            implementationDiffHash: state.implementationDiffHash,
            bindingHash: computeCheckpointBindingHash(state, dispatch, snap),
            raisedAt: "now",
        }
        state.requirements.policyHash = "changed"
        expect(isCheckpointBindingCurrent(state, pending)).toBe(false)
    })
})

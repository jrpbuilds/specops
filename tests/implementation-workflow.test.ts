import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { createRunState, type RunState } from "../src/state/schema.js"
import { createV1Run, readV1Run, updateV1Run } from "../src/state/store.js"
import {
    acceptValidationCommands,
    acceptedValidationCommandsForRun,
} from "../src/validation/commands.js"
import { readValidationEvidence } from "../src/validation/evidence.js"
import type { ValidationEvidence } from "../src/validation/executor.js"
import type { ValidationCommand, ValidationRecommendation } from "../src/validation/registry.js"
import {
    incompleteOpenSpecTasks,
    parseOpenSpecTasks,
    routeImplementationBlocker,
    runImplementation,
    type ImplementationAgentRequest,
    type ImplementationArtifacts,
    type ImplementationWorkflowOptions,
} from "../src/workflow/implementation.js"
import type { RepositoryMutation } from "../src/repository/changes.js"

const change = "implementation-test"
const identity = "a".repeat(64)
const changedIdentity = "b".repeat(64)

const command: ValidationCommand = {
    id: "typecheck",
    executable: "node",
    args: ["--version"],
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
}

const recommendation: ValidationRecommendation = { ...command, id: "test", source: "explorer" }

const completeTasks = "- [x] 1.1 Implement the feature\n- [x] 1.2 Add focused tests\n"

const artifacts: ImplementationArtifacts = {
    exploration: "# Exploration\nRepository evidence\n",
    proposal: "# Proposal\n",
    specs: "# Spec\n",
    design: "# Design\n",
    tasks: completeTasks,
}

async function directory(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "specops-implementation-"))
}

async function state(root: string, stage: RunState["stage"] = "implementation"): Promise<RunState> {
    await createV1Run(root, {
        change,
        goal: "Implement the approved change",
        baselineRepositoryState: identity,
    })
    return updateV1Run(root, change, current => ({ ...current, stage }))
}

function evidence(
    commandId: string,
    repositoryIdentity = identity,
    overrides: Partial<ValidationEvidence> = {},
): ValidationEvidence {
    return {
        commandId,
        executable: command.executable,
        args: [...command.args],
        cwd: "/project",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1,
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        repositoryIdentity,
        outputHash: "c".repeat(64),
        ...overrides,
    }
}

function mutation(
    previous: string,
    current = previous,
    files: RepositoryMutation["files"] = [],
): RepositoryMutation {
    return { previous, current, changed: previous !== current, files }
}

function options(
    root: string,
    overrides: Partial<ImplementationWorkflowOptions> = {},
): ImplementationWorkflowOptions & {
    requests: ImplementationAgentRequest[]
    frontierCalls: number
} {
    const requests: ImplementationAgentRequest[] = []
    let frontierCalls = 0
    return {
        directory: root,
        adapter: {
            status: async () => {
                throw new Error("artifact loader should be injected")
            },
        },
        commands: acceptValidationCommands([command]),
        implementer: {
            run: async request => {
                requests.push(request)
                return { kind: "completed" }
            },
        },
        frontier: {
            run: async () => {
                frontierCalls += 1
                return { advice: "Inspect the failing boundary." }
            },
        },
        loadArtifacts: async () => artifacts,
        loadPrompt: () => "Implement only the approved work.",
        detectMutation: async (_directory, previous) => mutation(previous),
        executeCommand: async (_directory, configured, repositoryIdentity) =>
            evidence(configured.id, repositoryIdentity),
        notifyMutation: async () => undefined,
        ...overrides,
        requests,
        get frontierCalls() {
            return frontierCalls
        },
    }
}

describe("V1 implementation workflow", () => {
    it("passes complete approved context only to the implementer", async () => {
        const root = await directory()
        const context = options(root, {
            commands: acceptValidationCommands([command], [recommendation], [recommendation.id]),
        })

        const result = await runImplementation(context, await state(root))

        expect(result).toMatchObject({ kind: "ready-for-review", state: { stage: "review" } })
        expect(context.requests).toHaveLength(1)
        expect(context.requests[0]).toMatchObject({
            agent: "specops-implementer",
            goal: "Implement the approved change",
            artifacts,
            baselineRepositoryState: identity,
            acceptedValidationCommands: [command, recommendation],
            prompt: "Implement only the approved work.",
            state: { stage: "implementation" },
        })
    })

    it("tracks only standard tasks.md checkboxes and rejects review while required tasks remain", async () => {
        const root = await directory()
        const incomplete = { ...artifacts, tasks: "- [x] 1.1 Done\n- [ ] 1.2 Remaining\n" }
        const context = options(root, { loadArtifacts: async () => incomplete })

        expect(parseOpenSpecTasks(incomplete.tasks)).toEqual([
            { id: "1.1", complete: true, text: "Done" },
            { id: "1.2", complete: false, text: "Remaining" },
        ])
        expect(incompleteOpenSpecTasks(incomplete.tasks)).toMatchObject([{ id: "1.2" }])
        await expect(runImplementation(context, await state(root))).resolves.toMatchObject({
            kind: "tasks-incomplete",
            incompleteTasks: [{ id: "1.2" }],
        })
        expect(context.requests).toHaveLength(1)
        await expect(readV1Run(root, change)).resolves.toMatchObject({ stage: "implementation" })
    })

    it("uses the implementer-updated standard tasks.md content before validation", async () => {
        const root = await directory()
        let currentArtifacts = { ...artifacts, tasks: "- [ ] 1.1 Complete this task\n" }
        const context = options(root, {
            loadArtifacts: async () => currentArtifacts,
            implementer: {
                run: async () => {
                    currentArtifacts = {
                        ...currentArtifacts,
                        tasks: "- [x] 1.1 Complete this task\n",
                    }
                    return { kind: "completed" }
                },
            },
        })

        await expect(runImplementation(context, await state(root))).resolves.toMatchObject({
            kind: "ready-for-review",
        })
    })

    it("keeps explorer recommendations non-authoritative until the planning checkpoint accepts them", () => {
        expect(acceptValidationCommands([command], [recommendation]).required).toEqual([command])
        const accepted = acceptValidationCommands([command], [recommendation], [recommendation.id])
        expect(accepted.required).toEqual([command, recommendation])
        expect(
            acceptedValidationCommandsForRun(
                [command],
                [recommendation],
                accepted.acceptedRecommendationIds,
            ),
        ).toEqual(accepted)
    })

    it("persists passing evidence bound to the validation identity and becomes ready for later review", async () => {
        const root = await directory()
        const result = await runImplementation(options(root), await state(root))

        expect(result).toMatchObject({
            kind: "ready-for-review",
            state: { currentRepositoryState: identity, validatedRepositoryState: identity },
        })
        await expect(readValidationEvidence(root, change)).resolves.toMatchObject([
            { commandId: command.id, repositoryIdentity: identity },
        ])
    })

    it("returns exact failed command evidence to the implementer and reruns stale required commands", async () => {
        const root = await directory()
        let runs = 0
        const context = options(root, {
            executeCommand: async (_directory, configured, repositoryIdentity) => {
                runs += 1
                return evidence(
                    configured.id,
                    repositoryIdentity,
                    runs === 1 ? { exitCode: 1, stderr: "type error" } : {},
                )
            },
        })

        await expect(runImplementation(context, await state(root))).resolves.toMatchObject({
            kind: "ready-for-review",
        })
        expect(context.requests.map(request => request.kind)).toEqual(["initial", "validation-fix"])
        expect(context.requests[1].validationEvidence).toMatchObject([
            { exitCode: 1, stderr: "type error" },
        ])
        expect(runs).toBe(2)
    })

    it("records timeout evidence and returns it to the implementer", async () => {
        const root = await directory()
        let runs = 0
        const context = options(root, {
            executeCommand: async (_directory, configured, repositoryIdentity) => {
                runs += 1
                return evidence(
                    configured.id,
                    repositoryIdentity,
                    runs === 1 ? { timedOut: true, exitCode: null } : {},
                )
            },
        })

        await runImplementation(context, await state(root))
        expect(context.requests[1].validationEvidence).toMatchObject([
            { timedOut: true, exitCode: null },
        ])
    })

    it.each([
        [
            "tracked",
            [
                {
                    path: "src/file.ts",
                    staged: false,
                    modified: true,
                    deleted: false,
                    untracked: false,
                },
            ],
        ],
        [
            "untracked",
            [
                {
                    path: "new-file.ts",
                    staged: false,
                    modified: false,
                    deleted: false,
                    untracked: true,
                },
            ],
        ],
    ])(
        "invalidates evidence and notifies on %s mutation after validation",
        async (_kind, files) => {
            const root = await directory()
            let calls = 0
            const notifications: RepositoryMutation[] = []
            const context = options(root, {
                detectMutation: async (_directory, previous) => {
                    calls += 1
                    return calls === 2
                        ? mutation(previous, changedIdentity, files)
                        : mutation(previous)
                },
                notifyMutation: async observed => {
                    notifications.push(observed)
                },
            })

            const result = await runImplementation(context, await state(root))

            expect(result).toMatchObject({
                kind: "external-mutation",
                state: { stage: "validation" },
            })
            expect(notifications).toMatchObject([{ current: changedIdentity, files }])
            await expect(readValidationEvidence(root, change)).resolves.toMatchObject([
                { invalidatedBy: changedIdentity },
            ])
        },
    )

    it("routes artifact conflicts, material decisions, and ordinary failures at the coordinator boundary", async () => {
        const root = await directory()
        const artifactConflict = options(root, {
            implementer: {
                run: async () => ({
                    kind: "blocker",
                    blocker: {
                        kind: "artifact-conflict",
                        artifact: "design",
                        message: "design conflicts",
                    },
                }),
            },
        })
        await expect(runImplementation(artifactConflict, await state(root))).resolves.toMatchObject(
            {
                kind: "artifact-conflict",
                agent: "specops-designer",
            },
        )

        const questionRoot = await directory()
        const material = options(questionRoot, {
            implementer: {
                run: async () => ({
                    kind: "blocker",
                    blocker: {
                        kind: "material-decision",
                        prompt: "Choose a database",
                        outcomes: ["sqlite", "postgres"],
                        repositoryResolvable: false,
                        affectsMaterialOutcome: true,
                        reversibleLowRiskAssumptionAvailable: false,
                    },
                }),
            },
        })
        await expect(runImplementation(material, await state(questionRoot))).resolves.toMatchObject(
            {
                kind: "material-question",
            },
        )

        const retryRoot = await directory()
        let attempts = 0
        const ordinary = options(retryRoot, {
            implementer: {
                run: async () =>
                    ++attempts === 1
                        ? {
                              kind: "blocker",
                              blocker: { kind: "ordinary-failure", message: "retry" },
                          }
                        : { kind: "completed" },
            },
        })
        await expect(runImplementation(ordinary, await state(retryRoot))).resolves.toMatchObject({
            kind: "ready-for-review",
        })
        expect(attempts).toBe(2)
    })

    it("permits one documented read-only frontier consultation, rejects unsupported requests, and blocks after exhaustion", async () => {
        const eligible = {
            kind: "frontier" as const,
            message: "hard blocker",
            inspectedEvidence: ["src/service.ts:42"],
            concreteAttempt: "tried the documented integration",
            substantial: true,
            ordinaryRetryUnlikely: true,
        }
        expect(routeImplementationBlocker(eligible, false)).toEqual({ kind: "frontier" })
        expect(routeImplementationBlocker({ ...eligible, concreteAttempt: "" }, false)).toEqual({
            kind: "retry",
        })

        const root = await directory()
        let invocation = 0
        const permitted = options(root, {
            implementer: {
                run: async () =>
                    ++invocation === 1
                        ? { kind: "blocker", blocker: eligible }
                        : { kind: "completed" },
            },
        })
        await expect(runImplementation(permitted, await state(root))).resolves.toMatchObject({
            kind: "ready-for-review",
        })
        expect(permitted.frontierCalls).toBe(1)

        const exhaustedRoot = await directory()
        const exhausted = options(exhaustedRoot, {
            implementer: { run: async () => ({ kind: "blocker", blocker: eligible }) },
        })
        await expect(
            runImplementation(exhausted, await state(exhaustedRoot)),
        ).resolves.toMatchObject({ kind: "blocked" })
        expect(exhausted.frontierCalls).toBe(1)
    })

    it("resumes interrupted implementation and failed validation from their coarse persisted stages", async () => {
        const interruptedRoot = await directory()
        const interrupted = options(interruptedRoot)
        await expect(
            runImplementation(interrupted, await state(interruptedRoot)),
        ).resolves.toMatchObject({ kind: "ready-for-review" })

        const failedRoot = await directory()
        let validations = 0
        const failed = options(failedRoot, {
            executeCommand: async (_directory, configured, repositoryIdentity) => {
                validations += 1
                return evidence(
                    configured.id,
                    repositoryIdentity,
                    validations === 1 ? { exitCode: 1 } : {},
                )
            },
        })
        await expect(
            runImplementation(failed, await state(failedRoot, "validation")),
        ).resolves.toMatchObject({ kind: "ready-for-review" })
        expect(failed.requests).toMatchObject([{ kind: "validation-fix" }])
    })

    it("does not invent a task state outside standard task checkboxes", () => {
        expect(
            createRunState({ change, goal: "Check state", baselineRepositoryState: identity }),
        ).not.toHaveProperty("tasks")
    })
})

import { mkdtemp, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "../src/config.js"
import { parseWorkerOutput } from "../src/worker_output.js"
import {
    answerQuestion,
    cancelQuestion,
    computeQuestionBindingHash,
    consumeResumeTarget,
    dismissQuestion,
    invalidationForImpact,
    pendingQuestionBlockView,
    questionFingerprint,
    registerPendingQuestion,
    resolveImpact,
    validImpactsForPhase,
} from "../src/workflow/questions.js"
import { nextAction, nextDirective } from "../src/workflow/scheduler.js"
import { changeRoot, writeRun } from "../src/state/store.js"
import { cancelRun, completeAction } from "../src/workflow/engine.js"
import { requirementsFor } from "../src/routing/policy.js"
import type {
    Assessment,
    CapabilityId,
    DispatchRecord,
    RunState,
    WorkerQuestion,
} from "../src/types.js"
import { AGENT_IDS, ALL_AGENT_IDS } from "../src/capabilities/ids.js"
import { AGENT_REGISTRY } from "../src/capabilities/registry.js"

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

const QUESTION_MARKER = (q: Partial<WorkerQuestion> = {}): string =>
    `<!-- specops-question: ${JSON.stringify({
        prompt: "Which boundary should this change preserve?",
        options: [
            { id: "session", label: "Existing session model" },
            { id: "token", label: "Token-based model" },
        ],
        allowOther: true,
        impact: "requirements",
        ...q,
    })} -->`

function automaticState(overrides: Partial<RunState> = {}): RunState {
    const assessed = assessment()
    return {
        version: 2,
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
        questionHistory: [],
        questionBudgetUsage: {
            questionsRaised: 0,
            questionsByDispatch: {},
            fingerprintCounts: {},
        },
        createdAt: "now",
        updatedAt: "now",
        status: "running",
        ...overrides,
    }
}

function dispatch(
    id: string,
    capability: CapabilityId,
    purpose: DispatchRecord["purpose"] = "workflow",
): DispatchRecord {
    return {
        id,
        action: capability,
        agent: AGENT_IDS.core.implementer,
        capability,
        purpose,
        independent: purpose === "judgment" || purpose === "independent-review",
        inputHash: "input",
        status: "issued",
        at: "now",
    }
}

describe("worker question marker parsing", () => {
    const cfg = DEFAULT_CONFIG
    it("parses a valid question marker and strips it from prose", () => {
        const out = `Some prose.\n${QUESTION_MARKER()}\nMore prose.`
        const parsed = parseWorkerOutput(out, cfg, "proposal", "planning")
        expect(parsed.question?.options).toHaveLength(2)
        expect(parsed.question?.allowOther).toBe(true)
        expect(parsed.question?.impact).toBe("requirements")
        expect(parsed.prose).not.toContain("specops-question")
        expect(parsed.prose).toContain("Some prose.")
    })

    it("returns no question when no marker is present", () => {
        const parsed = parseWorkerOutput("plain prose only", cfg, "proposal", "planning")
        expect(parsed.question).toBeUndefined()
    })

    it("rejects multiple question markers", () => {
        const out = `${QUESTION_MARKER()}\n${QUESTION_MARKER()}`
        expect(() => parseWorkerOutput(out, cfg, "proposal", "planning")).toThrow(
            /multiple question markers/,
        )
    })

    it("rejects both an escalation and a question marker", () => {
        const esc = `<!-- specops-escalation: ${JSON.stringify({
            category: "risk-discovery",
            confidence: "high",
            summary: "x",
            evidence: [],
            boundaryCrossed: "y",
            whyCurrentRequirementsAreInsufficient: "z",
            requestedPatch: {},
        })} -->`
        const out = `${esc}\n${QUESTION_MARKER()}`
        expect(() => parseWorkerOutput(out, cfg, "proposal", "planning")).toThrow(
            /both an escalation and a question/,
        )
    })

    it("rejects fewer than 2 options", () => {
        const out = `<!-- specops-question: ${JSON.stringify({
            prompt: "p",
            options: [{ id: "a", label: "A" }],
        })} -->`
        expect(() => parseWorkerOutput(out, cfg, "proposal", "planning")).toThrow(/2 to 5 options/)
    })

    it("rejects more than 5 options", () => {
        const opts = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, label: `L${i}` }))
        const out = `<!-- specops-question: ${JSON.stringify({
            prompt: "p",
            options: opts,
        })} -->`
        expect(() => parseWorkerOutput(out, cfg, "proposal", "planning")).toThrow(/2 to 5 options/)
    })

    it("rejects duplicate option ids case-insensitively", () => {
        const out = `<!-- specops-question: ${JSON.stringify({
            prompt: "p",
            options: [
                { id: "Yes", label: "A" },
                { id: "yes", label: "B" },
            ],
        })} -->`
        expect(() => parseWorkerOutput(out, cfg, "proposal", "planning")).toThrow(/unique/)
    })

    it("rejects empty prompt", () => {
        const out = `<!-- specops-question: ${JSON.stringify({
            prompt: "   ",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
        })} -->`
        expect(() => parseWorkerOutput(out, cfg, "proposal", "planning")).toThrow(
            /non-empty prompt/,
        )
    })

    it("rejects unknown fields", () => {
        const out = `<!-- specops-question: ${JSON.stringify({
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            bogus: 1,
        })} -->`
        expect(() => parseWorkerOutput(out, cfg, "proposal", "planning")).toThrow(/unknown field/)
    })

    it("rejects an invalid impact for the phase", () => {
        const out = QUESTION_MARKER({ impact: "implementation" })
        // proposal phase allows requirements/design, not implementation
        expect(() => parseWorkerOutput(out, cfg, "proposal", "planning")).toThrow(
            /not valid for phase/,
        )
    })

    it("ignores markers inside fenced code blocks", () => {
        const out = "```\n" + QUESTION_MARKER() + "\n```"
        const parsed = parseWorkerOutput(out, cfg, "proposal", "planning")
        expect(parsed.question).toBeUndefined()
    })

    it("enforces a maximum marker size", () => {
        const bigPrompt = "x".repeat(DEFAULT_CONFIG.questions.maxPromptLength + 1)
        const out = `<!-- specops-question: ${JSON.stringify({
            prompt: bigPrompt,
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
        })} -->`
        expect(() => parseWorkerOutput(out, cfg, "proposal", "planning")).toThrow(/maximum length/)
    })
})

describe("question impact policy", () => {
    it("lists valid impacts per phase", () => {
        expect(validImpactsForPhase("proposal", "planning")).toEqual(["requirements", "design"])
        expect(validImpactsForPhase("implementation", "implementation")).toEqual([
            "implementation",
            "validation",
        ])
    })

    it("resolves a valid suggested impact", () => {
        expect(resolveImpact("design", "design", "design")).toBe("design")
    })

    it("rejects an out-of-bounds suggested impact", () => {
        expect(() => resolveImpact("implementation", "proposal", "planning")).toThrow(
            /not valid for phase/,
        )
    })

    it("falls back to the first allowed impact when none suggested", () => {
        expect(resolveImpact(undefined, "verification", "verification")).toBe("validation")
    })

    it("invalidation roots are deterministic per impact", () => {
        const state = automaticState()
        const reqRoots = invalidationForImpact(state, "requirements")
        expect(reqRoots).toContain("proposal")
        expect(reqRoots).toContain("specs")
        expect(reqRoots).toContain("implementation")

        const implRoots = invalidationForImpact(state, "implementation")
        expect(implRoots).toContain("implementation")
        expect(implRoots).toContain("verification")

        const valRoots = invalidationForImpact(state, "validation")
        expect(valRoots).toContain("verification")
        // validation impact must NOT touch implementation
        expect(valRoots).not.toContain("implementation")
    })
})

describe("question registration and budgets", () => {
    it("registers a pending question and increments counters", () => {
        const state = automaticState()
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "Which boundary?",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        }
        const pending = registerPendingQuestion(state, d, q, DEFAULT_CONFIG)
        expect(pending).toBeDefined()
        expect(state.pendingQuestion?.id).toBe(pending!.id)
        expect(state.pendingQuestion?.impact).toBe("requirements")
        expect(state.questionBudgetUsage?.questionsRaised).toBe(1)
        expect(state.questionBudgetUsage?.questionsByDispatch["d1"]).toBe(1)
        expect(state.questionBudgetUsage?.fingerprintCounts[pending!.fingerprint]).toBe(1)
    })

    it("blocks when per-run budget is exhausted", () => {
        const state = automaticState({
            questionBudgetUsage: {
                questionsRaised: DEFAULT_CONFIG.questions.budgets.maxQuestionsPerRun,
                questionsByDispatch: {},
                fingerprintCounts: {},
            },
        })
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
        }
        const pending = registerPendingQuestion(state, d, q, DEFAULT_CONFIG)
        expect(pending).toBeUndefined()
        expect(state.status).toBe("blocked")
        expect(state.blockReason).toBe("budget-exhausted")
        expect(state.resumable).toBe(false)
    })

    it("blocks when repeated fingerprint budget is exhausted", () => {
        const state = automaticState()
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        }
        // First registration succeeds.
        const first = registerPendingQuestion(state, d, q, DEFAULT_CONFIG)!
        // Cancel the question (no answer recorded, so answerHashes unchanged
        // and the binding hash — and therefore fingerprint — stays the same).
        cancelQuestion(state, first.id)
        // A second dispatch attempts the same question fingerprint.
        const d2 = dispatch("d2", "planning")
        state.dispatches.push(d2)
        const pending = registerPendingQuestion(state, d2, q, DEFAULT_CONFIG)
        expect(pending).toBeUndefined()
        expect(state.status).toBe("blocked")
        expect(state.blockReason).toBe("budget-exhausted")
    })
})

describe("ansering questions", () => {
    it("records an option answer and resumes the run", () => {
        const state = automaticState()
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "Which boundary?",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            allowOther: true,
            impact: "requirements",
        }
        const pending = registerPendingQuestion(state, d, q, DEFAULT_CONFIG)!
        const record = answerQuestion(state, pending.id, "a", undefined, DEFAULT_CONFIG)
        expect(record.outcome).toBe("answered")
        expect(record.selectedOptionId).toBe("a")
        expect(record.selectedOptionLabel).toBe("A")
        expect(record.answerHash).toBeTruthy()
        expect(record.invalidatedArtifacts).toContain("proposal")
        expect(state.pendingQuestion).toBeUndefined()
        expect(state.status).toBe("running")
        expect(state.resumeTarget?.questionId).toBe(pending.id)
        expect(state.resumeTarget?.consumed).toBeUndefined()
        expect(state.questionHistory).toHaveLength(1)
    })

    it("records an Other answer when allowOther is true", () => {
        const state = automaticState()
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "Which boundary?",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            allowOther: true,
            impact: "requirements",
        }
        const pending = registerPendingQuestion(state, d, q, DEFAULT_CONFIG)!
        const record = answerQuestion(state, pending.id, undefined, "custom answer", DEFAULT_CONFIG)
        expect(record.outcome).toBe("answered")
        expect(record.otherText).toBe("custom answer")
        expect(record.selectedOptionId).toBeUndefined()
    })

    it("rejects Other text when allowOther is false", () => {
        const state = automaticState()
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "Which boundary?",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        }
        const pending = registerPendingQuestion(state, d, q, DEFAULT_CONFIG)!
        expect(() => answerQuestion(state, pending.id, undefined, "other", DEFAULT_CONFIG)).toThrow(
            /does not allow Other/,
        )
    })

    it("rejects both option and Other text", () => {
        const state = automaticState()
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            allowOther: true,
            impact: "requirements",
        }
        const pending = registerPendingQuestion(state, d, q, DEFAULT_CONFIG)!
        expect(() => answerQuestion(state, pending.id, "a", "other", DEFAULT_CONFIG)).toThrow(
            /either an option or Other/,
        )
    })

    it("rejects neither option nor Other text", () => {
        const state = automaticState()
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        }
        const pending = registerPendingQuestion(state, d, q, DEFAULT_CONFIG)!
        expect(() =>
            answerQuestion(state, pending.id, undefined, undefined, DEFAULT_CONFIG),
        ).toThrow(/option or Other/)
    })

    it("rejects an unknown question id", () => {
        const state = automaticState()
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        }
        registerPendingQuestion(state, d, q, DEFAULT_CONFIG)
        expect(() => answerQuestion(state, "wrong-id", "a", undefined, DEFAULT_CONFIG)).toThrow(
            /not pending/,
        )
    })

    it("rejects a stale question when the binding hash changed", () => {
        const state = automaticState()
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        }
        const pending = registerPendingQuestion(state, d, q, DEFAULT_CONFIG)!
        // Mutate authoritative inputs so the binding hash no longer matches.
        state.requirements.policyHash = "changed"
        expect(() => answerQuestion(state, pending.id, "a", undefined, DEFAULT_CONFIG)).toThrow(
            /stale/,
        )
    })
})

describe("dismissal and cancellation", () => {
    it("dismissal pauses the run and retains the pending question", () => {
        const state = automaticState()
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        }
        const pending = registerPendingQuestion(state, d, q, DEFAULT_CONFIG)!
        const record = dismissQuestion(state, pending.id)
        expect(record.outcome).toBe("dismissed")
        expect(state.status).toBe("paused")
        expect(state.pauseReason).toBe("question-dismissed")
        expect(state.resumable).toBe(true)
        // pending question retained for re-presentation
        expect(state.pendingQuestion?.id).toBe(pending.id)
        expect(state.questionHistory).toHaveLength(1)
    })

    it("run cancellation flushes the pending question as cancelled", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-q-"))
        const change = "q-cancel"
        await mkdir(changeRoot(directory, change), { recursive: true })
        const state = automaticState({ mode: "interactive" })
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        await writeRun(directory, change, state)

        const completed = await completeAction(
            directory,
            change,
            "d1",
            `prose\n${QUESTION_MARKER()}`,
            DEFAULT_CONFIG,
        )
        expect(completed.pendingQuestion).toBeDefined()

        const cancelled = await cancelRun(directory, change, "User stopped.")
        expect(cancelled.status).toBe("cancelled")
        expect(cancelled.outcome?.category).toBe("cancelled")
        expect(cancelled.pendingQuestion).toBeUndefined()
        expect(cancelled.questionHistory).toHaveLength(1)
        expect(cancelled.questionHistory[0]?.outcome).toBe("cancelled")
    })
})

describe("scheduler directives", () => {
    it("returns ask-question when a question is pending (interactive)", () => {
        const state = automaticState({ mode: "interactive" })
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        }
        registerPendingQuestion(state, d, q, DEFAULT_CONFIG)
        const directive = nextDirective(state)
        expect(directive.type).toBe("ask-question")
        if (directive.type === "ask-question") {
            expect(directive.question.prompt).toBe("p")
            // The questionTool payload must match the OpenCode question-tool shape
            // so the controller can pass it verbatim without field mapping.
            expect(directive.questionTool).toBeDefined()
            expect(directive.questionTool.question).toBe("p")
            expect(directive.questionTool.header).toBeTruthy()
            expect(directive.questionTool.header.length).toBeLessThanOrEqual(30)
            expect(directive.questionTool.options).toHaveLength(2)
            expect(directive.questionTool.options[0]).toMatchObject({
                label: "a",
                description: "A",
            })
            expect(directive.questionTool.options[1]).toMatchObject({
                label: "b",
                description: "B",
            })
            expect(directive.questionTool.custom).toBe(false)
        }
    })

    it("includes questionTool in the inline ask-question directive", () => {
        const state = automaticState({ mode: "interactive", status: "running" })
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "Which design should we use?",
            options: [
                { id: "option-1", label: "Monolithic" },
                { id: "option-2", label: "Microservices" },
                { id: "option-3", label: "Event-driven" },
            ],
            impact: "design",
            allowOther: true,
        }
        registerPendingQuestion(state, d, q, DEFAULT_CONFIG)
        const directive = nextDirective(state)
        expect(directive.type).toBe("ask-question")
        if (directive.type === "ask-question") {
            // The questionTool maps WorkerQuestionOption.id -> label
            // and WorkerQuestionOption.label -> description for the native tool.
            expect(directive.questionTool.options).toHaveLength(3)
            expect(directive.questionTool.options[0]).toMatchObject({
                label: "option-1",
                description: "Monolithic",
            })
            expect(directive.questionTool.options[2]).toMatchObject({
                label: "option-3",
                description: "Event-driven",
            })
            // allowOther: true must surface as custom: true
            expect(directive.questionTool.custom).toBe(true)
        }
    })

    it("returns block pending-question resumable for automatic mode", () => {
        const state = automaticState({ mode: "automatic" })
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        }
        registerPendingQuestion(state, d, q, DEFAULT_CONFIG)
        const directive = nextDirective(state)
        expect(directive.type).toBe("block")
        if (directive.type === "block") {
            expect(directive.reason).toBe("pending-question")
            expect(directive.resumable).toBe(true)
            expect(directive.question).toBe(state.pendingQuestion)
        }
    })

    it("nextAction returns undefined while a question is pending", () => {
        const state = automaticState()
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        }
        registerPendingQuestion(state, d, q, DEFAULT_CONFIG)
        expect(nextAction(state)).toBeUndefined()
    })

    it("a paused run with a pending question returns ask-question without a worker", () => {
        const state = automaticState({ mode: "interactive" })
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        }
        registerPendingQuestion(state, d, q, DEFAULT_CONFIG)
        state.status = "paused"
        state.pauseReason = "pending-question"
        state.resumable = true
        const directive = nextDirective(state)
        expect(directive.type).toBe("ask-question")
        expect(nextAction(state)).toBeUndefined()
    })
})

describe("resume target and fresh dispatch", () => {
    it("consumes the resume target exactly once", () => {
        const state = automaticState()
        // Use a dispatch whose action matches what nextAction will produce.
        const d: DispatchRecord = {
            id: "d1",
            action: "lean-plan",
            agent: AGENT_IDS.core.planner,
            capability: "planning",
            purpose: "workflow",
            independent: false,
            inputHash: "input",
            status: "issued",
            at: "now",
        }
        state.dispatches.push(d)
        // Mark exploration as complete so the scheduler dispatches planning next.
        state.artifacts.exploration = {
            artifact: "exploration",
            producer: "test",
            purpose: "workflow",
            generatedAt: "now",
            inputHashes: {},
            outputHash: "exploration",
            scopeTier: state.scopeTier,
            capabilities: state.requirements.requiredCapabilities,
            validity: "valid",
        }
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        }
        const pending = registerPendingQuestion(state, d, q, DEFAULT_CONFIG)!
        answerQuestion(state, pending.id, "a", undefined, DEFAULT_CONFIG)
        expect(state.resumeTarget?.consumed).toBeUndefined()
        const directive = nextDirective(state)
        expect(directive.type).toBe("dispatch")
        expect(
            (directive as { type: "dispatch"; action: { prompt: string } }).action.prompt,
        ).toContain("Recorded user answer")
        expect(state.resumeTarget?.consumed).toBeUndefined()
        consumeResumeTarget(state)
        expect(state.resumeTarget?.consumed).toBe(true)
        const second = nextDirective(state)
        if (second.type === "dispatch") {
            expect(second.action.prompt).not.toContain("Recorded user answer")
        }
    })
})

describe("stable CLI pending-question view", () => {
    it("exposes a stable machine-readable DTO", () => {
        const state = automaticState({ mode: "automatic" })
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const q: WorkerQuestion = {
            prompt: "Which boundary?",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            allowOther: true,
            impact: "requirements",
        }
        const pending = registerPendingQuestion(state, d, q, DEFAULT_CONFIG)!
        state.status = "paused"
        state.pauseReason = "pending-question"
        state.resumable = true
        const view = pendingQuestionBlockView(state, "my-change")
        expect(view).toEqual({
            version: 1,
            change: "my-change",
            status: "paused",
            reason: "pending-question",
            resumable: true,
            question: {
                id: pending.id,
                prompt: pending.prompt,
                options: pending.options,
                allowOther: pending.allowOther,
                impact: pending.impact,
                bindingHash: pending.bindingHash,
            },
        })
    })

    it("returns undefined when no question is pending", () => {
        const state = automaticState()
        expect(pendingQuestionBlockView(state, "c")).toBeUndefined()
    })
})

describe("no direct worker access to the question tool", () => {
    it("only the interactive controller has the question tool enabled", () => {
        for (const id of ALL_AGENT_IDS) {
            const policy = AGENT_REGISTRY[id]
            const hasQuestion = policy.tools.question === true
            if (id === AGENT_IDS.controller.interactive) {
                expect(hasQuestion).toBe(true)
            } else {
                expect(hasQuestion).toBe(false)
            }
        }
    })
})

describe("fingerprint includes labels", () => {
    it("differs when labels differ even with same ids", () => {
        const base = {
            prompt: "p",
            options: [
                { id: "yes", label: "Yes" },
                { id: "no", label: "No" },
            ],
        }
        const differentLabels = {
            prompt: "p",
            options: [
                { id: "yes", label: "Affirmative" },
                { id: "no", label: "Negative" },
            ],
        }
        const a = questionFingerprint(base, "proposal", "planning")
        const b = questionFingerprint(differentLabels, "proposal", "planning")
        expect(a).not.toBe(b)
    })
})

describe("binding hash stability", () => {
    it("does not change when incidental state mutates", () => {
        const state = automaticState()
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const before = computeQuestionBindingHash(state, d)
        // Mutate a non-authoritative field.
        state.updatedAt = "later"
        const after = computeQuestionBindingHash(state, d)
        expect(after).toBe(before)
    })

    it("changes when the policy hash changes", () => {
        const state = automaticState()
        const d = dispatch("d1", "planning")
        state.dispatches.push(d)
        const before = computeQuestionBindingHash(state, d)
        state.requirements.policyHash = "changed"
        const after = computeQuestionBindingHash(state, d)
        expect(after).not.toBe(before)
    })
})

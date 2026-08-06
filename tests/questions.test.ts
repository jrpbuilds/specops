import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { parseWorkerOutput } from "../src/worker_output.js";
import {
    answerQuestion,
    computeQuestionBindingHash,
    consumeResumeTarget,
    dismissQuestion,
    invalidationForImpact,
    pendingQuestionBlockView,
    registerPendingQuestions,
    resolveImpact,
    validImpactsForPhase,
} from "../src/workflow/questions.js";
import { nextAction, nextDirective } from "../src/workflow/scheduler.js";
import { changeRoot, readRun, writeRun } from "../src/state/store.js";
import { answerQuestionsAction, cancelRun, completeAction } from "../src/workflow/engine.js";
import { requirementsFor } from "../src/routing/policy.js";
import type {
    Assessment,
    CapabilityId,
    DispatchRecord,
    RunState,
    WorkerQuestion,
} from "../src/types.js";
import { AGENT_IDS, ALL_AGENT_IDS } from "../src/capabilities/ids.js";
import { AGENT_REGISTRY } from "../src/capabilities/registry.js";

const assessment = (overrides: Partial<Assessment> = {}): Assessment => ({
    changeKind: "bugfix",
    expectedFiles: 1,
    expectedModules: 1,
    restoresExistingBehavior: true,
    changesRequirements: false,
    publicContract: "none",
    riskFacets: [],
    touchedSurfaces: [],
    confidence: {
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
});

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
    })} -->`;

function automaticState(overrides: Partial<RunState> = {}): RunState {
    const assessed = assessment();
    return {
        version: 7,
        revision: 0,
        mode: "automatic",
        goal: "test",
        baseline: "abc",
        requestedTier: "auto",
        scopeTier: "lean",
        assessment: assessed,
        requirements: requirementsFor(assessed, "auto", DEFAULT_CONFIG).requirements,
        riskFacets: [],
        confidence: assessed.confidence,
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
        ...overrides,
    };
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
    };
}

describe("worker question marker parsing", () => {
    it("parses a valid question marker and strips it from prose", () => {
        const out = `Some prose.\n${QUESTION_MARKER()}\nMore prose.`;
        const parsed = parseWorkerOutput(out, "proposal", "planning");
        expect(parsed.questions?.[0]?.options).toHaveLength(2);
        expect(parsed.questions?.[0]?.allowOther).toBe(true);
        expect(parsed.questions?.[0]?.impact).toBe("requirements");
        expect(parsed.prose).not.toContain("specops-question");
        expect(parsed.prose).toContain("Some prose.");
    });

    it("returns no question when no marker is present", () => {
        const parsed = parseWorkerOutput("plain prose only", "proposal", "planning");
        expect(parsed.questions).toBeUndefined();
    });

    it("rejects both an escalation and a question marker", () => {
        const esc = `<!-- specops-escalation: ${JSON.stringify({
            category: "risk-discovery",
            confidence: "high",
            summary: "x",
            evidence: [],
            boundaryCrossed: "y",
            whyCurrentRequirementsAreInsufficient: "z",
            requestedPatch: {},
        })} -->`;
        const out = `${esc}\n${QUESTION_MARKER()}`;
        expect(() => parseWorkerOutput(out, "proposal", "planning")).toThrow(
            /both an escalation and a question/,
        );
    });

    it("parses a recommended option", () => {
        const out = `<!-- specops-question: ${JSON.stringify({
            prompt: "p",
            options: [
                { id: "a", label: "A", recommended: true },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        })} -->`;
        const parsed = parseWorkerOutput(out, "proposal", "planning");
        expect(parsed.questions?.[0]?.options[0]?.recommended).toBe(true);
        expect(parsed.questions?.[0]?.options[1]?.recommended).toBeUndefined();
    });

    it("accepts multiple recommendation hints", () => {
        const out = `<!-- specops-question: ${JSON.stringify({
            prompt: "p",
            options: [
                { id: "a", label: "A", recommended: true },
                { id: "b", label: "B", recommended: true },
            ],
            impact: "requirements",
        })} -->`;
        const parsed = parseWorkerOutput(out, "proposal", "planning");
        expect(parsed.questions?.[0]?.options.every(option => option.recommended)).toBe(true);
    });

    it("rejects non-boolean recommended field", () => {
        const out = `<!-- specops-question: ${JSON.stringify({
            prompt: "p",
            options: [
                { id: "a", label: "A", recommended: "yes" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        })} -->`;
        expect(() => parseWorkerOutput(out, "proposal", "planning")).toThrow(
            /recommended must be a boolean/,
        );
    });

    it("accepts a single option", () => {
        const out = `<!-- specops-question: ${JSON.stringify({
            prompt: "p",
            options: [{ id: "a", label: "A" }],
        })} -->`;
        expect(parseWorkerOutput(out, "proposal", "planning").questions).toHaveLength(1);
    });

    it("accepts more than 5 options", () => {
        const opts = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, label: `L${i}` }));
        const out = `<!-- specops-question: ${JSON.stringify({
            prompt: "p",
            options: opts,
        })} -->`;
        expect(parseWorkerOutput(out, "proposal", "planning").questions?.[0]?.options).toHaveLength(
            6,
        );
    });

    it("accepts a custom-only question", () => {
        const out = `<!-- specops-question: ${JSON.stringify({
            prompt: "p",
            options: [],
            allowOther: true,
        })} -->`;
        expect(parseWorkerOutput(out, "proposal", "planning").questions?.[0]?.allowOther).toBe(
            true,
        );
    });

    it("rejects duplicate option ids case-insensitively", () => {
        const out = `<!-- specops-question: ${JSON.stringify({
            prompt: "p",
            options: [
                { id: "Yes", label: "A" },
                { id: "yes", label: "B" },
            ],
        })} -->`;
        expect(() => parseWorkerOutput(out, "proposal", "planning")).toThrow(/unique/);
    });

    it("rejects empty prompt", () => {
        const out = `<!-- specops-question: ${JSON.stringify({
            prompt: "   ",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
        })} -->`;
        expect(() => parseWorkerOutput(out, "proposal", "planning")).toThrow(/non-empty prompt/);
    });

    it("rejects unknown fields", () => {
        const out = `<!-- specops-question: ${JSON.stringify({
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            bogus: 1,
        })} -->`;
        expect(() => parseWorkerOutput(out, "proposal", "planning")).toThrow(/unknown field/);
    });

    it("explains that impact belongs at the question marker root", () => {
        const out = `<!-- specops-question: ${JSON.stringify({
            prompt: "p",
            options: [
                { id: "a", label: "A", impact: "requirements" },
                { id: "b", label: "B" },
            ],
        })} -->`;
        expect(() => parseWorkerOutput(out, "proposal", "planning")).toThrow(
            /impact belongs at the question marker root/,
        );
    });

    it("rejects an invalid impact for the phase", () => {
        const out = QUESTION_MARKER({ impact: "implementation" });
        // proposal phase allows requirements/design, not implementation
        expect(() => parseWorkerOutput(out, "proposal", "planning")).toThrow(/not valid for phase/);
    });

    it("ignores markers inside fenced code blocks", () => {
        const out = "```\n" + QUESTION_MARKER() + "\n```";
        const parsed = parseWorkerOutput(out, "proposal", "planning");
        expect(parsed.questions).toBeUndefined();
    });
});

describe("question impact policy", () => {
    it("lists valid impacts per phase", () => {
        expect(validImpactsForPhase("proposal", "planning")).toEqual(["requirements", "design"]);
        expect(validImpactsForPhase("implementation", "implementation")).toEqual([
            "implementation",
            "validation",
        ]);
    });

    it("resolves a valid suggested impact", () => {
        expect(resolveImpact("design", "design", "design")).toBe("design");
    });

    it("rejects an out-of-bounds suggested impact", () => {
        expect(() => resolveImpact("implementation", "proposal", "planning")).toThrow(
            /not valid for phase/,
        );
    });

    it("falls back to the first allowed impact when none suggested", () => {
        expect(resolveImpact(undefined, "verification", "verification")).toBe("validation");
    });

    it("invalidation roots are deterministic per impact", () => {
        const state = automaticState();
        const reqRoots = invalidationForImpact(state, "requirements");
        expect(reqRoots).toContain("proposal");
        expect(reqRoots).toContain("specs");
        expect(reqRoots).toContain("implementation");

        const implRoots = invalidationForImpact(state, "implementation");
        expect(implRoots).toContain("implementation");
        expect(implRoots).toContain("verification");

        const valRoots = invalidationForImpact(state, "validation");
        expect(valRoots).toContain("verification");
        // validation impact must NOT touch implementation
        expect(valRoots).not.toContain("implementation");
    });
});

describe("question registration", () => {
    it("registers a pending question", () => {
        const state = automaticState();
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "Which boundary?",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        };
        const pending = registerPendingQuestions(state, d, [q]);
        expect(pending).toBeDefined();
        expect(state.pendingQuestions?.[0]?.id).toBe(pending![0]!.id);
        expect(state.pendingQuestions?.[0]?.impact).toBe("requirements");
    });
});

describe("ansering questions", () => {
    it("records an option answer and resumes the run", () => {
        const state = automaticState();
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "Which boundary?",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            allowOther: true,
            impact: "requirements",
        };
        const pending = registerPendingQuestions(state, d, [q])!;
        const record = answerQuestion(state, pending![0]!.id, "a", undefined);
        expect(record.outcome).toBe("answered");
        expect(record.selectedOptionId).toBe("a");
        expect(record.selectedOptionLabel).toBe("A");
        expect(record.answerHash).toBeTruthy();
        expect(record.invalidatedArtifacts).toContain("proposal");
        expect(state.pendingQuestions).toBeUndefined();
        expect(state.status).toBe("running");
        expect(state.resumeTarget?.sourceId).toBe(pending![0]!.id);
        expect(state.resumeTarget?.consumed).toBeUndefined();
        expect(state.questionHistory).toHaveLength(1);
    });

    it("records an Other answer when allowOther is true", () => {
        const state = automaticState();
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "Which boundary?",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            allowOther: true,
            impact: "requirements",
        };
        const pending = registerPendingQuestions(state, d, [q])!;
        const record = answerQuestion(state, pending![0]!.id, undefined, "custom answer");
        expect(record.outcome).toBe("answered");
        expect(record.otherText).toBe("custom answer");
        expect(record.selectedOptionId).toBeUndefined();
    });

    it("rejects Other text when allowOther is false", () => {
        const state = automaticState();
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "Which boundary?",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        };
        const pending = registerPendingQuestions(state, d, [q])!;
        expect(() => answerQuestion(state, pending![0]!.id, undefined, "other")).toThrow(
            /does not allow Other/,
        );
    });

    it("rejects both option and Other text", () => {
        const state = automaticState();
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            allowOther: true,
            impact: "requirements",
        };
        const pending = registerPendingQuestions(state, d, [q])!;
        expect(() => answerQuestion(state, pending![0]!.id, "a", "other")).toThrow(
            /either an option or Other/,
        );
    });

    it("rejects neither option nor Other text", () => {
        const state = automaticState();
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        };
        const pending = registerPendingQuestions(state, d, [q])!;
        expect(() => answerQuestion(state, pending![0]!.id, undefined, undefined)).toThrow(
            /option or Other/,
        );
    });

    it("rejects an unknown question id", () => {
        const state = automaticState();
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        };
        registerPendingQuestions(state, d, [q]);
        expect(() => answerQuestion(state, "wrong-id", "a", undefined)).toThrow(/not pending/);
    });

    it("rejects a stale question when the binding hash changed", () => {
        const state = automaticState();
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        };
        const pending = registerPendingQuestions(state, d, [q])!;
        // Mutate authoritative inputs so the binding hash no longer matches.
        state.requirements.policyHash = "changed";
        expect(() => answerQuestion(state, pending![0]!.id, "a", undefined)).toThrow(/stale/);
    });
});

describe("dismissal and cancellation", () => {
    it("dismissal pauses the run and retains the pending question", () => {
        const state = automaticState();
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        };
        const pending = registerPendingQuestions(state, d, [q])!;
        const record = dismissQuestion(state, pending![0]!.id);
        expect(record.outcome).toBe("dismissed");
        expect(state.status).toBe("paused");
        expect(state.pauseReason).toBe("question-dismissed");
        expect(state.resumable).toBe(true);
        // pending question retained for re-presentation
        expect(state.pendingQuestions?.[0]?.id).toBe(pending![0]!.id);
        expect(state.questionHistory).toHaveLength(1);
    });

    it("run cancellation flushes the pending question as cancelled", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-q-"));
        const change = "q-cancel";
        await mkdir(changeRoot(directory, change), { recursive: true });
        const state = automaticState({ mode: "interactive" });
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        await writeRun(directory, change, state);

        const completed = await completeAction(
            directory,
            change,
            "d1",
            `prose\n${QUESTION_MARKER()}`,
            DEFAULT_CONFIG,
        );
        expect(completed.pendingQuestions).toBeDefined();

        const cancelled = await cancelRun(directory, change, "User stopped.");
        expect(cancelled.status).toBe("cancelled");
        expect(cancelled.outcome?.category).toBe("cancelled");
        expect(cancelled.pendingQuestions).toBeUndefined();
        expect(cancelled.questionHistory).toHaveLength(1);
        expect(cancelled.questionHistory[0]?.outcome).toBe("cancelled");
    });
});

describe("scheduler directives", () => {
    it("returns ask-question when a question is pending (interactive)", () => {
        const state = automaticState({ mode: "interactive" });
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        };
        registerPendingQuestions(state, d, [q]);
        const directive = nextDirective(state);
        expect(directive.type).toBe("ask-question");
        if (directive.type === "ask-question") {
            expect(directive.questions![0]!.prompt).toBe("p");
            // The questionTool payload must match the OpenCode question-tool shape
            // so the controller can pass it verbatim without field mapping.
            expect(directive.questionTools[0]).toBeDefined();
            expect(directive.questionTools[0].question).toBe("p");
            expect(directive.questionTools[0].header).toBeTruthy();
            expect(directive.questionTools[0].header.length).toBeLessThanOrEqual(30);
            expect(directive.questionTools[0].options).toHaveLength(2);
            expect(directive.questionTools[0].options[0]).toMatchObject({
                label: "a",
                description: "A",
            });
            expect(directive.questionTools[0].options[1]).toMatchObject({
                label: "b",
                description: "B",
            });
            expect(directive.questionTools[0].custom).toBe(false);
        }
    });

    it("includes questionTool in the inline ask-question directive", () => {
        const state = automaticState({ mode: "interactive", status: "running" });
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "Which design should we use?",
            options: [
                { id: "option-1", label: "Monolithic" },
                { id: "option-2", label: "Microservices" },
                { id: "option-3", label: "Event-driven" },
            ],
            impact: "design",
            allowOther: true,
        };
        registerPendingQuestions(state, d, [q]);
        const directive = nextDirective(state);
        expect(directive.type).toBe("ask-question");
        if (directive.type === "ask-question") {
            // The questionTool maps WorkerQuestionOption.id -> label
            // and WorkerQuestionOption.label -> description for the native tool.
            expect(directive.questionTools[0].options).toHaveLength(3);
            expect(directive.questionTools[0].options[0]).toMatchObject({
                label: "option-1",
                description: "Monolithic",
            });
            expect(directive.questionTools[0].options[2]).toMatchObject({
                label: "option-3",
                description: "Event-driven",
            });
            // allowOther: true must surface as custom: true
            expect(directive.questionTools[0].custom).toBe(true);
        }
    });

    it("exposes the canonical option id as label and marks recommended in description", () => {
        const state = automaticState({ mode: "interactive", status: "running" });
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "Which approach?",
            options: [
                { id: "simple", label: "Simple approach", recommended: true },
                { id: "complex", label: "Complex approach" },
            ],
            impact: "design",
        };
        registerPendingQuestions(state, d, [q]);
        const directive = nextDirective(state);
        expect(directive.type).toBe("ask-question");
        if (directive.type === "ask-question") {
            // The native question tool returns the displayed label verbatim
            // as the selected option, so the label must be the canonical id
            // the backend validates against (never "id (Recommended)").
            expect(directive.questionTools[0].options[0].label).toBe("simple");
            expect(directive.questionTools[0].options[1].label).toBe("complex");
            // Recommendation guidance is surfaced in the description instead.
            expect(directive.questionTools[0].options[0].description).toBe(
                "Simple approach (Recommended)",
            );
            expect(directive.questionTools[0].options[1].description).toBe("Complex approach");
            // multiple must be false so the native UI selects exactly one.
            expect(directive.questionTools[0].multiple).toBe(false);
        }
    });

    it("registers and presents multiple questions as a multi-step batch", () => {
        const state = automaticState({ mode: "interactive", status: "running" });
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const questions: WorkerQuestion[] = [
            {
                prompt: "Which session model?",
                options: [
                    { id: "session", label: "Session-based" },
                    { id: "token", label: "Token-based" },
                ],
                impact: "requirements",
            },
            {
                prompt: "Which token expiry?",
                options: [
                    { id: "1h", label: "1 hour" },
                    { id: "24h", label: "24 hours" },
                    { id: "7d", label: "7 days" },
                ],
                allowOther: true,
                impact: "requirements",
            },
        ];
        const batch = registerPendingQuestions(state, d, questions);
        expect(batch).toHaveLength(2);
        expect(state.pendingQuestions).toHaveLength(2);
        expect(state.status).toBe("paused");

        const directive = nextDirective(state);
        expect(directive.type).toBe("ask-question");
        if (directive.type === "ask-question") {
            expect(directive.questionTools).toHaveLength(2);
            expect(directive.questionTools[0].question).toBe("Which session model?");
            expect(directive.questionTools[1].question).toBe("Which token expiry?");
            expect(directive.questionTools[1].custom).toBe(true);
        }
    });

    it("stays paused after answering one question from a batch", () => {
        const state = automaticState({ mode: "interactive", status: "running" });
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const questions: WorkerQuestion[] = [
            {
                prompt: "Q1?",
                options: [
                    { id: "a", label: "A" },
                    { id: "b", label: "B" },
                ],
                impact: "requirements",
            },
            {
                prompt: "Q2?",
                options: [
                    { id: "c", label: "C" },
                    { id: "d", label: "D" },
                ],
                impact: "requirements",
            },
        ];
        const batch = registerPendingQuestions(state, d, questions)!;
        answerQuestion(state, batch[0]!.id, "a", undefined);
        expect(state.status).toBe("paused");
        expect(state.pendingQuestions).toHaveLength(1);
        expect(state.pendingQuestions?.[0]?.prompt).toBe("Q2?");
    });

    it("resumes after answering all questions in a batch", () => {
        const state = automaticState({ mode: "interactive", status: "running" });
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const questions: WorkerQuestion[] = [
            {
                prompt: "Q1?",
                options: [
                    { id: "a", label: "A" },
                    { id: "b", label: "B" },
                ],
                impact: "requirements",
            },
            {
                prompt: "Q2?",
                options: [
                    { id: "c", label: "C" },
                    { id: "d", label: "D" },
                ],
                impact: "requirements",
            },
        ];
        const batch = registerPendingQuestions(state, d, questions)!;
        answerQuestion(state, batch[0]!.id, "a", undefined);
        answerQuestion(state, batch[1]!.id, "c", undefined);
        expect(state.status).toBe("running");
        expect(state.pendingQuestions).toBeUndefined();
        expect(state.resumeTarget).toBeDefined();
        expect(state.questionHistory.filter(r => r.outcome === "answered")).toHaveLength(2);
    });

    it("returns block pending-question resumable for automatic mode", () => {
        const state = automaticState({ mode: "automatic" });
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        };
        registerPendingQuestions(state, d, [q]);
        const directive = nextDirective(state);
        expect(directive.type).toBe("block");
        if (directive.type === "block") {
            expect(directive.reason).toBe("pending-question");
            expect(directive.resumable).toBe(true);
            expect(directive.questions![0]!).toBe(state.pendingQuestions?.[0]);
        }
    });

    it("nextAction returns undefined while a question is pending", () => {
        const state = automaticState();
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        };
        registerPendingQuestions(state, d, [q]);
        expect(nextAction(state)).toBeUndefined();
    });

    it("a paused run with a pending question returns ask-question without a worker", () => {
        const state = automaticState({ mode: "interactive" });
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        };
        registerPendingQuestions(state, d, [q]);
        state.status = "paused";
        state.pauseReason = "pending-question";
        state.resumable = true;
        const directive = nextDirective(state);
        expect(directive.type).toBe("ask-question");
        expect(nextAction(state)).toBeUndefined();
    });
});

describe("resume target and fresh dispatch", () => {
    it("consumes the resume target exactly once", () => {
        const state = automaticState();
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
        };
        state.dispatches.push(d);
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
        };
        const q: WorkerQuestion = {
            prompt: "p",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        };
        const pending = registerPendingQuestions(state, d, [q])!;
        answerQuestion(state, pending![0]!.id, "a", undefined);
        expect(state.resumeTarget?.consumed).toBeUndefined();
        const directive = nextDirective(state);
        expect(directive.type).toBe("dispatch");
        expect(
            (directive as { type: "dispatch"; action: { prompt: string } }).action.prompt,
        ).toContain("Recorded user answer");
        expect(state.resumeTarget?.consumed).toBeUndefined();
        consumeResumeTarget(state);
        expect(state.resumeTarget?.consumed).toBe(true);
        const second = nextDirective(state);
        if (second.type === "dispatch") {
            expect(second.action.prompt).not.toContain("Recorded user answer");
        }
    });
});

describe("stable CLI pending-question view", () => {
    it("exposes a stable machine-readable DTO", () => {
        const state = automaticState({ mode: "automatic" });
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "Which boundary?",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            allowOther: true,
            impact: "requirements",
        };
        const pending = registerPendingQuestions(state, d, [q])!;
        state.status = "paused";
        state.pauseReason = "pending-question";
        state.resumable = true;
        const view = pendingQuestionBlockView(state, "my-change");
        expect(view).toEqual({
            version: 1,
            change: "my-change",
            status: "paused",
            reason: "pending-question",
            resumable: true,
            questions: [
                {
                    id: pending![0]!.id,
                    prompt: pending![0]!.prompt,
                    options: pending![0]!.options,
                    allowOther: pending![0]!.allowOther,
                    impact: pending![0]!.impact,
                    bindingHash: pending![0]!.bindingHash,
                },
            ],
        });
    });

    it("returns undefined when no question is pending", () => {
        const state = automaticState();
        expect(pendingQuestionBlockView(state, "c")).toBeUndefined();
    });
});

describe("no direct worker access to the question tool", () => {
    it("only the interactive controller has the question tool enabled", () => {
        for (const id of ALL_AGENT_IDS) {
            const policy = AGENT_REGISTRY[id];
            const hasQuestion = policy.permission.question === "allow";
            if (id === AGENT_IDS.controller.interactive) {
                expect(hasQuestion).toBe(true);
            } else {
                expect(hasQuestion).toBe(false);
            }
        }
    });
});

describe("binding hash stability", () => {
    it("does not change when incidental state mutates", () => {
        const state = automaticState();
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const before = computeQuestionBindingHash(state, d);
        // Mutate a non-authoritative field.
        state.updatedAt = "later";
        const after = computeQuestionBindingHash(state, d);
        expect(after).toBe(before);
    });

    it("changes when the policy hash changes", () => {
        const state = automaticState();
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const before = computeQuestionBindingHash(state, d);
        state.requirements.policyHash = "changed";
        const after = computeQuestionBindingHash(state, d);
        expect(after).not.toBe(before);
    });
});

describe("question batches", () => {
    it("registers an arbitrary-sized batch", () => {
        const state = automaticState({ mode: "interactive", status: "running" });
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const questions: WorkerQuestion[] = Array.from({ length: 8 }, (_, i) => ({
            prompt: `Q${i}?`,
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
            impact: "requirements",
        }));
        const batch = registerPendingQuestions(state, d, questions);
        expect(batch).toHaveLength(8);
        expect(state.status).toBe("paused");
        expect(state.pendingQuestions).toHaveLength(8);
    });
});

describe("answerQuestionsAction preflight validation", () => {
    async function setupBatchRun() {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-batch-"));
        const change = "batch-test";
        await mkdir(changeRoot(directory, change), { recursive: true });
        const state = automaticState({ mode: "interactive" });
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        await writeRun(directory, change, state);
        const questions: WorkerQuestion[] = [
            {
                prompt: "<Q1 & choose>?",
                options: [
                    { id: "a", label: "A" },
                    { id: "b", label: "B" },
                ],
                impact: "requirements",
            },
            {
                prompt: "Q2?",
                options: [
                    { id: "c", label: "C" },
                    { id: "d", label: "D", recommended: true },
                ],
                allowOther: true,
                impact: "requirements",
            },
        ];
        const completed = await completeAction(
            directory,
            change,
            "d1",
            `prose\n${questions
                .map(
                    q =>
                        `<!-- specops-question: ${JSON.stringify({
                            prompt: q.prompt,
                            options: q.options,
                            allowOther: q.allowOther,
                            impact: q.impact,
                        })} -->`,
                )
                .join("\n")}`,
            DEFAULT_CONFIG,
        );
        expect(completed.pendingQuestions).toHaveLength(2);
        return { directory, change, state: completed };
    }

    it("accepts a full valid batch and resumes the run", async () => {
        const { directory, change, state } = await setupBatchRun();
        const ids = state.pendingQuestions!.map(q => q.id);
        const result = await answerQuestionsAction(directory, change, [
            { questionId: ids[0]!, selectedOption: "a" },
            { questionId: ids[1]!, selectedOption: "d" },
        ]);
        expect(result.status).toBe("running");
        expect(result.pendingQuestions).toBeUndefined();
        expect(result.resumeTarget).toBeDefined();
        expect(result.questionHistory.filter(r => r.outcome === "answered")).toHaveLength(2);
        const ledger = await readFile(
            path.join(changeRoot(directory, change), "questions.md"),
            "utf8",
        );
        expect(ledger).toContain("# SpecOps Questions");
        expect(ledger).toContain("&lt;Q1 &amp; choose&gt;?");
        expect(ledger).not.toContain("<Q1 & choose>?");
        expect(ledger).toContain("a — A");
    });

    it("accepts Other text where allowOther is true", async () => {
        const { directory, change, state } = await setupBatchRun();
        const ids = state.pendingQuestions!.map(q => q.id);
        const result = await answerQuestionsAction(directory, change, [
            { questionId: ids[0]!, selectedOption: "a" },
            { questionId: ids[1]!, otherText: "custom expiry" },
        ]);
        expect(result.status).toBe("running");
        const q2 = result.questionHistory.find(r => r.id === ids[1]!);
        expect(q2?.otherText).toBe("custom expiry");
    });

    it("rejects an empty answer array and leaves state unchanged", async () => {
        const { directory, change } = await setupBatchRun();
        await expect(answerQuestionsAction(directory, change, [])).rejects.toThrow(
            /at least one answer/,
        );
        const reread = await readRun(directory, change);
        expect(reread.status).toBe("paused");
        expect(reread.pendingQuestions).toHaveLength(2);
    });

    it("rejects a partial batch (missing one pending question) and leaves state unchanged", async () => {
        const { directory, change, state } = await setupBatchRun();
        const ids = state.pendingQuestions!.map(q => q.id);
        await expect(
            answerQuestionsAction(directory, change, [
                { questionId: ids[0]!, selectedOption: "a" },
            ]),
        ).rejects.toThrow(/must answer every pending question/);
        const reread = await readRun(directory, change);
        expect(reread.status).toBe("paused");
        expect(reread.pendingQuestions).toHaveLength(2);
        expect(reread.questionHistory.filter(r => r.outcome === "answered")).toHaveLength(0);
    });

    it("rejects extra answers beyond the pending batch and leaves state unchanged", async () => {
        const { directory, change, state } = await setupBatchRun();
        const ids = state.pendingQuestions!.map(q => q.id);
        await expect(
            answerQuestionsAction(directory, change, [
                { questionId: ids[0]!, selectedOption: "a" },
                { questionId: ids[1]!, selectedOption: "c" },
                { questionId: "fake-id", selectedOption: "x" },
            ]),
        ).rejects.toThrow(/must answer every pending question/);
        const reread = await readRun(directory, change);
        expect(reread.pendingQuestions).toHaveLength(2);
    });

    it("rejects duplicate question ids and leaves state unchanged", async () => {
        const { directory, change, state } = await setupBatchRun();
        const ids = state.pendingQuestions!.map(q => q.id);
        await expect(
            answerQuestionsAction(directory, change, [
                { questionId: ids[0]!, selectedOption: "a" },
                { questionId: ids[0]!, selectedOption: "b" },
            ]),
        ).rejects.toThrow(/duplicate question id/);
        const reread = await readRun(directory, change);
        expect(reread.pendingQuestions).toHaveLength(2);
    });

    it("rejects unknown question ids and leaves state unchanged", async () => {
        const { directory, change, state } = await setupBatchRun();
        const ids = state.pendingQuestions!.map(q => q.id);
        await expect(
            answerQuestionsAction(directory, change, [
                { questionId: ids[0]!, selectedOption: "a" },
                { questionId: "no-such-id", selectedOption: "c" },
            ]),
        ).rejects.toThrow(/unknown or already-answered question/);
        const reread = await readRun(directory, change);
        expect(reread.pendingQuestions).toHaveLength(2);
    });

    it("rejects an answer with both selectedOption and otherText and leaves state unchanged", async () => {
        const { directory, change, state } = await setupBatchRun();
        const ids = state.pendingQuestions!.map(q => q.id);
        await expect(
            answerQuestionsAction(directory, change, [
                { questionId: ids[0]!, selectedOption: "a", otherText: "x" },
                { questionId: ids[1]!, selectedOption: "c" },
            ]),
        ).rejects.toThrow(/exactly one of selectedOption or otherText/);
        const reread = await readRun(directory, change);
        expect(reread.pendingQuestions).toHaveLength(2);
    });

    it("rejects an answer with neither selectedOption nor otherText and leaves state unchanged", async () => {
        const { directory, change, state } = await setupBatchRun();
        const ids = state.pendingQuestions!.map(q => q.id);
        await expect(
            answerQuestionsAction(directory, change, [
                { questionId: ids[0]!, selectedOption: "a" },
                { questionId: ids[1]! },
            ]),
        ).rejects.toThrow(/exactly one of selectedOption or otherText/);
        const reread = await readRun(directory, change);
        expect(reread.pendingQuestions).toHaveLength(2);
    });

    it("rejects a batch when no questions are pending", async () => {
        const { directory, change, state } = await setupBatchRun();
        // Answer the batch fully first to clear pending questions.
        const ids = state.pendingQuestions!.map(q => q.id);
        await answerQuestionsAction(directory, change, [
            { questionId: ids[0]!, selectedOption: "a" },
            { questionId: ids[1]!, selectedOption: "c" },
        ]);
        // Now no questions are pending; a second batch must be rejected.
        await expect(
            answerQuestionsAction(directory, change, [
                { questionId: ids[0]!, selectedOption: "a" },
            ]),
        ).rejects.toThrow(/no questions are pending/);
    });
});

describe("native option value round-trip", () => {
    it("a recommended option selected via its native label resolves to the canonical id", () => {
        const state = automaticState({ mode: "interactive", status: "running" });
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const q: WorkerQuestion = {
            prompt: "Which approach?",
            options: [
                { id: "simple", label: "Simple approach", recommended: true },
                { id: "complex", label: "Complex approach" },
            ],
            impact: "design",
        };
        const batch = registerPendingQuestions(state, d, [q])!;
        const directive = nextDirective(state);
        expect(directive.type).toBe("ask-question");
        if (directive.type !== "ask-question") return;
        // The native UI displays the option with label === "simple" (the id).
        // The user selects it; the controller passes that value back unchanged.
        const nativeSelectedLabel = directive.questionTools[0]!.options[0]!.label;
        expect(nativeSelectedLabel).toBe("simple");
        const record = answerQuestion(state, batch[0]!.id, nativeSelectedLabel, undefined);
        expect(record.selectedOptionId).toBe("simple");
        expect(record.outcome).toBe("answered");
    });
});

describe("multi-question dismissal and cancellation", () => {
    it("dismissing one question in a batch retains all pending questions", () => {
        const state = automaticState({ mode: "interactive" });
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        const questions: WorkerQuestion[] = [
            {
                prompt: "Q1?",
                options: [
                    { id: "a", label: "A" },
                    { id: "b", label: "B" },
                ],
                impact: "requirements",
            },
            {
                prompt: "Q2?",
                options: [
                    { id: "c", label: "C" },
                    { id: "d", label: "D" },
                ],
                impact: "requirements",
            },
        ];
        const batch = registerPendingQuestions(state, d, questions)!;
        dismissQuestion(state, batch[0]!.id);
        expect(state.status).toBe("paused");
        expect(state.pauseReason).toBe("question-dismissed");
        expect(state.pendingQuestions).toHaveLength(2);
        expect(state.questionHistory).toHaveLength(1);
        expect(state.questionHistory[0]?.outcome).toBe("dismissed");
    });

    it("run cancellation flushes the entire pending batch as cancelled", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-q-"));
        const change = "batch-cancel";
        await mkdir(changeRoot(directory, change), { recursive: true });
        const state = automaticState({ mode: "interactive" });
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        await writeRun(directory, change, state);
        const marker = [
            `<!-- specops-question: ${JSON.stringify({
                prompt: "Q1?",
                options: [
                    { id: "a", label: "A" },
                    { id: "b", label: "B" },
                ],
                impact: "requirements",
            })} -->`,
            `<!-- specops-question: ${JSON.stringify({
                prompt: "Q2?",
                options: [
                    { id: "c", label: "C" },
                    { id: "d", label: "D" },
                ],
                impact: "requirements",
            })} -->`,
        ].join("\n");
        const completed = await completeAction(
            directory,
            change,
            "d1",
            `prose\n${marker}`,
            DEFAULT_CONFIG,
        );
        expect(completed.pendingQuestions).toHaveLength(2);
        const cancelled = await cancelRun(directory, change, "User stopped.");
        expect(cancelled.status).toBe("cancelled");
        expect(cancelled.pendingQuestions).toBeUndefined();
        expect(cancelled.questionHistory.filter(r => r.outcome === "cancelled")).toHaveLength(2);
    });
});

describe("run-state version strictness", () => {
    it("rejects a v2 run-state file with version mismatch", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-reject-"));
        const change = "v2-state";
        await mkdir(changeRoot(directory, change), { recursive: true });
        const state = automaticState({ mode: "interactive" });
        const legacy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
        legacy.version = 2;
        await writeFile(
            path.join(changeRoot(directory, change), "specops-run.json"),
            `${JSON.stringify(legacy, null, 2)}\n`,
        );
        await expect(readRun(directory, change)).rejects.toThrow(/invalid SpecOps run state/);
    });

    it("rejects a v1 run-state file with version mismatch", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-reject-"));
        const change = "v1-state";
        await mkdir(changeRoot(directory, change), { recursive: true });
        const legacy = JSON.parse(JSON.stringify(automaticState())) as Record<string, unknown>;
        legacy.version = 1;
        await writeFile(
            path.join(changeRoot(directory, change), "specops-run.json"),
            `${JSON.stringify(legacy, null, 2)}\n`,
        );
        await expect(readRun(directory, change)).rejects.toThrow(/invalid SpecOps run state/);
    });

    it("rejects the prior v6 uncertainty-shaped run state", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-reject-"));
        const change = "v6-state";
        await mkdir(changeRoot(directory, change), { recursive: true });
        const legacy = JSON.parse(JSON.stringify(automaticState())) as Record<string, unknown>;
        legacy.version = 6;
        legacy.uncertainty = legacy.confidence;
        delete legacy.confidence;
        await writeFile(
            path.join(changeRoot(directory, change), "specops-run.json"),
            `${JSON.stringify(legacy, null, 2)}\n`,
        );
        await expect(readRun(directory, change)).rejects.toThrow(/invalid SpecOps run state/);
    });

    it("rejects a current-version file missing required persistent fields", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-reject-"));
        const change = "missing-fields";
        await mkdir(changeRoot(directory, change), { recursive: true });
        const partial = JSON.parse(JSON.stringify(automaticState())) as Record<string, unknown>;
        delete partial.reviewSubmissions;
        delete partial.repairTasks;
        delete partial.frontierPolicy;
        delete partial.frontierUsage;
        delete partial.frontierHistory;
        delete partial.checkpointHistory;
        await writeFile(
            path.join(changeRoot(directory, change), "specops-run.json"),
            `${JSON.stringify(partial, null, 2)}\n`,
        );
        await expect(readRun(directory, change)).rejects.toThrow(/invalid SpecOps run state/);
    });

    it("rejects a superseded singular pendingQuestion state shape", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-reject-"));
        const change = "legacy-singular";
        await mkdir(changeRoot(directory, change), { recursive: true });
        const state = automaticState({ mode: "interactive" });
        const d = dispatch("d1", "planning");
        state.dispatches.push(d);
        registerPendingQuestions(state, d, [
            {
                prompt: "legacy?",
                options: [
                    { id: "a", label: "A" },
                    { id: "b", label: "B" },
                ],
                impact: "requirements",
            },
        ]);
        const legacyRaw = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
        const pendingArr = legacyRaw.pendingQuestions as unknown[];
        legacyRaw.pendingQuestion = pendingArr[0];
        delete legacyRaw.pendingQuestions;
        await writeFile(
            path.join(changeRoot(directory, change), "specops-run.json"),
            `${JSON.stringify(legacyRaw, null, 2)}\n`,
        );
        await expect(readRun(directory, change)).rejects.toThrow();
    });
});

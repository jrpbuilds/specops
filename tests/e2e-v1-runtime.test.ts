import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acceptValidationCommands } from "../src/validation/commands.js";
import { canonicalCommandHash } from "../src/validation/registry.js";
import { persistValidationEvidence, readValidationEvidence } from "../src/validation/evidence.js";
import type { ValidationCommand } from "../src/validation/registry.js";
import type { ValidationEvidence } from "../src/validation/executor.js";
import { readV1Run, updateV1Run, createV1Run } from "../src/state/store.js";
import { explorationPath, reviewPath } from "../src/state/paths.js";
import {
    startOrResumePlanning,
    type CoordinatorOpenSpecAdapter,
    type CoordinatorOptions,
} from "../src/workflow/coordinator.js";
import {
    runImplementation,
    type ImplementationAgentRequest,
    type ImplementationArtifacts,
    type ImplementationBlocker,
} from "../src/workflow/implementation.js";
import { runReview, type ReviewAgentRequest } from "../src/workflow/review.js";
import {
    resolveCompletion,
    resumeVerified,
    type CompletionOptions,
} from "../src/workflow/finalize.js";
import type { OpenSpecArchiveResult } from "../src/openspec/archive.js";
import type { OpenSpecChangeStatus } from "../src/openspec/status.js";
import type { OpenSpecInstructions } from "../src/openspec/instructions.js";
import type { OpenSpecValidationResult } from "../src/openspec/validation.js";
import type { PlanningAgentRequest } from "../src/workflow/planning.js";
import type { RepositoryMutation } from "../src/repository/changes.js";

/** Worker result returned by the fake implementer; `blocker` is a real blocker. */
type ImplementerResult =
    { kind: "completed" } | { kind: "blocker"; blocker: ImplementationBlocker };

const change = "e2e-runtime";
const identity = "a".repeat(64);
const changedIdentity = "b".repeat(64);
const command: ValidationCommand = {
    id: "typecheck",
    executable: "node",
    args: ["--version"],
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
};
const tasksContent = "- [x] 1.1 Implement the feature\n";

async function directory(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "specops-e2e-runtime-"));
}

function validation(valid: boolean, issues: unknown[] = []): OpenSpecValidationResult {
    return { valid, issues, raw: { items: [{ valid, issues }] } };
}

function evidence(overrides: Partial<ValidationEvidence> = {}): ValidationEvidence {
    return {
        commandId: command.id,
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
        repositoryIdentity: identity,
        outputHash: "c".repeat(64),
        commandDefinitionHash: canonicalCommandHash(command),
        ...overrides,
    };
}

function reviewMarkdown(
    verdict: "pass" | "changes-required" = "pass",
    reviewed = identity,
): string {
    const blocking =
        verdict === "changes-required" ? "- BF-01: the implementation is incomplete" : "None.";
    return [
        "## Verdict\n" + verdict,
        "## Reviewed state\nRepository identity: " + reviewed,
        "## Validation\ntypecheck passed.",
        "## Blocking findings\n" + blocking,
        "## Non-blocking observations\n- Consider a follow-up.",
        "## Conclusion\nReviewed independently.",
    ].join("\n\n");
}

/**
 * Deterministic OpenSpec adapter implementing the full coordinator surface.
 * The `completed` set drives artifact readiness; the `validations` queue
 * drives each `validate()` result; `archiveResult` drives the archive gate.
 */
class FakeAdapter implements CoordinatorOpenSpecAdapter {
    created = false;
    completed = new Set<string>();
    validations: OpenSpecValidationResult[];
    archiveResult: OpenSpecArchiveResult;
    archiveError?: Error;

    constructor(
        validations: OpenSpecValidationResult[] = [],
        archiveResult: OpenSpecArchiveResult = { success: true, code: 0, stdout: "{}", stderr: "" },
    ) {
        this.validations = validations;
        this.archiveResult = archiveResult;
    }

    async version(): Promise<string> {
        return "1.7.0";
    }

    async assertStandardSchema(): Promise<string> {
        return "spec-driven";
    }

    async createChange(): Promise<void> {
        this.created = true;
    }

    async status(requestedChange: string): Promise<OpenSpecChangeStatus> {
        if (!this.created) throw new Error("change not found");
        const artifacts = ["proposal", "specs", "design", "tasks"] as const;
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
        };
    }

    async instructions(artifact: string, requestedChange: string): Promise<OpenSpecInstructions> {
        return {
            artifactId: artifact,
            schemaName: "spec-driven",
            outputPath: `${artifact}.md`,
            resolvedOutputPath: `/project/openspec/changes/${requestedChange}/${artifact}.md`,
            description: `${artifact} instructions`,
            instruction: `OpenSpec instructions for ${artifact}`,
            template: "",
            dependencies: [],
        };
    }

    async validate(): Promise<OpenSpecValidationResult> {
        return this.validations.shift() ?? validation(true);
    }

    async archive(): Promise<OpenSpecArchiveResult> {
        if (this.archiveError) throw this.archiveError;
        return this.archiveResult;
    }
}

const artifacts: ImplementationArtifacts = {
    exploration: "# Exploration\n",
    proposal: "# Proposal\n",
    specs: "# Specs\n",
    design: "# Design\n",
    tasks: tasksContent,
};

type Harness = {
    root: string;
    adapter: FakeAdapter;
    plannerRequests: PlanningAgentRequest[];
    reviewerRequests: ReviewAgentRequest[];
    implementerRequests: ImplementationAgentRequest[];
    coordinator: CoordinatorOptions;
    completion: CompletionOptions;
    setReview: (markdown: string) => Promise<void>;
    setTasks: (content: string) => Promise<void>;
};

async function harness(
    root: string,
    overrides: {
        adapter?: FakeAdapter;
        implementerResult?: () => Promise<ImplementerResult>;
        reviewerVerdict?: "pass" | "changes-required";
        detectMutation?: (previous: string) => Promise<RepositoryMutation>;
        validationProcess?: () => Promise<ValidationEvidence>;
    } = {},
): Promise<Harness> {
    const adapter = overrides.adapter ?? new FakeAdapter();
    const plannerRequests: PlanningAgentRequest[] = [];
    const reviewerRequests: ReviewAgentRequest[] = [];
    const implementerRequests: ImplementationAgentRequest[] = [];
    const verdict = overrides.reviewerVerdict ?? "pass";

    await mkdir(path.dirname(explorationPath(root, change)), { recursive: true });
    await writeFile(explorationPath(root, change), "# Exploration\n");
    await mkdir(path.dirname(reviewPath(root, change)), { recursive: true });
    await writeFile(reviewPath(root, change), reviewMarkdown(verdict));

    const tasksDir = path.join(root, "openspec", "changes", change);
    await mkdir(tasksDir, { recursive: true });
    await writeFile(path.join(tasksDir, "tasks.md"), tasksContent);

    const noMutation = (previous: string): RepositoryMutation => ({
        previous,
        current: identity,
        changed: false,
        files: [],
    });
    const detect = (previous: string) =>
        Promise.resolve(
            overrides.detectMutation ? overrides.detectMutation(previous) : noMutation(previous),
        );
    const executeCommand = async (
        _dir: string,
        _configured: ValidationCommand,
        repositoryIdentity: string,
    ) =>
        overrides.validationProcess
            ? overrides.validationProcess()
            : evidence({ repositoryIdentity });

    const coordinator: CoordinatorOptions = {
        directory: root,
        adapter,
        captureBaseline: async () => ({ identity, changedFiles: [] }),
        explorer: {
            run: async () => {
                await mkdir(path.dirname(explorationPath(root, change)), { recursive: true });
                await writeFile(explorationPath(root, change), "# Exploration\n");
            },
        },
        planners: {
            run: async request => {
                plannerRequests.push(request);
                adapter.completed.add(request.artifact);
            },
        },
        implementation: {
            commands: acceptValidationCommands([command]),
            implementer: {
                run: async request => {
                    implementerRequests.push(request);
                    return (
                        overrides.implementerResult?.() ??
                        (await Promise.resolve({ kind: "completed" as const }))
                    );
                },
            },
            frontier: { run: async () => ({ advice: "frontier advice" }) },
            loadArtifacts: async () => artifacts,
            loadPrompt: () => "implementer prompt",
            detectMutation: async (_dir, previous) => detect(previous),
            executeCommand,
            notifyMutation: async () => {},
        },
        review: {
            reviewer: {
                run: async request => {
                    reviewerRequests.push(request);
                    await mkdir(path.dirname(reviewPath(root, change)), { recursive: true });
                    await writeFile(reviewPath(root, change), reviewMarkdown(verdict, identity));
                },
            },
            implementation: {
                commands: acceptValidationCommands([command]),
                implementer: {
                    run: async request => {
                        implementerRequests.push(request);
                        return (
                            overrides.implementerResult?.() ??
                            (await Promise.resolve({ kind: "completed" as const }))
                        );
                    },
                },
                frontier: { run: async () => ({ advice: "frontier advice" }) },
                loadArtifacts: async () => artifacts,
                loadPrompt: () => "implementer prompt",
                detectMutation: async (_dir, previous) => detect(previous),
                executeCommand,
            },
            loadArtifacts: async () => artifacts,
            loadPrompt: () => "reviewer prompt",
            currentDiff: async () => "diff",
            summarizeChanges: async () => [
                {
                    path: "src/index.ts",
                    staged: true,
                    modified: false,
                    deleted: false,
                    untracked: false,
                },
            ],
            calculateIdentity: async () => identity,
            readEvidence: async (_dir, c) => safeEvidence(root, c),
            readReview: async (_dir, c) => readFile(reviewPath(root, c), "utf8"),
        },
        finalize: {
            calculateIdentity: async () => identity,
            readEvidence: async (_dir, c) => safeEvidence(root, c),
            readReview: async (_dir, c) => readFile(reviewPath(root, c), "utf8"),
            loadTasks: async (_dir, c) =>
                readFile(path.join(root, "openspec", "changes", c, "tasks.md"), "utf8"),
        },
        recover: async (dir, c) => ({ state: await readV1Run(dir, c) }),
    };

    const completion: CompletionOptions = {
        directory: root,
        adapter,
        requiredCommands: acceptValidationCommands([command]).required,
        implementation: coordinator.implementation,
        review: coordinator.review,
        calculateIdentity: async () => identity,
        readEvidence: async (_dir, c) => safeEvidence(root, c),
        readReview: async (_dir, c) => readFile(reviewPath(root, c), "utf8"),
        loadTasks: async (_dir, c) =>
            readFile(path.join(root, "openspec", "changes", c, "tasks.md"), "utf8"),
    };

    return {
        root,
        adapter,
        plannerRequests,
        reviewerRequests,
        implementerRequests,
        coordinator,
        completion,
        setReview: async markdown => {
            await mkdir(path.dirname(reviewPath(root, change)), { recursive: true });
            await writeFile(reviewPath(root, change), markdown);
        },
        setTasks: async content => {
            const dir = path.join(root, "openspec", "changes", change);
            await mkdir(dir, { recursive: true });
            await writeFile(path.join(dir, "tasks.md"), content);
        },
    };
}

async function safeEvidence(root: string, change: string): Promise<ValidationEvidence[]> {
    try {
        return await readValidationEvidence(root, change);
    } catch {
        return [];
    }
}

async function runToImplementation(root: string, h: Harness) {
    const planning = await startOrResumePlanning(h.coordinator, { change, goal: "E2E runtime" });
    if (planning.kind !== "checkpoint")
        throw new Error(`planning did not reach checkpoint: ${planning.kind}`);
    await persistValidationEvidence(root, change, evidence());
    const state = await updateV1Run(root, change, s => ({
        ...s,
        status: "active",
        stage: "implementation",
        currentRepositoryState: identity,
    }));
    return runImplementation(
        { ...h.coordinator.implementation!, directory: root, adapter: h.adapter },
        state,
    );
}

/**
 * B-12 repair (task 12.4.2): real deterministic runtime end-to-end tests
 * exercising every required V1 scenario through the active workflow surface
 * (coordinator, planning, implementation, review, finalisation). Each
 * scenario drives the registered-tool entry functions with deterministic
 * agent and OpenSpec fakes and asserts the bounded outcome.
 */
describe("V1 end-to-end release scenarios (real runtime)", () => {
    it("trivial bug fix: implementation completes and reaches review", async () => {
        const root = await directory();
        const h = await harness(root);
        const result = await runToImplementation(root, h);
        expect(result.kind).toBe("ready-for-review");
    });

    it("small feature: planning authors every artifact in order", async () => {
        const root = await directory();
        const h = await harness(root);
        const result = await startOrResumePlanning(h.coordinator, {
            change,
            goal: "small feature",
        });
        expect(result.kind).toBe("checkpoint");
        expect(h.plannerRequests.map(r => r.artifact)).toEqual([
            "proposal",
            "specs",
            "design",
            "tasks",
        ]);
    });

    it("multi-file feature: implementation receives complete approved artifacts", async () => {
        const root = await directory();
        const h = await harness(root);
        const result = await runToImplementation(root, h);
        expect(result.kind).toBe("ready-for-review");
        expect(h.implementerRequests[0].artifacts).toEqual(artifacts);
    });

    it("design-heavy change: planner authors proposal, specs, design, tasks in order", async () => {
        const root = await directory();
        const h = await harness(root);
        await startOrResumePlanning(h.coordinator, { change, goal: "design-heavy" });
        expect(h.plannerRequests.map(r => r.artifact)).toEqual([
            "proposal",
            "specs",
            "design",
            "tasks",
        ]);
        expect(h.plannerRequests.every(r => r.kind === "initial")).toBe(true);
    });

    it("invalid proposal correction: planning succeeds after one correction", async () => {
        const root = await directory();
        const adapter = new FakeAdapter([
            validation(false, [{ message: "missing Why" }]),
            validation(true),
        ]);
        const h = await harness(root, { adapter });
        await startOrResumePlanning(h.coordinator, { change, goal: "correct proposal" });
        const proposalRequests = h.plannerRequests.filter(r => r.artifact === "proposal");
        expect(proposalRequests).toHaveLength(2);
        expect(proposalRequests[1].kind).toBe("correction");
    });

    it("invalid spec correction: planning pauses after exhausting corrections", async () => {
        const root = await directory();
        const adapter = new FakeAdapter([
            validation(true),
            validation(false, ["err1"]),
            validation(false, ["err2"]),
            validation(false, ["err3"]),
        ]);
        const h = await harness(root, { adapter });
        const result = await startOrResumePlanning(h.coordinator, { change, goal: "spec fix" });
        expect(result.kind).toBe("correction-exhausted");
        if (result.kind === "correction-exhausted") {
            expect(result.artifact).toBe("specs");
        }
        const state = await readV1Run(root, change);
        expect(state.stage).toBe("specs");
        expect(state.status).toBe("awaiting-user");
    });

    it("failed project validation: implementation routes failed command evidence as a blocker", async () => {
        const root = await directory();
        const h = await harness(root, {
            validationProcess: async () =>
                evidence({
                    exitCode: 1,
                    stderr: "typecheck failed",
                    repositoryIdentity: identity,
                }),
        });
        const result = await runToImplementation(root, h);
        expect(result.kind).toBe("blocked");
    });

    it("blocking review followed by repair: reviewer requests repair then passes", async () => {
        const root = await directory();
        let reviewCount = 0;
        const h = await harness(root);
        await createV1Run(root, {
            change,
            goal: "review repair",
            baselineRepositoryState: identity,
        });
        await updateV1Run(root, change, s => ({
            ...s,
            status: "active",
            stage: "review",
            currentRepositoryState: identity,
            validatedRepositoryState: identity,
        }));
        await persistValidationEvidence(root, change, evidence());
        const reviewOpts = { ...h.coordinator.review!, directory: root, adapter: h.adapter };
        reviewOpts.reviewer = {
            run: async request => {
                h.reviewerRequests.push(request);
                reviewCount++;
                // First review requests changes; the repair loop re-validates
                // and re-reviews, where the second review passes.
                await h.setReview(
                    reviewCount === 1
                        ? reviewMarkdown("changes-required", identity)
                        : reviewMarkdown("pass", identity),
                );
            },
        };
        const result = await runReview(reviewOpts, await readV1Run(root, change));
        expect(result.kind).toBe("ready-for-completion");
        expect(reviewCount).toBeGreaterThanOrEqual(2);
    });

    it("correction exhaustion: planning pauses after two failed corrections", async () => {
        const root = await directory();
        const adapter = new FakeAdapter([
            validation(false, ["a"]),
            validation(false, ["b"]),
            validation(false, ["c"]),
        ]);
        const h = await harness(root, { adapter });
        const result = await startOrResumePlanning(h.coordinator, { change, goal: "exhaust" });
        expect(result.kind).toBe("correction-exhausted");
    });

    it("material user question: planning routes a material-decision blocker", async () => {
        const root = await directory();
        const h = await harness(root, {
            implementerResult: async () => ({
                kind: "blocker",
                blocker: {
                    kind: "material-decision",
                    prompt: "which auth?",
                    outcomes: ["jwt", "session"],
                    repositoryResolvable: false,
                    affectsMaterialOutcome: true,
                    reversibleLowRiskAssumptionAvailable: false,
                },
            }),
        });
        const result = await runToImplementation(root, h);
        expect(result.kind).toBe("material-question");
    });

    it("planning feedback: feedback routes to artifact owners and revalidates", async () => {
        const root = await directory();
        const h = await harness(root);
        const planning = await startOrResumePlanning(h.coordinator, { change, goal: "feedback" });
        expect(planning.kind).toBe("checkpoint");
        const { applyPlanningFeedback } = await import("../src/workflow/planning.js");
        const feedbackResult = await applyPlanningFeedback(
            {
                directory: root,
                adapter: h.adapter,
                agents: h.coordinator.planners!,
                implementation: h.coordinator.implementation,
            },
            await readV1Run(root, change),
            { proposal: "tighten the why" },
        );
        expect(feedbackResult.kind).toBe("checkpoint");
    });

    it("completion feedback: request-implementation-changes routes back to implementation", async () => {
        const root = await directory();
        const h = await harness(root);
        await runToImplementation(root, h);
        await updateV1Run(root, change, s => ({
            ...s,
            status: "awaiting-user",
            stage: "archive",
            currentRepositoryState: identity,
            validatedRepositoryState: identity,
            reviewedRepositoryState: identity,
        }));
        await persistValidationEvidence(root, change, evidence());
        const implementerCallsBefore = h.implementerRequests.length;
        const result = await resolveCompletion(h.completion, await readV1Run(root, change), {
            kind: "request-implementation-changes",
            feedback: "add tests",
        });
        expect(result.kind).toBe("request-changes");
        // The feedback re-drove the implementer through the runtime path.
        expect(h.implementerRequests.length).toBeGreaterThan(implementerCallsBefore);
    });

    it("dirty working tree: baseline captures and run proceeds", async () => {
        const root = await directory();
        const h = await harness(root);
        h.coordinator.captureBaseline = async () => ({
            identity,
            changedFiles: [
                {
                    path: "src/x.ts",
                    staged: true,
                    modified: false,
                    deleted: false,
                    untracked: false,
                },
            ],
        });
        const result = await startOrResumePlanning(h.coordinator, { change, goal: "dirty tree" });
        expect(result.kind).toBe("checkpoint");
    });

    it("external repository mutation: implementation detects and surfaces the mutation", async () => {
        const root = await directory();
        const h = await harness(root, {
            detectMutation: async previous => ({
                previous,
                current: changedIdentity,
                changed: true,
                files: [
                    {
                        path: "src/y.ts",
                        staged: false,
                        modified: true,
                        deleted: false,
                        untracked: false,
                    },
                ],
            }),
        });
        const result = await runToImplementation(root, h);
        expect(result.kind).toBe("external-mutation");
    });

    it("interrupted run and resume: coordinator resumes the persisted stage", async () => {
        const root = await directory();
        const h = await harness(root);
        const first = await startOrResumePlanning(h.coordinator, { change, goal: "resume" });
        expect(first.kind).toBe("checkpoint");
        const resumed = await startOrResumePlanning(h.coordinator, { change, goal: "resume" });
        expect(resumed.resumed).toBe(true);
    });

    it("archive failure and retry: failed archive returns to completion checkpoint", async () => {
        const root = await directory();
        const adapter = new FakeAdapter([], {
            success: false,
            code: 1,
            stdout: "",
            stderr: "archive failed",
        });
        const h = await harness(root, { adapter });
        await runToImplementation(root, h);
        await persistValidationEvidence(root, change, evidence());
        const reviewState = await updateV1Run(root, change, s => ({
            ...s,
            status: "awaiting-user",
            stage: "archive",
            currentRepositoryState: identity,
            validatedRepositoryState: identity,
            reviewedRepositoryState: identity,
        }));
        void reviewState;
        const first = await resolveCompletion(h.completion, await readV1Run(root, change), {
            kind: "complete-and-archive",
        });
        expect(first.kind).toBe("archive-failed");
        const state = await readV1Run(root, change);
        expect(state.stage).toBe("archive");
        adapter.archiveResult = { success: true, code: 0, stdout: "{}", stderr: "" };
        const second = await resolveCompletion(h.completion, await readV1Run(root, change), {
            kind: "complete-and-archive",
        });
        expect(second.kind).toBe("completed");
    });

    it("verified-open resume: verified run resumes to archive when unchanged", async () => {
        const root = await directory();
        const h = await harness(root);
        await runToImplementation(root, h);
        await persistValidationEvidence(root, change, evidence());
        await updateV1Run(root, change, s => ({
            ...s,
            status: "awaiting-user",
            stage: "archive",
            currentRepositoryState: identity,
            validatedRepositoryState: identity,
            reviewedRepositoryState: identity,
        }));
        const verified = await resolveCompletion(h.completion, await readV1Run(root, change), {
            kind: "leave-change-open",
        });
        expect(verified.kind).toBe("verified");
        const resumed = await resumeVerified(h.completion, await readV1Run(root, change));
        expect(resumed.kind).toBe("verified-resumed");
    });

    it("successful archive: complete-and-archive archives and marks completed", async () => {
        const root = await directory();
        const h = await harness(root);
        await runToImplementation(root, h);
        await persistValidationEvidence(root, change, evidence());
        await updateV1Run(root, change, s => ({
            ...s,
            status: "awaiting-user",
            stage: "archive",
            currentRepositoryState: identity,
            validatedRepositoryState: identity,
            reviewedRepositoryState: identity,
        }));
        const result = await resolveCompletion(h.completion, await readV1Run(root, change), {
            kind: "complete-and-archive",
        });
        expect(result.kind).toBe("completed");
        const state = await readV1Run(root, change);
        expect(state.status).toBe("completed");
        expect(state.archivedAt).not.toBeNull();
    });
});

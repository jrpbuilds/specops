import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../src/agents/ids.js";
import { AGENT_PERMISSIONS, ownedPathPatterns } from "../src/agents/permissions.js";
import { parseReview } from "../src/review/parser.js";
import { createV1Run, readV1Run, updateV1Run } from "../src/state/store.js";
import { acceptValidationCommands } from "../src/validation/commands.js";
import { canonicalCommandHash } from "../src/validation/registry.js";
import { persistValidationEvidence } from "../src/validation/evidence.js";
import type { ValidationEvidence } from "../src/validation/executor.js";
import type { ValidationCommand } from "../src/validation/registry.js";
import type {
    ImplementationAgentRequest,
    ImplementationArtifacts,
} from "../src/workflow/implementation.js";
import {
    runReview,
    type ReviewAgentRequest,
    type ReviewWorkflowOptions,
} from "../src/workflow/review.js";
import { planningIdentityFromArtifacts } from "../src/workflow/planning-identity.js";

const change = "review-test";
const identity = "a".repeat(64);
const changedIdentity = "b".repeat(64);
const command: ValidationCommand = {
    id: "typecheck",
    executable: "node",
    args: ["--version"],
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
};
const artifacts: ImplementationArtifacts = {
    exploration: "# Exploration\n",
    proposal: "# Proposal\n",
    specs: "# Specs\n",
    design: "# Design\n",
    tasks: "- [x] 1.1 Implement review\n",
};
const planningIdentity = planningIdentityFromArtifacts(change, artifacts);

async function directory(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "specops-review-"));
}

async function reviewState(root: string): Promise<void> {
    await createV1Run(root, {
        change,
        goal: "Review the approved change",
        baselineRepositoryState: identity,
    });
    await updateV1Run(root, change, state => ({
        ...state,
        stage: "review",
        currentRepositoryState: identity,
        validatedRepositoryState: identity,
    }));
    await persistValidationEvidence(root, change, evidence());
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

function review(
    verdict: "pass" | "changes-required" | "unknown",
    reviewedIdentity = identity,
    blocking = "None.",
    omit?: string,
    reviewedPlanningIdentity: string = planningIdentity,
): string {
    const sections = [
        ["Verdict", verdict],
        [
            "Reviewed state",
            `Repository identity: ${reviewedIdentity}\nPlanning artifacts: ${reviewedPlanningIdentity}`,
        ],
        ["Validation", "typecheck passed."],
        ["Blocking findings", blocking],
        ["Non-blocking observations", "- Consider a follow-up."],
        ["Conclusion", "Reviewed independently."],
    ];
    return sections
        .filter(([heading]) => heading !== omit)
        .map(([heading, body]) => `## ${heading}\n${body}`)
        .join("\n\n");
}

function options(
    root: string,
    reports: string[],
    overrides: Partial<ReviewWorkflowOptions> = {},
): ReviewWorkflowOptions & {
    reviewerRequests: ReviewAgentRequest[];
    implementerRequests: ImplementationAgentRequest[];
} {
    const reviewerRequests: ReviewAgentRequest[] = [];
    const implementerRequests: ImplementationAgentRequest[] = [];
    let latest = "";
    return {
        directory: root,
        adapter: { status: async () => ({}) as never },
        reviewer: {
            run: async request => {
                reviewerRequests.push(request);
                latest = reports.shift() ?? "";
            },
        },
        implementation: {
            commands: acceptValidationCommands([command]),
            implementer: {
                run: async request => {
                    implementerRequests.push(request);
                    return { kind: "completed" };
                },
            },
            frontier: { run: async () => ({ advice: "not used by review repairs" }) },
            loadArtifacts: async () => artifacts,
            loadPrompt: () => "Implement the review correction.",
            detectMutation: async (_directory, previous) => ({
                previous,
                current: previous,
                changed: false,
                files: [],
            }),
            executeCommand: async (_directory, _configured, repositoryIdentity) =>
                evidence({ repositoryIdentity }),
        },
        loadArtifacts: async () => artifacts,
        loadPrompt: () => "Review independently.",
        currentDiff: async () => "diff --git a/src/file.ts b/src/file.ts",
        summarizeChanges: async () => [
            {
                path: "src/file.ts",
                staged: false,
                modified: true,
                deleted: false,
                untracked: false,
            },
        ],
        calculateIdentity: async () => identity,
        readReview: async () => latest,
        ...overrides,
        reviewerRequests,
        implementerRequests,
    };
}

describe("review format parser", () => {
    it("parses only blocking IDs and ignores non-blocking observations", () => {
        const parsed = parseReview(
            review(
                "changes-required",
                identity,
                "- ID: REVIEW-1 - correct the failing path\n- REVIEW_2: add coverage",
            ),
        );

        expect(parsed).toMatchObject({
            verdict: "changes-required",
            reviewedRepositoryState: identity,
            blockingFindingIds: ["REVIEW-1", "REVIEW_2"],
        });
        expect(parsed.sections).toHaveLength(6);
    });
});

describe("V1 review workflow", () => {
    it("passes one fully contextual, read-only reviewer to the completion boundary", async () => {
        const root = await directory();
        await reviewState(root);
        const context = options(root, [review("pass")]);

        await expect(runReview(context, await readV1Run(root, change))).resolves.toMatchObject({
            kind: "ready-for-completion",
            state: { status: "awaiting-user", stage: "archive", reviewedRepositoryState: identity },
        });
        expect(context.reviewerRequests).toHaveLength(1);
        expect(context.reviewerRequests[0]).toMatchObject({
            agent: AGENT_IDS.reviewer,
            goal: "Review the approved change",
            artifacts,
            diff: "diff --git a/src/file.ts b/src/file.ts",
            changedFiles: [{ path: "src/file.ts" }],
            repositoryIdentity: identity,
            validationEvidence: [expect.objectContaining({ commandId: command.id })],
            readOnly: true,
            writePath: expect.stringMatching(/\.specops\/runs\/review-test\/review\.md$/),
        });
    });

    it("rejects malformed verdicts and missing sections without discarding fresh validation", async () => {
        for (const report of [review("unknown"), review("pass", identity, "None.", "Conclusion")]) {
            const root = await directory();
            await reviewState(root);
            const context = options(root, [report]);
            await expect(runReview(context, await readV1Run(root, change))).resolves.toMatchObject({
                kind: "invalid-review",
                state: {
                    stage: "review",
                    reviewedRepositoryState: null,
                    validatedRepositoryState: identity,
                },
            });
        }
    });

    it("invalidates stale reviewed identity", async () => {
        const root = await directory();
        await reviewState(root);

        await expect(
            runReview(
                options(root, [review("pass", changedIdentity)]),
                await readV1Run(root, change),
            ),
        ).resolves.toMatchObject({
            kind: "review-invalidated",
            state: { stage: "review", reviewedRepositoryState: null },
        });
    });

    it("rejects missing, stale, and incomplete required validation before reviewer invocation", async () => {
        for (const records of [
            [],
            [
                evidence({
                    invalidatedAt: "2026-01-01T00:00:02.000Z",
                    invalidatedBy: changedIdentity,
                }),
            ],
            [evidence({ exitCode: 1 })],
        ]) {
            const root = await directory();
            await reviewState(root);
            const context = options(root, [review("pass")], { readEvidence: async () => records });

            await expect(runReview(context, await readV1Run(root, change))).resolves.toMatchObject({
                kind: "review-invalidated",
            });
            expect(context.reviewerRequests).toHaveLength(0);
        }
    });

    it("passes all blocking finding IDs to the existing implementer then revalidates and rereviews", async () => {
        const root = await directory();
        await reviewState(root);
        const context = options(root, [
            review("changes-required", identity, "- ID: BUG-1 - fix one\n- ID: BUG-2 - fix two"),
            review("pass"),
        ]);

        await expect(runReview(context, await readV1Run(root, change))).resolves.toMatchObject({
            kind: "ready-for-completion",
            state: { repairAttempts: 1, reviewedRepositoryState: identity },
        });
        expect(context.implementerRequests).toHaveLength(1);
        expect(context.implementerRequests[0]).toMatchObject({
            agent: AGENT_IDS.implementer,
            kind: "review-repair",
            reviewBlockingFindingIds: ["BUG-1", "BUG-2"],
        });
        expect(context.reviewerRequests).toHaveLength(2);
    });

    it("returns failed repair validation to the implementer before a fresh review", async () => {
        const root = await directory();
        await reviewState(root);
        let runs = 0;
        const context = options(root, [
            review("changes-required", identity, "- ID: BUG-1 - fix it"),
            review("pass"),
        ]);
        context.implementation.executeCommand = async (
            _directory,
            _configured,
            repositoryIdentity,
        ) => evidence({ repositoryIdentity, exitCode: ++runs === 1 ? 1 : 0 });

        await expect(runReview(context, await readV1Run(root, change))).resolves.toMatchObject({
            kind: "ready-for-completion",
        });
        expect(context.implementerRequests.map(request => request.kind)).toEqual([
            "review-repair",
            "validation-fix",
        ]);
        expect(context.reviewerRequests).toHaveLength(2);
    });

    it("blocks after two unresolved repairs while retaining the review and validation diagnostics", async () => {
        const root = await directory();
        await reviewState(root);
        const report = review("changes-required", identity, "- ID: BUG-1 - fix it");
        const context = options(root, [report, report, report]);

        await expect(runReview(context, await readV1Run(root, change))).resolves.toMatchObject({
            kind: "blocked",
            state: { status: "blocked", stage: "repair", repairAttempts: 2 },
            message: expect.stringContaining("retry with a new run"),
        });
        expect(
            context.implementerRequests.filter(request => request.kind === "review-repair"),
        ).toHaveLength(2);
    });

    it("invalidates the review when the repository mutates after reviewer inspection", async () => {
        const root = await directory();
        await reviewState(root);
        let calls = 0;
        const context = options(root, [review("pass")], {
            calculateIdentity: async () => (++calls === 1 ? identity : changedIdentity),
        });

        await expect(runReview(context, await readV1Run(root, change))).resolves.toMatchObject({
            kind: "review-invalidated",
            state: { validatedRepositoryState: null, reviewedRepositoryState: null },
        });
    });

    it("uses only the reviewer and existing implementer; reviewer permissions allow only review.md", () => {
        expect(AGENT_PERMISSIONS[AGENT_IDS.reviewer]).toMatchObject({
            bash: "deny",
            edit: "ask",
            task: "deny",
        });
        expect(ownedPathPatterns(AGENT_IDS.reviewer, { change })).toEqual([
            ".specops/runs/review-test/review.md",
        ]);
        expect(AGENT_IDS).not.toHaveProperty("tribunal");
        expect(AGENT_IDS).not.toHaveProperty("repairer");
    });
});

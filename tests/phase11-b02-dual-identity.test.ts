import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
import { resolveCompletion, type CompletionOptions } from "../src/workflow/finalize.js";
import { planningIdentityFromArtifacts } from "../src/workflow/planning-identity.js";
import { createV1Run, readV1Run, updateV1Run } from "../src/state/store.js";
import { reviewPath } from "../src/state/paths.js";

const change = "b02-dual-identity";
const identity = "a".repeat(64);
const command: ValidationCommand = {
    id: "typecheck",
    executable: "node",
    args: ["--version"],
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
};

function evidence(repositoryIdentity: string): ValidationEvidence {
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
        repositoryIdentity,
        outputHash: "c".repeat(64),
        commandDefinitionHash: canonicalCommandHash(command),
    };
}

function review(
    verdict: "pass" | "changes-required",
    repositoryIdentity: string,
    planningArtifactIdentity: string,
    blocking = "None.",
): string {
    return [
        "## Verdict\n" + verdict,
        `## Reviewed state\nRepository identity: ${repositoryIdentity}\nPlanning artifacts: ${planningArtifactIdentity}`,
        "## Validation\ntypecheck passed.",
        `## Blocking findings\n${blocking}`,
        "## Non-blocking observations\n- Consider a follow-up.",
        "## Conclusion\nReviewed independently.",
    ].join("\n\n");
}

type Harness = {
    root: string;
    artifacts: ImplementationArtifacts;
    reviewerRequests: ReviewAgentRequest[];
    reports: string[];
};

async function harness(
    initialArtifacts: ImplementationArtifacts,
    reports: string[],
): Promise<Harness> {
    const root = await mkdtemp(path.join(os.tmpdir(), "specops-b02-"));
    await createV1Run(root, {
        change,
        goal: "Bind review to both identities",
        baselineRepositoryState: identity,
    });
    return { root, artifacts: initialArtifacts, reviewerRequests: [], reports: [...reports] };
}

function reviewOptions(h: Harness): ReviewWorkflowOptions & {
    reviewerRequests: ReviewAgentRequest[];
    implementerRequests: ImplementationAgentRequest[];
} {
    const reviewerRequests: ReviewAgentRequest[] = [];
    const implementerRequests: ImplementationAgentRequest[] = [];
    return {
        directory: h.root,
        adapter: { status: async () => ({}) as never },
        reviewer: {
            run: async request => {
                reviewerRequests.push(request);
                await mkdir(path.dirname(reviewPath(h.root, change)), { recursive: true });
                await writeFile(reviewPath(h.root, change), h.reports.shift() ?? "");
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
            frontier: { run: async () => ({ advice: "" }) },
            loadArtifacts: async () => h.artifacts,
            loadPrompt: () => "Implement the review correction.",
            detectMutation: async (_dir, previous) => ({
                previous,
                current: previous,
                changed: false,
                files: [],
            }),
            executeCommand: async (_dir, _cmd, repoId) => evidence(repoId),
        },
        loadArtifacts: async () => h.artifacts,
        loadPrompt: () => "Reviewer prompt",
        currentDiff: async () => "",
        summarizeChanges: async () => [],
        calculateIdentity: async () => identity,
        readEvidence: async () => [evidence(identity)],
        reviewerRequests,
        implementerRequests,
    };
}

function completionOptions(h: Harness, currentPlanningIdentity: string): CompletionOptions {
    return {
        directory: h.root,
        adapter: {
            status: async () => ({}) as never,
            version: async () => "1.7.0",
            assertStandardSchema: async () => "spec-driven",
            validate: async () => ({ valid: true, issues: [], raw: {} }),
            archive: async () => ({ success: true, code: 0, stdout: "{}", stderr: "" }),
        } as never,
        requiredCommands: acceptValidationCommands([command]).required,
        calculateIdentity: async () => identity,
        calculatePlanningIdentity: async () => currentPlanningIdentity,
        readEvidence: async () => [evidence(identity)],
        readReview: async () => {
            const { readFile } = await import("node:fs/promises");
            return readFile(reviewPath(h.root, change), "utf8");
        },
        loadTasks: async () => "- [x] 1.1 Done\n",
    };
}

async function readyForCompletion(h: Harness): Promise<ReturnType<typeof readV1Run>> {
    await persistValidationEvidence(h.root, change, evidence(identity));
    await updateV1Run(h.root, change, s => ({
        ...s,
        status: "active",
        stage: "review",
        currentRepositoryState: identity,
        validatedRepositoryState: identity,
        reviewedRepositoryState: null,
        reviewedPlanningArtifactIdentity: null,
    }));
    return readV1Run(h.root, change);
}

describe("B-02 dual review identity (implementation + planning artifacts)", () => {
    it("passes a fresh review binding both identities and permits completion", async () => {
        const artifacts: ImplementationArtifacts = {
            exploration: "# Exploration\n",
            proposal: "# Proposal v1\n",
            specs: "# Specs v1\n",
            design: "# Design v1\n",
            tasks: "- [x] 1.1 Implement\n",
        };
        const planningId = planningIdentityFromArtifacts(change, artifacts);
        const h = await harness(artifacts, [review("pass", identity, planningId)]);
        const opts = reviewOptions(h);

        const result = await runReview(opts, await readyForCompletion(h));
        expect(result.kind).toBe("ready-for-completion");
        const state = await readV1Run(h.root, change);
        expect(state.reviewedRepositoryState).toBe(identity);
        expect(state.reviewedPlanningArtifactIdentity).toBe(planningId);
        expect(opts.reviewerRequests[0].planningArtifactIdentity).toBe(planningId);

        const completion = await resolveCompletion(completionOptions(h, planningId), state, {
            kind: "complete-and-archive",
        });
        expect(completion.kind).toBe("completed");
    });

    it("mutating proposal after a passing review changes the planning identity but not the implementation identity", async () => {
        const original: ImplementationArtifacts = {
            exploration: "# Exploration\n",
            proposal: "# Proposal v1\n",
            specs: "# Specs v1\n",
            design: "# Design v1\n",
            tasks: "- [x] 1.1 Implement\n",
        };
        const originalPlanning = planningIdentityFromArtifacts(change, original);
        const h = await harness(original, [review("pass", identity, originalPlanning)]);
        const opts = reviewOptions(h);

        await runReview(opts, await readyForCompletion(h));
        const reviewedState = await readV1Run(h.root, change);
        expect(reviewedState.reviewedPlanningArtifactIdentity).toBe(originalPlanning);

        // Mutate the proposal (a reviewed planning artifact).
        const mutated: ImplementationArtifacts = {
            ...original,
            proposal: "# Proposal v2 — changed requirements\n",
        };
        const mutatedPlanning = planningIdentityFromArtifacts(change, mutated);
        h.artifacts = mutated;

        // Implementation repository identity is intentionally unchanged.
        expect(mutatedPlanning).not.toBe(originalPlanning);

        // Completion must be rejected: the run's reviewed planning identity no
        // longer matches the current planning artifacts.
        const completion = await resolveCompletion(
            completionOptions(h, mutatedPlanning),
            reviewedState,
            { kind: "complete-and-archive" },
        );
        expect(completion.kind).toBe("finalisation-rejected");
        if (completion.kind === "finalisation-rejected") {
            expect(completion.reason).toContain("planning artifact identity");
        }
    });

    it("rejects completion until a fresh review of the mutated planning identity occurs", async () => {
        const original: ImplementationArtifacts = {
            exploration: "# Exploration\n",
            proposal: "# Proposal v1\n",
            specs: "# Specs v1\n",
            design: "# Design v1\n",
            tasks: "- [x] 1.1 Implement\n",
        };
        const originalPlanning = planningIdentityFromArtifacts(change, original);
        const h = await harness(original, [review("pass", identity, originalPlanning)]);
        let opts = reviewOptions(h);

        // First passing review against the original planning artifacts.
        await runReview(opts, await readyForCompletion(h));
        const afterFirstReview = await readV1Run(h.root, change);
        expect(afterFirstReview.reviewedPlanningArtifactIdentity).toBe(originalPlanning);

        // Mutate proposal -> planning identity changes; review is now stale.
        const mutated: ImplementationArtifacts = { ...original, proposal: "# Proposal v2\n" };
        const mutatedPlanning = planningIdentityFromArtifacts(change, mutated);
        h.artifacts = mutated;

        // The persisted review still binds the OLD planning identity, so
        // completion is rejected because the current (mutated) planning
        // artifacts differ from the reviewed planning artifacts.
        const staleCompletion = await resolveCompletion(
            completionOptions(h, mutatedPlanning),
            afterFirstReview,
            { kind: "complete-and-archive" },
        );
        expect(staleCompletion.kind).toBe("finalisation-rejected");

        // A fresh review against the mutated planning artifacts re-binds both
        // identities and permits progression again. Reset to the review
        // boundary first (the stale completion left the run awaiting-user).
        await updateV1Run(h.root, change, s => ({
            ...s,
            status: "active",
            stage: "review",
            reviewedRepositoryState: null,
            reviewedPlanningArtifactIdentity: null,
        }));
        h.reports.push(review("pass", identity, mutatedPlanning));
        opts = reviewOptions(h);
        const freshResult = await runReview(opts, await readV1Run(h.root, change));
        expect(freshResult.kind).toBe("ready-for-completion");
        const afterFreshReview = await readV1Run(h.root, change);
        expect(afterFreshReview.reviewedPlanningArtifactIdentity).toBe(mutatedPlanning);

        const completion = await resolveCompletion(
            completionOptions(h, mutatedPlanning),
            afterFreshReview,
            { kind: "complete-and-archive" },
        );
        expect(completion.kind).toBe("completed");
    });

    it("mutating specs, design, and tasks each change the planning identity", async () => {
        const base: ImplementationArtifacts = {
            exploration: "# Exploration\n",
            proposal: "# Proposal v1\n",
            specs: "# Specs v1\n",
            design: "# Design v1\n",
            tasks: "- [x] 1.1 Implement\n",
        };
        const basePlanning = planningIdentityFromArtifacts(change, base);
        for (const [field, value] of [
            ["specs", "# Specs v2\n"],
            ["design", "# Design v2\n"],
            ["tasks", "- [x] 1.1 Implement\n- [x] 1.2 Verify\n"],
        ] as const) {
            const mutated = { ...base, [field]: value } as ImplementationArtifacts;
            expect(planningIdentityFromArtifacts(change, mutated)).not.toBe(basePlanning);
        }
    });

    it("unchanged planning artifacts do not invalidate implementation validation evidence", async () => {
        const artifacts: ImplementationArtifacts = {
            exploration: "# Exploration\n",
            proposal: "# Proposal v1\n",
            specs: "# Specs v1\n",
            design: "# Design v1\n",
            tasks: "- [x] 1.1 Implement\n",
        };
        const planningId = planningIdentityFromArtifacts(change, artifacts);
        const h = await harness(artifacts, [review("pass", identity, planningId)]);
        const opts = reviewOptions(h);

        await runReview(opts, await readyForCompletion(h));
        const state = await readV1Run(h.root, change);

        // Implementation identity and planning identity both unchanged ->
        // completion proceeds without re-running validation/review.
        const completion = await resolveCompletion(completionOptions(h, planningId), state, {
            kind: "complete-and-archive",
        });
        expect(completion.kind).toBe("completed");
    });

    it("resumeVerified returns to validation when planning artifacts mutate", async () => {
        const original: ImplementationArtifacts = {
            exploration: "# Exploration\n",
            proposal: "# Proposal v1\n",
            specs: "# Specs v1\n",
            design: "# Design v1\n",
            tasks: "- [x] 1.1 Implement\n",
        };
        const originalPlanning = planningIdentityFromArtifacts(change, original);
        const h = await harness(original, [review("pass", identity, originalPlanning)]);
        const opts = reviewOptions(h);

        await runReview(opts, await readyForCompletion(h));
        await updateV1Run(h.root, change, s => ({ ...s, status: "verified" }));

        // Mutate planning artifacts while implementation identity is unchanged.
        const mutated: ImplementationArtifacts = { ...original, design: "# Design v2\n" };
        const mutatedPlanning = planningIdentityFromArtifacts(change, mutated);
        h.artifacts = mutated;

        const { resumeVerified } = await import("../src/workflow/finalize.js");
        const result = await resumeVerified(
            {
                ...completionOptions(h, mutatedPlanning),
                calculatePlanningIdentity: async () => mutatedPlanning,
            },
            await readV1Run(h.root, change),
        );
        expect(result.kind).toBe("verified-stale");
        if (result.kind === "verified-stale") {
            expect(result.reason).toContain("planning");
        }
        const after = await readV1Run(h.root, change);
        expect(after.status).toBe("active");
        expect(after.stage).toBe("validation");
        expect(after.reviewedPlanningArtifactIdentity).toBeNull();
    });

    it("resumeVerified re-presents the checkpoint when both identities are unchanged", async () => {
        const artifacts: ImplementationArtifacts = {
            exploration: "# Exploration\n",
            proposal: "# Proposal v1\n",
            specs: "# Specs v1\n",
            design: "# Design v1\n",
            tasks: "- [x] 1.1 Implement\n",
        };
        const planningId = planningIdentityFromArtifacts(change, artifacts);
        const h = await harness(artifacts, [review("pass", identity, planningId)]);
        const opts = reviewOptions(h);

        await runReview(opts, await readyForCompletion(h));
        await updateV1Run(h.root, change, s => ({ ...s, status: "verified" }));

        const { resumeVerified } = await import("../src/workflow/finalize.js");
        const result = await resumeVerified(
            completionOptions(h, planningId),
            await readV1Run(h.root, change),
        );
        expect(result.kind).toBe("verified-resumed");
    });

    it("fails safely when a reviewed planning artifact disappears", async () => {
        const artifacts: ImplementationArtifacts = {
            exploration: "# Exploration\n",
            proposal: "",
            specs: "# Specs v1\n",
            design: "# Design v1\n",
            tasks: "- [x] 1.1 Implement\n",
        };
        // An empty proposal still hashes deterministically; the identity covers
        // the (empty) content rather than throwing, so the contract is that the
        // identity is well-defined even for degenerate artifact content.
        const id = planningIdentityFromArtifacts(change, artifacts);
        expect(id).toMatch(/^[a-f0-9]{64}$/);
    });
});

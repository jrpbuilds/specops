import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acceptValidationCommands } from "../src/validation/commands.js";
import { canonicalCommandHash } from "../src/validation/registry.js";
import { persistValidationEvidence, readValidationEvidence } from "../src/validation/evidence.js";
import type { ValidationEvidence } from "../src/validation/executor.js";
import type { ValidationCommand } from "../src/validation/registry.js";
import { createV1Run, readV1Run, updateV1Run } from "../src/state/store.js";
import { reviewPath } from "../src/state/paths.js";
import {
    completionOverview,
    resolveCompletion,
    resumeVerified,
    type CompletionOptions,
} from "../src/workflow/finalize.js";
import { planningIdentityFromArtifacts } from "../src/workflow/planning-identity.js";
import type { OpenSpecArchiveResult } from "../src/openspec/archive.js";
import type { OpenSpecValidationResult } from "../src/openspec/validation.js";
import type { OpenSpecChangeStatus } from "../src/openspec/status.js";

const change = "completion-test";
const identity = "a".repeat(64);
const changedIdentity = "b".repeat(64);
const command: ValidationCommand = {
    id: "typecheck",
    executable: "node",
    args: ["--version"],
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
};
const tasksContent = "- [x] 8.1 Finalize\n";
const planningArtifacts = {
    proposal: "# Proposal\n",
    specs: "# Specs\n",
    design: "# Design\n",
    tasks: tasksContent,
};
const planningIdentity = planningIdentityFromArtifacts(change, planningArtifacts);

async function directory(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "specops-completion-"));
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
    reviewedPlanning: string = planningIdentity,
): string {
    return [
        "## Verdict\n" + verdict,
        `## Reviewed state\nRepository identity: ${reviewed}\nPlanning artifacts: ${reviewedPlanning}`,
        "## Validation\ntypecheck passed.",
        "## Blocking findings\nNone.",
        "## Non-blocking observations\n- Consider a follow-up.",
        "## Conclusion\nReviewed independently.",
    ].join("\n\n");
}

function validation(valid = true): OpenSpecValidationResult {
    return { valid, issues: [], raw: { items: [{ valid, issues: [] }] } };
}

async function readyState(
    root: string,
    overrides: {
        identity?: string;
        validated?: string | null;
        reviewed?: string | null;
        reviewedPlanning?: string | null;
        repairAttempts?: number;
        tasks?: string;
    } = {},
): Promise<ReturnType<typeof readV1Run>> {
    const ident = overrides.identity ?? identity;
    await createV1Run(root, {
        change,
        goal: "Complete the approved change",
        baselineRepositoryState: identity,
    });
    await updateV1Run(root, change, s => ({
        ...s,
        status: "awaiting-user",
        stage: "archive",
        currentRepositoryState: ident,
        validatedRepositoryState: overrides.validated ?? ident,
        reviewedRepositoryState: overrides.reviewed ?? ident,
        reviewedPlanningArtifactIdentity: overrides.reviewedPlanning ?? planningIdentity,
        repairAttempts: overrides.repairAttempts ?? 0,
    }));
    await persistValidationEvidence(root, change, evidence({ repositoryIdentity: ident }));
    await mkdir(path.dirname(reviewPath(root, change)), { recursive: true });
    await writeFile(reviewPath(root, change), reviewMarkdown("pass", ident));
    const tasksDir = path.join(root, "openspec", "changes", change);
    await mkdir(tasksDir, { recursive: true });
    await writeFile(path.join(tasksDir, "tasks.md"), overrides.tasks ?? tasksContent);
    return readV1Run(root, change);
}

type FakeAdapter = {
    versionOk: boolean;
    schemaOk: boolean;
    validationOk: boolean;
    archiveResult: OpenSpecArchiveResult;
    archiveError?: Error;
    version(): Promise<string>;
    assertStandardSchema(): Promise<string>;
    validate(): Promise<OpenSpecValidationResult>;
    status(c: string): Promise<OpenSpecChangeStatus>;
    archive(c: string): Promise<OpenSpecArchiveResult>;
};

function fakeAdapter(overrides: Partial<FakeAdapter> = {}): FakeAdapter {
    return {
        versionOk: true,
        schemaOk: true,
        validationOk: true,
        archiveResult: { success: true, code: 0, stdout: "{}", stderr: "" },
        ...overrides,
        async version() {
            if (!overrides.versionOk && overrides.versionOk !== undefined)
                throw new Error("unsupported");
            return "1.7.0";
        },
        async assertStandardSchema() {
            if (!overrides.schemaOk && overrides.schemaOk !== undefined)
                throw new Error("unsupported schema");
            return "spec-driven";
        },
        async validate() {
            if (!overrides.validationOk && overrides.validationOk !== undefined)
                throw new Error("validation failed");
            return validation();
        },
        async status() {
            return {} as OpenSpecChangeStatus;
        },
        async archive() {
            if (overrides.archiveError) throw overrides.archiveError;
            return overrides.archiveResult ?? { success: true, code: 0, stdout: "{}", stderr: "" };
        },
    };
}

function options(
    root: string,
    adapter: FakeAdapter = fakeAdapter(),
    overrides: Partial<CompletionOptions> = {},
): CompletionOptions {
    return {
        directory: root,
        adapter,
        implementation: {
            commands: acceptValidationCommands([command]),
            implementer: { run: async () => ({ kind: "completed" }) },
            frontier: { run: async () => ({ advice: "" }) },
            detectMutation: async (_directory: string, previous: string) => ({
                previous,
                current: identity,
                changed: false,
                files: [],
            }),
            executeCommand: async (
                _directory: string,
                configured: ValidationCommand,
                repositoryIdentity: string,
            ) =>
                evidence({
                    commandId: configured.id,
                    executable: configured.executable,
                    args: [...configured.args],
                    repositoryIdentity,
                }),
            loadArtifacts: async () => ({
                exploration: "# Exploration\n",
                proposal: "# Proposal\n",
                specs: "# Specs\n",
                design: "# Design\n",
                tasks: tasksContent,
            }),
        } as never,
        review: {
            reviewer: { run: async () => {} },
            calculateIdentity: async () => identity,
            readEvidence: async () => [evidence()],
            readReview: async () => reviewMarkdown("pass"),
            currentDiff: async () => "",
            summarizeChanges: async () => [],
        } as never,
        calculateIdentity: async () => identity,
        calculatePlanningIdentity: async () => planningIdentity,
        readEvidence: async () => [evidence()],
        readReview: async () => reviewMarkdown("pass"),
        loadTasks: async () => tasksContent,
        ...overrides,
    };
}

describe("completion workflow", () => {
    it("returns a presentation-only overview", async () => {
        const root = await directory();
        const state = await readyState(root);
        const overview = completionOverview(state);
        expect(overview.change).toBe(change);
        expect(overview.stage).toBe("archive");
        expect(overview.status).toBe("awaiting-user");
    });

    it("completes and archives on success", async () => {
        const root = await directory();
        const state = await readyState(root);
        const result = await resolveCompletion(options(root), state, {
            kind: "complete-and-archive",
        });
        expect(result.kind).toBe("completed");
        if (result.kind !== "completed") return;
        expect(result.state.status).toBe("completed");
        expect(result.state.archivedAt).toBeTruthy();
        expect(result.state.archiveError).toBeNull();
    });

    it("leaves the change open as verified", async () => {
        const root = await directory();
        const state = await readyState(root);
        const result = await resolveCompletion(options(root), state, { kind: "leave-change-open" });
        expect(result.kind).toBe("verified");
        if (result.kind !== "verified") return;
        expect(result.state.status).toBe("verified");
        expect(result.state.stage).toBe("archive");
    });

    it("cancels the run", async () => {
        const root = await directory();
        const state = await readyState(root);
        const result = await resolveCompletion(options(root), state, { kind: "cancel" });
        expect(result.kind).toBe("cancelled");
        if (result.kind !== "cancelled") return;
        expect(result.state.status).toBe("cancelled");
    });

    it("requests implementation changes and invalidates evidence", async () => {
        const root = await directory();
        const state = await readyState(root);
        const result = await resolveCompletion(options(root), state, {
            kind: "request-implementation-changes",
            feedback: "Add more tests",
        });
        expect(result.kind).toBe("request-changes");
        if (result.kind !== "request-changes") return;
        expect(result.state.status).toBe("awaiting-user");
        expect(result.state.stage).toBe("archive");
        expect(result.state.validatedRepositoryState).toBe(identity);
        expect(result.state.reviewedRepositoryState).toBe(identity);
        expect(result.state.repairAttempts).toBe(0);
    });

    it("rejects finalisation with incomplete tasks", async () => {
        const root = await directory();
        const state = await readyState(root, { tasks: "- [ ] 8.1 Finalize\n" });
        const result = await resolveCompletion(
            options(root, fakeAdapter(), { loadTasks: async () => "- [ ] 8.1 Finalize\n" }),
            state,
            { kind: "complete-and-archive" },
        );
        expect(result.kind).toBe("finalisation-rejected");
        if (result.kind !== "finalisation-rejected") return;
        expect(result.reason).toContain("required tasks");
    });

    it("rejects finalisation with stale validation identity", async () => {
        const root = await directory();
        const state = await readyState(root, { validated: changedIdentity });
        const result = await resolveCompletion(options(root), state, {
            kind: "complete-and-archive",
        });
        expect(result.kind).toBe("finalisation-rejected");
        if (result.kind !== "finalisation-rejected") return;
        expect(result.reason).toContain("validated repository identity");
    });

    it("rejects finalisation with stale review identity", async () => {
        const root = await directory();
        const state = await readyState(root, { reviewed: changedIdentity });
        const result = await resolveCompletion(options(root), state, {
            kind: "complete-and-archive",
        });
        expect(result.kind).toBe("finalisation-rejected");
        if (result.kind !== "finalisation-rejected") return;
        expect(result.reason).toContain("reviewed repository identity");
    });

    it("rejects finalisation with unsupported OpenSpec version", async () => {
        const root = await directory();
        const state = await readyState(root);
        const result = await resolveCompletion(
            options(root, fakeAdapter({ versionOk: false })),
            state,
            { kind: "complete-and-archive" },
        );
        expect(result.kind).toBe("finalisation-rejected");
    });

    it("rejects finalisation with non-spec-driven schema", async () => {
        const root = await directory();
        const state = await readyState(root);
        const result = await resolveCompletion(
            options(root, fakeAdapter({ schemaOk: false })),
            state,
            { kind: "complete-and-archive" },
        );
        expect(result.kind).toBe("finalisation-rejected");
    });

    it("rejects finalisation with invalid OpenSpec change", async () => {
        const root = await directory();
        const state = await readyState(root);
        const result = await resolveCompletion(
            options(root, fakeAdapter({ validationOk: false })),
            state,
            { kind: "complete-and-archive" },
        );
        expect(result.kind).toBe("finalisation-rejected");
    });

    it("rejects finalisation with active repair", async () => {
        const root = await directory();
        await readyState(root);
        const repairing = await updateV1Run(root, change, run => ({
            ...run,
            status: "active",
            stage: "repair",
            repairAttempts: 1,
        }));
        await expect(
            resolveCompletion(options(root), repairing, { kind: "complete-and-archive" }),
        ).rejects.toThrow("completion checkpoint is not pending");
    });

    it("persists archive failure with error, identity, and timestamp", async () => {
        const root = await directory();
        const state = await readyState(root);
        const result = await resolveCompletion(
            options(
                root,
                fakeAdapter({
                    archiveResult: { success: false, code: 1, stdout: "", stderr: "boom" },
                }),
            ),
            state,
            { kind: "complete-and-archive" },
        );
        expect(result.kind).toBe("archive-failed");
        if (result.kind !== "archive-failed") return;
        expect(result.state.status).toBe("failed");
        expect(result.state.archiveError).toBeTruthy();
        expect(result.state.archiveError?.repositoryIdentity).toBe(identity);
        expect(result.state.archiveError?.attemptedAt).toBeTruthy();
        expect(result.state.archivedAt).toBeNull();
    });

    it("persists archive failure from a thrown error", async () => {
        const root = await directory();
        const state = await readyState(root);
        const result = await resolveCompletion(
            options(root, fakeAdapter({ archiveError: new Error("spawn failed") })),
            state,
            { kind: "complete-and-archive" },
        );
        expect(result.kind).toBe("archive-failed");
        if (result.kind !== "archive-failed") return;
        expect(result.state.archiveError?.message).toContain("spawn failed");
    });

    it("retries archive without rerunning when identity is unchanged", async () => {
        const root = await directory();
        const state = await readyState(root);
        const adapter = fakeAdapter({
            archiveResult: { success: false, code: 1, stdout: "", stderr: "boom" },
        });
        const failed = await resolveCompletion(options(root, adapter), state, {
            kind: "complete-and-archive",
        });
        expect(failed.kind).toBe("archive-failed");
        const failedState = await readV1Run(root, change);
        const retried = await resolveCompletion(
            options(
                root,
                fakeAdapter({
                    archiveResult: { success: true, code: 0, stdout: "{}", stderr: "" },
                }),
            ),
            failedState,
            { kind: "complete-and-archive" },
        );
        expect(retried.kind).toBe("completed");
    });

    it("requires fresh validation when identity changed before retry", async () => {
        const root = await directory();
        const state = await readyState(root);
        const adapter = fakeAdapter({
            archiveResult: { success: false, code: 1, stdout: "", stderr: "boom" },
        });
        await resolveCompletion(options(root, adapter), state, { kind: "complete-and-archive" });
        const failedState = await readV1Run(root, change);
        await updateV1Run(root, change, s => ({
            ...s,
            currentRepositoryState: changedIdentity,
            validatedRepositoryState: identity,
            reviewedRepositoryState: identity,
        }));
        const result = await resolveCompletion(
            options(root, fakeAdapter(), {
                readEvidence: async () => [evidence({ repositoryIdentity: identity })],
                calculateIdentity: async () => changedIdentity,
            }),
            failedState,
            { kind: "complete-and-archive" },
        );
        expect(result.kind).toBe("finalisation-rejected");
        if (result.kind !== "finalisation-rejected") return;
        expect(result.reason).toContain("current repository identity changed");
    });

    it("rejects continuation from a completed run", async () => {
        const root = await directory();
        const state = await readyState(root);
        const completed = await resolveCompletion(options(root), state, {
            kind: "complete-and-archive",
        });
        expect(completed.kind).toBe("completed");
        await expect(
            updateV1Run(root, change, s => ({ ...s, status: "active" })),
        ).rejects.toThrow();
    });

    it("resumes verified unchanged and re-presents the checkpoint", async () => {
        const root = await directory();
        const state = await readyState(root);
        const verified = await resolveCompletion(options(root), state, {
            kind: "leave-change-open",
        });
        expect(verified.kind).toBe("verified");
        const verifiedState = await readV1Run(root, change);
        const result = await resumeVerified(options(root), verifiedState);
        expect(result.kind).toBe("verified-resumed");
        if (result.kind !== "verified-resumed") return;
        expect(result.state.status).toBe("awaiting-user");
        expect(result.state.stage).toBe("archive");
    });

    it("invalidates verified evidence on mutation and returns to validation", async () => {
        const root = await directory();
        const state = await readyState(root);
        await resolveCompletion(options(root), state, { kind: "leave-change-open" });
        const verifiedState = await readV1Run(root, change);
        const result = await resumeVerified(
            options(root, fakeAdapter(), { calculateIdentity: async () => changedIdentity }),
            verifiedState,
        );
        expect(result.kind).toBe("verified-stale");
        if (result.kind !== "verified-stale") return;
        expect(result.state.status).toBe("active");
        expect(result.state.stage).toBe("validation");
        expect(result.state.validatedRepositoryState).toBeNull();
        expect(result.state.reviewedRepositoryState).toBeNull();
        const staleEvidence = await readValidationEvidence(root, change);
        expect(staleEvidence[0]?.invalidatedAt).toBeTruthy();
    });
});

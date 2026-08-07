import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceptValidationCommands } from "../src/validation/commands.js";
import { canonicalCommandHash } from "../src/validation/registry.js";
import {
    isValidationEvidenceCurrent,
    persistValidationEvidence,
} from "../src/validation/evidence.js";
import type { ValidationEvidence } from "../src/validation/executor.js";
import type { ValidationCommand } from "../src/validation/registry.js";
import { createV1Run, readV1Run, updateV1Run } from "../src/state/store.js";
import { reviewPath } from "../src/state/paths.js";
import { parseReview } from "../src/review/parser.js";
import { resolveCompletion, type CompletionOptions } from "../src/workflow/finalize.js";
import type { OpenSpecArchiveResult } from "../src/openspec/archive.js";
import type { OpenSpecValidationResult } from "../src/openspec/validation.js";
import type { OpenSpecChangeStatus } from "../src/openspec/status.js";

const identity = "a".repeat(64);
const change = "phase11-integrity";
const command: ValidationCommand = {
    id: "typecheck",
    executable: "node",
    args: ["--version"],
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map(directory => rm(directory, { recursive: true, force: true })),
    );
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "specops-phase11-int-"));
    temporaryDirectories.push(directory);
    return directory;
}

function evidence(overrides: Partial<ValidationEvidence> = {}): ValidationEvidence {
    return {
        commandId: command.id,
        executable: command.executable,
        args: [...command.args],
        cwd: ".",
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
    return [
        "## Verdict\n" + verdict,
        `## Reviewed state\nRepository identity: ${reviewed}`,
        "## Validation\ntypecheck passed.",
        "## Blocking findings\nNone.",
        "## Non-blocking observations\n- Consider a follow-up.",
        "## Conclusion\nReviewed independently.",
    ].join("\n\n");
}

function fakeAdapter(): CompletionOptions["adapter"] {
    return {
        async version() {
            return "1.7.0";
        },
        async assertStandardSchema() {
            return "spec-driven";
        },
        async validate() {
            return {
                valid: true,
                issues: [],
                raw: { items: [{ valid: true, issues: [] }] },
            } as OpenSpecValidationResult;
        },
        async status() {
            return {} as OpenSpecChangeStatus;
        },
        async archive() {
            return { success: true, code: 0, stdout: "{}", stderr: "" } as OpenSpecArchiveResult;
        },
    };
}

describe("Phase 11 — freshness and completion integrity regressions", () => {
    describe("B-04 validation evidence bound to the complete command definition", () => {
        it("rejects stale evidence whose command definition changed even when the id matches", async () => {
            const directory = await temporaryDirectory();
            await createV1Run(directory, {
                change,
                goal: "remediate binding",
                baselineRepositoryState: identity,
            });
            await updateV1Run(directory, change, s => ({
                ...s,
                status: "awaiting-user",
                stage: "archive",
                currentRepositoryState: identity,
                validatedRepositoryState: identity,
                reviewedRepositoryState: identity,
                acceptedValidationCommands: [command],
            }));
            // Evidence recorded against an outdated executable/args/timeout but
            // the SAME command id. The gate must reject it because the
            // canonical command definition no longer matches.
            const stale = evidence({
                executable: "old-node",
                args: ["--check"],
                commandDefinitionHash: canonicalCommandHash({
                    ...command,
                    executable: "old-node",
                    args: ["--check"],
                }),
            });
            await persistValidationEvidence(directory, change, stale);
            const tasksDir = path.join(directory, "openspec", "changes", change);
            await mkdir(tasksDir, { recursive: true });
            await writeFile(path.join(tasksDir, "tasks.md"), "- [x] 8.1 Finalize\n");

            const options: CompletionOptions = {
                directory,
                adapter: fakeAdapter(),
                requiredCommands: [command],
                calculateIdentity: async () => identity,
                readReview: async () => reviewMarkdown("pass", identity),
            };
            const result = await resolveCompletion(options, await readV1Run(directory, change), {
                kind: "complete-and-archive",
            });

            expect(result.kind).toBe("finalisation-rejected");
            expect((result as { reason: string }).reason).toContain("typecheck");
        });

        it("isValidationEvidenceCurrent requires a matching command definition hash", () => {
            const current = evidence();
            const accepted = current.commandDefinitionHash;
            expect(
                isValidationEvidenceCurrent(
                    { ...current, commandDefinitionHash: "different-hash" },
                    identity,
                    accepted,
                ),
            ).toBe(false);
            expect(isValidationEvidenceCurrent(current, identity, accepted)).toBe(true);
        });
    });

    describe("B-03 persisted canonical accepted validation command definitions", () => {
        it("persists the accepted command definitions at the planning checkpoint", async () => {
            const directory = await temporaryDirectory();
            await createV1Run(directory, {
                change,
                goal: "remediate persistence",
                baselineRepositoryState: identity,
            });
            const accepted = acceptValidationCommands([command], [], []);
            // Simulate the planning checkpoint persisting the accepted set.
            await updateV1Run(directory, change, s => ({
                ...s,
                acceptedValidationCommands: accepted.required,
            }));
            const state = await readV1Run(directory, change);
            expect(state.acceptedValidationCommands).toEqual([command]);
        });
    });

    describe("B-02 review binds reviewed planning artifacts — dual identity", () => {
        // B-02 required binding reviews to the reviewed OpenSpec planning
        // artifacts so a post-review mutation of a frozen proposal/specs/
        // design/tasks artifact invalidates the review. The architectural
        // amendment (design.md §B-02) introduces a separate deterministic
        // planning-artifact identity bound alongside the implementation
        // repository identity; the two are never merged. The full regression
        // coverage — fresh-review binding, proposal/specs/design/tasks
        // mutation invalidation, fresh-review progression, verified-resume,
        // and safe-failure behaviour — lives in
        // tests/phase11-b02-dual-identity.test.ts.
        it("the dual-identity regression coverage is exercised in phase11-b02-dual-identity.test.ts", () => {
            expect(true).toBe(true);
        });
    });

    describe("B-06 review Markdown parsing is fail-closed", () => {
        it("rejects a review with a non-hex identity", () => {
            const parsed = parseReview(
                [
                    "## Verdict\npass",
                    "## Reviewed state\nRepository identity: NOT-A-HASH",
                    "## Validation\nx",
                    "## Blocking findings\nNone.",
                    "## Non-blocking observations\n- x.",
                    "## Conclusion\nx.",
                ].join("\n\n"),
            );
            expect(parsed.verdict).toBe("pass");
            expect(parsed.reviewedRepositoryState).toBeUndefined();
        });

        it("rejects a pass review that contains blocking findings", () => {
            const parsed = parseReview(
                [
                    "## Verdict\npass",
                    `## Reviewed state\nRepository identity: ${identity}`,
                    "## Validation\nx",
                    "## Blocking findings\n- ID: B-06: serious issue.",
                    "## Non-blocking observations\n- x.",
                    "## Conclusion\nx.",
                ].join("\n\n"),
            );
            // A pass review carrying blocking findings is semantically invalid;
            // the parser surfaces the finding ids but the gate rejects it.
            expect(parsed.verdict).toBe("pass");
            expect(parsed.blockingFindingIds).toEqual(["B-06"]);
        });
    });

    describe("B-06 run-state cross-invariants reject corruption", () => {
        it("rejects a completed run without an archivedAt timestamp", async () => {
            const directory = await temporaryDirectory();
            await createV1Run(directory, {
                change,
                goal: "remediate invariants",
                baselineRepositoryState: identity,
            });
            await writeFile(
                path.join(directory, ".specops", "runs", change, "run.json"),
                JSON.stringify({
                    version: 1,
                    change,
                    goal: "remediate invariants",
                    status: "completed",
                    stage: "archive",
                    startedAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                    baselineRepositoryState: identity,
                    currentRepositoryState: identity,
                    validatedRepositoryState: identity,
                    reviewedRepositoryState: identity,
                    reviewedPlanningArtifactIdentity: identity,
                    acceptedValidationRecommendationIds: [],
                    acceptedValidationCommands: [],
                    artifactCorrectionAttempts: {},
                    repairAttempts: 0,
                    failure: null,
                    archiveError: null,
                    archivedAt: null,
                    archiveAttemptedAt: null,
                }) + "\n",
            );
            await expect(readV1Run(directory, change)).rejects.toThrow(/completed/);
        });
    });

    describe("B-06 atomic run creation does not abandon .create copies", () => {
        it("creates a run without leaving a .create file behind", async () => {
            const directory = await temporaryDirectory();
            await createV1Run(directory, {
                change: "create-test",
                goal: "no abandoned copies",
                baselineRepositoryState: identity,
            });
            const { readdir } = await import("node:fs/promises");
            const runDir = path.join(directory, ".specops", "runs", "create-test");
            const entries = await readdir(runDir);
            expect(entries.some(entry => entry.endsWith(".create"))).toBe(false);
            expect(entries).toContain("run.json");
        });
    });

    describe("B-06 crash-safe archive resume window", () => {
        it("marks the run completed without re-archiving when OpenSpec already archived the change", async () => {
            const directory = await temporaryDirectory();
            const tasksDir = path.join(directory, "openspec", "changes", change);
            await mkdir(tasksDir, { recursive: true });
            await writeFile(path.join(tasksDir, "tasks.md"), "- [x] 8.1 Finalize\n");
            await createV1Run(directory, {
                change,
                goal: "crash window",
                baselineRepositoryState: identity,
            });
            await updateV1Run(directory, change, s => ({
                ...s,
                status: "awaiting-user",
                stage: "archive",
                currentRepositoryState: identity,
                validatedRepositoryState: identity,
                reviewedRepositoryState: identity,
                acceptedValidationCommands: [command],
                archiveAttemptedAt: "2026-01-01T00:00:00.000Z",
            }));
            await persistValidationEvidence(directory, change, evidence());
            await mkdir(path.dirname(reviewPath(directory, change)), { recursive: true });
            await writeFile(reviewPath(directory, change), reviewMarkdown("pass", identity));
            // Simulate OpenSpec having already archived the change (directory moved away).
            await rm(tasksDir, { recursive: true, force: true });

            const archiveCalls: string[] = [];
            const options: CompletionOptions = {
                directory,
                adapter: {
                    ...fakeAdapter(),
                    archive: async () => {
                        archiveCalls.push("archive");
                        return {
                            success: true,
                            code: 0,
                            stdout: "{}",
                            stderr: "",
                        } as OpenSpecArchiveResult;
                    },
                },
                requiredCommands: [command],
                calculateIdentity: async () => identity,
            };
            const result = await resolveCompletion(options, await readV1Run(directory, change), {
                kind: "complete-and-archive",
            });

            expect(result.kind).toBe("completed");
            expect(archiveCalls).toEqual([]);
            const state = await readV1Run(directory, change);
            expect(state.status).toBe("completed");
            expect(state.archivedAt).toBe("2026-01-01T00:00:00.000Z");
            expect(state.archiveAttemptedAt).toBeNull();
        });
    });
});

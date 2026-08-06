import { execFileSync } from "node:child_process";
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    stat,
    unlink,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../src/capabilities/ids.js";
import { hash } from "../src/artifacts/lifecycle.js";
import { DEFAULT_CONFIG, type SpecOpsConfig } from "../src/config.js";
import { countIncompleteTasks, onboard } from "../src/openspec.js";
import { SpecOpsPlugin } from "../src/orchestrator.js";
import { TOOL_IDS } from "../src/protocol.js";
import {
    changeRoot,
    readArchiveAttemptSidecar,
    readRun,
    readRunIn,
    withRunLock,
    writeArchiveAttemptSidecar,
    writeRun,
    writeRunIn,
} from "../src/state/store.js";
import type { ArtifactId, Assessment, RunState } from "../src/types.js";
import {
    archiveCompletedRun,
    completeAction,
    finalizeRun,
    issueDirective,
    startRun,
} from "../src/workflow/engine.js";
import { nextAction, dispatchHash } from "../src/workflow/scheduler.js";
import {
    ASSURANCE_FINDINGS_CONTRACT,
    JUDGMENT_CONTRACT,
    REVIEW_LEDGER_CONTRACT,
} from "../src/workflow/contracts.generated.js";

const leanAssessment: Assessment = {
    changeKind: "documentation",
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
    inspectedPaths: ["README.md"],
    unresolvedQuestions: [],
    likelyValidations: [],
    facts: ["README.md is the requested documentation surface."],
    inferences: ["No product behavior changes are required."],
};

/** Config with auto-archive disabled, used to reach a verified-but-unarchived state. */
const noArchiveConfig: SpecOpsConfig = {
    ...DEFAULT_CONFIG,
    openspec: { ...DEFAULT_CONFIG.openspec, autoArchive: false },
};

function configuredOpenSpec(script: string): SpecOpsConfig {
    return {
        ...DEFAULT_CONFIG,
        openspec: { ...DEFAULT_CONFIG.openspec, command: [process.execPath, "-e", script] },
    };
}

function validArtifact(
    state: RunState,
    artifact: ArtifactId,
): NonNullable<RunState["artifacts"][ArtifactId]> {
    return {
        artifact,
        producer: "test",
        purpose: "workflow",
        generatedAt: "now",
        inputHashes: {},
        outputHash: artifact,
        scopeTier: state.scopeTier,
        capabilities: state.requirements.requiredCapabilities,
        validity: "valid",
    };
}

function assuranceBundle(): string {
    return JSON.stringify({
        verification: "# Verification\n\nREADME links pass.",
        correctnessJudgment: { verdict: "PASS", summary: "Correct.", findings: [] },
        reviewLedger: { findings: [] },
    });
}

/** Create a clean repository fixture, optionally with a persisted no-archive config. */
async function initializedRepository(withNoArchiveConfig = false): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "specops-archive-repository-"));
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "specops@example.test"], { cwd: directory });
    execFileSync("git", ["config", "user.name", "SpecOps Test"], { cwd: directory });
    await writeFile(path.join(directory, "README.md"), "# Test\n");
    if (withNoArchiveConfig) {
        await mkdir(path.join(directory, ".opencode"), { recursive: true });
        await writeFile(
            path.join(directory, ".opencode", "specops.json"),
            JSON.stringify({ openspec: { autoArchive: false } }),
        );
    }
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: directory });
    return directory;
}

/** Drive a complete Lean lifecycle (automatic mode) to a verified run. */
async function verifiedLeanRun(): Promise<{ directory: string; change: string; state: RunState }> {
    const directory = await initializedRepository(true);
    await onboard(directory);
    const started = await startRun(directory, noArchiveConfig, {
        goal: "Update README wording",
        assessmentOutput: JSON.stringify(leanAssessment),
        requestedTier: "auto",
        mode: "automatic",
    });

    const planning = await issueDirective(directory, started.change, noArchiveConfig);
    if (planning.type !== "dispatch") throw new Error("expected planning dispatch");
    await completeAction(
        directory,
        started.change,
        planning.action.id,
        "# Tasks\n\n- Update the README wording.",
        noArchiveConfig,
    );

    const implementation = await issueDirective(directory, started.change, noArchiveConfig);
    if (implementation.type !== "dispatch") throw new Error("expected implementation dispatch");
    await writeFile(path.join(directory, "README.md"), "# Updated test\n");
    await completeAction(
        directory,
        started.change,
        implementation.action.id,
        "Updated README wording.",
        noArchiveConfig,
    );

    const verification = await issueDirective(directory, started.change, noArchiveConfig);
    if (verification.type !== "dispatch") throw new Error("expected verifier dispatch");
    await completeAction(
        directory,
        started.change,
        verification.action.id,
        assuranceBundle(),
        noArchiveConfig,
    );

    // finalizeRun with auto-archive disabled verifies and transitions to
    // `completed` without archiving; the change directory stays in place.
    const finalized = await finalizeRun(directory, started.change, noArchiveConfig);
    if (finalized.status !== "completed")
        throw new Error(`expected completed, got ${finalized.status}`);
    return { directory, change: started.change, state: finalized };
}

/** Rewrite a verified run to the intermediate `passed` state for archive testing. */
async function passedLeanRun(): Promise<{ directory: string; change: string; state: RunState }> {
    const verified = await verifiedLeanRun();
    const passed: RunState = { ...verified.state, status: "passed", archivedAt: undefined };
    await writeRun(verified.directory, verified.change, passed);
    return { ...verified, state: passed };
}

/** Move a passed fixture and persist a completed state at an archive candidate. */
async function moveCompletedCandidate(
    directory: string,
    change: string,
    archivedAs: string,
): Promise<{ candidate: string; state: RunState }> {
    const candidate = path.join(directory, "openspec", "changes", "archive", archivedAs);
    await mkdir(path.dirname(candidate), { recursive: true });
    await rename(changeRoot(directory, change), candidate);
    const moved = await readRunIn(candidate);
    await writeRunIn(candidate, {
        ...moved,
        status: "completed",
        archivedAt: new Date().toISOString(),
    });
    return { candidate, state: await readRunIn(candidate) };
}

describe("archive phase", () => {
    it("finalizes and archives a Lean run automatically, moving the change directory", async () => {
        const directory = await initializedRepository();
        await onboard(directory);
        const started = await startRun(directory, DEFAULT_CONFIG, {
            goal: "Update README wording",
            assessmentOutput: JSON.stringify(leanAssessment),
            requestedTier: "auto",
            mode: "automatic",
        });
        for (const phase of ["planning", "implementation", "verification"]) {
            const directive = await issueDirective(directory, started.change, DEFAULT_CONFIG);
            if (directive.type !== "dispatch") throw new Error(`expected ${phase} dispatch`);
            if (phase === "implementation")
                await writeFile(path.join(directory, "README.md"), "# Updated test\n");
            await completeAction(
                directory,
                started.change,
                directive.action.id,
                phase === "verification" ? assuranceBundle() : `# ${phase}\n\nDone.`,
                DEFAULT_CONFIG,
            );
        }

        const finalized = await finalizeRun(directory, started.change, DEFAULT_CONFIG);

        expect(finalized.status).toBe("completed");
        expect(finalized.archivedAt).toBeDefined();
        expect(finalized.archiveError).toBeUndefined();
        // The original change directory is gone (moved to openspec/changes/archive/).
        await expect(
            stat(path.join(changeRoot(directory, started.change), "specops-run.json")),
        ).rejects.toThrow();

        const archiveDir = path.join(directory, "openspec", "changes", "archive");
        const entries = await readdir(archiveDir);
        const moved = entries.find(name => name.endsWith(started.change));
        expect(moved, "archived change directory was not created").toBeDefined();
        const movedState = await readRunIn(path.join(archiveDir, moved!));
        expect(movedState.status).toBe("completed");
        expect(movedState.archivedAt).toBeDefined();
        expect(movedState.archiveError).toBeUndefined();
    });

    it("finalizes a Lean run without archiving when autoArchive is disabled", async () => {
        const { directory, change, state } = await verifiedLeanRun();

        expect(state.status).toBe("completed");
        expect(state.archivedAt).toBeUndefined();
        // The change directory remains in place.
        await expect(stat(path.join(changeRoot(directory, change), "specops-run.json"))).resolves;
        // No archive entry was created for this change.
        const archiveDir = path.join(directory, "openspec", "changes", "archive");
        const entries = await readdir(archiveDir).catch(() => [] as string[]);
        expect(entries.find(name => name.endsWith(change))).toBeUndefined();
    });

    it("archives a completed unarchived run through maintenance without re-verification", async () => {
        const { directory, change } = await verifiedLeanRun();

        const archived = await archiveCompletedRun(directory, change, noArchiveConfig);

        expect(archived.status).toBe("completed");
        expect(archived.archivedAt).toBeDefined();
        await expect(
            stat(path.join(changeRoot(directory, change), "specops-run.json")),
        ).rejects.toThrow();
        const entries = await readdir(path.join(directory, "openspec", "changes", "archive"));
        expect(entries.some(name => name.endsWith(change))).toBe(true);
    });

    it("archives a passed Lean run via archiveCompletedRun and moves the change directory", async () => {
        const { directory, change } = await passedLeanRun();

        const archived = await archiveCompletedRun(directory, change, DEFAULT_CONFIG);

        expect(archived.status).toBe("completed");
        expect(archived.archivedAt).toBeDefined();
        expect(archived.archiveError).toBeUndefined();
        await expect(
            stat(path.join(changeRoot(directory, change), "specops-run.json")),
        ).rejects.toThrow();
        const archiveDir = path.join(directory, "openspec", "changes", "archive");
        const moved = (await readdir(archiveDir)).find(name => name.endsWith(change));
        expect(moved).toBeDefined();
        const movedState = await readRunIn(path.join(archiveDir, moved!));
        expect(movedState.status).toBe("completed");
        expect(movedState.archivedAt).toBeDefined();
    });

    it("records archive_failed with a structured error when the OpenSpec binary exits non-zero", async () => {
        const { directory, change } = await passedLeanRun();
        const failingConfig: SpecOpsConfig = {
            ...DEFAULT_CONFIG,
            openspec: {
                ...DEFAULT_CONFIG.openspec,
                command: [
                    "node",
                    "-e",
                    "process.stderr.write('archive failed: simulated'); process.exit(1)",
                ],
            },
        };

        const failed = await archiveCompletedRun(directory, change, failingConfig);

        expect(failed.status).toBe("archive_failed");
        expect(failed.archiveError).toBeDefined();
        expect(failed.archiveError?.attempt).toBe(1);
        expect(failed.archiveError?.kind).toBe("command_failed");
        expect(failed.archiveError?.message).toContain("simulated");
        // The change directory is still present (archive did not move it).
        await expect(stat(path.join(changeRoot(directory, change), "specops-run.json"))).resolves;
        // The recovery sidecar was cleaned up after the terminal failure.
        await expect(readArchiveAttemptSidecar(directory, change)).resolves.toBeUndefined();
    });

    it("records archive_failed when the OpenSpec process cannot spawn", async () => {
        const { directory, change } = await passedLeanRun();
        const brokenConfig: SpecOpsConfig = {
            ...DEFAULT_CONFIG,
            openspec: { ...DEFAULT_CONFIG.openspec, command: ["/definitely/missing/specops"] },
        };

        const failed = await archiveCompletedRun(directory, change, brokenConfig);

        expect(failed.status).toBe("archive_failed");
        expect(failed.archiveError?.attempt).toBe(1);
        expect(failed.archiveError?.kind).toBe("command_failed");
        expect(failed.archiveError?.message).toMatch(/ENOENT|spawn/i);
    });

    it("retries archive after a prior failure via archiveCompletedRun", async () => {
        const { directory, change } = await passedLeanRun();
        const failingConfig: SpecOpsConfig = {
            ...DEFAULT_CONFIG,
            openspec: { ...DEFAULT_CONFIG.openspec, command: ["node", "-e", "process.exit(1)"] },
        };
        await archiveCompletedRun(directory, change, failingConfig);

        // A retry with the working config succeeds.
        const archived = await archiveCompletedRun(directory, change, DEFAULT_CONFIG);
        expect(archived.status).toBe("completed");
        expect(archived.archivedAt).toBeDefined();
        expect(archived.archiveError).toBeUndefined();
        await expect(
            stat(path.join(changeRoot(directory, change), "specops-run.json")),
        ).rejects.toThrow();
    });

    it("records archive_failed with kind incomplete_tasks when tracked tasks remain unchecked", async () => {
        const { directory, change } = await passedLeanRun();
        await writeFile(
            path.join(changeRoot(directory, change), "tasks.md"),
            "# Tasks\n\n- [ ] Finish the remaining implementation\n",
        );

        const failed = await archiveCompletedRun(directory, change, DEFAULT_CONFIG);

        expect(failed.status).toBe("archive_failed");
        expect(failed.archiveError?.kind).toBe("incomplete_tasks");
        expect(failed.archiveError?.message).toMatch(/incomplete task/i);
        // The change directory is still present.
        await expect(stat(path.join(changeRoot(directory, change), "specops-run.json"))).resolves;
    });

    it("rejects archival when a required tasks artifact is deleted or changed", async () => {
        const { directory, change } = await passedLeanRun();
        const tasksPath = path.join(changeRoot(directory, change), "tasks.md");
        const original = await readFile(tasksPath, "utf8");

        await unlink(tasksPath);
        const missing = await archiveCompletedRun(directory, change, DEFAULT_CONFIG);
        expect(missing.archiveError?.kind).toBe("invalid_artifact");

        await writeFile(tasksPath, "# Tasks\n\n- [x] Changed after verification\n");
        const changed = await archiveCompletedRun(directory, change, DEFAULT_CONFIG);
        expect(changed.archiveError?.kind).toBe("invalid_artifact");

        await writeFile(tasksPath, original);
        const restored = await archiveCompletedRun(directory, change, DEFAULT_CONFIG);
        expect(restored.status).toBe("completed");
        expect(restored.archivedAt).toBeDefined();
    });

    it("refuses a path-conflicted paused run without mutating its checkpoint state", async () => {
        const directory = await initializedRepository();
        await onboard(directory);
        const started = await startRun(directory, DEFAULT_CONFIG, {
            goal: "Paused archive conflict",
            assessmentOutput: JSON.stringify(leanAssessment),
            requestedTier: "auto",
            mode: "interactive",
        });
        const paused: RunState = {
            ...started.state,
            status: "paused",
            pauseReason: "checkpoint",
            resumable: true,
            pendingCheckpoint: {
                dispatchId: "checkpoint",
                capability: "verification",
                purpose: "workflow",
                action: "verification",
                artifacts: [],
                output: "# Verification\n\nPASS",
                policyHash: started.state.requirements.policyHash,
                bindingHash: "binding",
                raisedAt: new Date().toISOString(),
            },
        };
        await writeRun(directory, started.change, paused);
        await mkdir(
            path.join(directory, "openspec", "changes", "archive", `2000-01-01-${started.change}`),
            { recursive: true },
        );

        await expect(
            archiveCompletedRun(directory, started.change, DEFAULT_CONFIG),
        ).rejects.toThrow(/not archivable/);
        const current = await readRun(directory, started.change);
        expect(current.status).toBe("paused");
        expect(current.pendingCheckpoint).toBeDefined();
        expect(current.archiveError).toBeUndefined();
    });

    it("records invalid archive output without mutating a foreign directory", async () => {
        const { directory, change } = await passedLeanRun();
        const foreign = path.join(directory, "openspec", "changes", "archive", "foreign");
        await mkdir(foreign, { recursive: true });
        const output = JSON.stringify({ archive: { path: foreign, archivedAs: "wrong-name" } });
        const config = configuredOpenSpec(`process.stdout.write(${JSON.stringify(output)})`);

        const failed = await archiveCompletedRun(directory, change, config);

        expect(failed.status).toBe("archive_failed");
        expect(failed.archiveError?.kind).toBe("invalid_archive_result");
        expect(await readArchiveAttemptSidecar(directory, change)).toBeUndefined();
        await expect(stat(path.join(foreign, "specops-run.json"))).rejects.toThrow();
    });

    it("rejects archive results outside the archive root and traversal paths", async () => {
        for (const kind of ["outside", "traversal"] as const) {
            const { directory, change } = await passedLeanRun();
            const expectedArchivedAs = `${new Date().toISOString().slice(0, 10)}-${change}`;
            const returnedPath =
                kind === "outside"
                    ? path.join(directory, "foreign-archive-target")
                    : "openspec/changes/archive/../foreign-archive-target";
            const output = JSON.stringify({
                archive: { path: returnedPath, archivedAs: expectedArchivedAs },
            });
            const failed = await archiveCompletedRun(
                directory,
                change,
                configuredOpenSpec(`process.stdout.write(${JSON.stringify(output)})`),
            );
            expect(failed.archiveError?.kind).toBe("invalid_archive_result");
        }
    });

    it("rejects archive results whose effective target escapes through a symlink", async () => {
        const { directory, change } = await passedLeanRun();
        const archiveDir = path.join(directory, "openspec", "changes", "archive");
        const foreign = path.join(directory, "foreign-archive-target");
        const expectedArchivedAs = `${new Date().toISOString().slice(0, 10)}-${change}`;
        const symlinkPath = path.join(archiveDir, expectedArchivedAs);
        const output = JSON.stringify({
            archive: {
                path: symlinkPath,
                archivedAs: expectedArchivedAs,
            },
        });
        const script = [
            "const fs=require('node:fs/promises')",
            `const foreign=${JSON.stringify(foreign)}`,
            `const symlinkPath=${JSON.stringify(symlinkPath)}`,
            "(async()=>{",
            "await fs.mkdir(foreign,{recursive:true})",
            "await fs.mkdir(require('node:path').dirname(symlinkPath),{recursive:true})",
            "await fs.symlink(foreign,symlinkPath)",
            `process.stdout.write(${JSON.stringify(output)})`,
            "})().catch(error=>{console.error(error);process.exitCode=1})",
        ].join(";");

        const failed = await archiveCompletedRun(directory, change, configuredOpenSpec(script));

        expect(failed.archiveError?.kind).toBe("invalid_archive_result");
        await expect(stat(path.join(foreign, "specops-run.json"))).rejects.toThrow();
    });

    it("recovers a moved directory after malformed successful output using the sidecar", async () => {
        const { directory, change } = await passedLeanRun();
        const script = [
            "const fs=require('node:fs/promises')",
            "const path=require('node:path')",
            "(async()=>{",
            "const change=process.argv[2]",
            "const date=new Date().toISOString().slice(0,10)",
            "const root=process.cwd()",
            "const archive=path.join(root,'openspec','changes','archive',date+'-'+change)",
            "await fs.mkdir(path.dirname(archive),{recursive:true})",
            "await fs.rename(path.join(root,'openspec','changes',change),archive)",
            "process.stdout.write('not-json')",
            "})().catch(error=>{console.error(error);process.exitCode=1})",
        ].join(";");

        const recovered = await archiveCompletedRun(directory, change, configuredOpenSpec(script));

        expect(recovered.status).toBe("completed");
        expect(recovered.archivedAt).toBeDefined();
        await expect(readArchiveAttemptSidecar(directory, change)).resolves.toBeUndefined();
        await expect(
            stat(path.join(changeRoot(directory, change), "specops-run.json")),
        ).rejects.toThrow();
    });

    it("refuses to archive a run that is not archivable", async () => {
        const directory = await initializedRepository();
        await onboard(directory);
        const started = await startRun(directory, DEFAULT_CONFIG, {
            goal: "Update README wording",
            assessmentOutput: JSON.stringify(leanAssessment),
            requestedTier: "auto",
            mode: "automatic",
        });

        await expect(
            archiveCompletedRun(directory, started.change, DEFAULT_CONFIG),
        ).rejects.toThrow(/not archivable/);
        // The running run state is not corrupted by an archive_failed record.
        const state = await readRun(directory, started.change);
        expect(state.status).toBe("running");
        expect(state.archiveError).toBeUndefined();
    });

    it("archives a Standard run and merges spec deltas into the main specs", async () => {
        const directory = await initializedRepository();
        await onboard(directory);
        const started = await startRun(directory, noArchiveConfig, {
            goal: "Document a compatible behavior",
            assessmentOutput: JSON.stringify({
                ...leanAssessment,
                changeKind: "feature",
                changesRequirements: true,
                suggestedTier: "standard",
            } satisfies Assessment),
            requestedTier: "auto",
            mode: "automatic",
        });
        const root = changeRoot(directory, started.change);
        await mkdir(path.join(root, "specs", "readme"), { recursive: true });
        await writeFile(path.join(root, "exploration.md"), "# Exploration\n\nREADME inspected.\n");
        await writeFile(
            path.join(root, "proposal.md"),
            "# Proposal\n\nDocument compatible behavior.\n",
        );
        await writeFile(
            path.join(root, "specs", "readme", "spec.md"),
            [
                "## ADDED Requirements",
                "",
                "### Requirement: Document compatible behavior",
                "The README SHALL describe the compatible behavior.",
                "",
                "#### Scenario: Reader opens the README",
                "- **WHEN** a reader opens the README",
                "- **THEN** the compatible behavior is described",
                "",
            ].join("\n"),
        );
        await writeFile(path.join(root, "tasks.md"), "# Tasks\n\n- [x] Update README.\n");
        await writeFile(path.join(root, "verification.md"), "# Verification\n\nREADME reviewed.\n");
        await writeFile(
            path.join(root, "judgment-correctness.json"),
            JSON.stringify({ verdict: "PASS", summary: "Correct.", findings: [] }),
        );
        await writeFile(
            path.join(root, "judgment-compliance.json"),
            JSON.stringify({ verdict: "PASS", summary: "Compliant.", findings: [] }),
        );
        await writeFile(
            path.join(root, "review-ledger.json"),
            JSON.stringify({ findings: [], dismissed: [] }),
        );

        for (const artifact of started.state.requirements.requiredArtifacts.filter(
            artifact => artifact !== "routing" && artifact !== "receipt",
        )) {
            started.state.artifacts[artifact] = validArtifact(started.state, artifact);
        }
        started.state.implementationDiffHash = hash("(no implementation diff)");
        const reviewAction = nextAction(started.state);
        if (!reviewAction || reviewAction.capability !== "general-risk") {
            throw new Error("expected general-risk review");
        }
        started.state.dispatches.push({
            ...reviewAction,
            action: reviewAction.mode ?? reviewAction.capability,
            inputHash: dispatchHash(reviewAction, started.state),
            outputHash: "output",
            status: "completed",
            at: "now",
        });
        await writeRun(directory, started.change, started.state);

        const finalized = await finalizeRun(directory, started.change, noArchiveConfig);
        expect(finalized.status).toBe("completed");

        const fileArtifacts: Partial<Record<ArtifactId, string>> = {
            routing: "routing.md",
            exploration: "exploration.md",
            proposal: "proposal.md",
            tasks: "tasks.md",
            verification: "verification.md",
            "correctness-judgment": "judgment-correctness.json",
            "compliance-judgment": "judgment-compliance.json",
            "review-ledger": "review-ledger.json",
        };
        for (const [artifact, relative] of Object.entries(fileArtifacts) as Array<
            [ArtifactId, string]
        >) {
            const content = await readFile(path.join(root, relative), "utf8");
            finalized.artifacts[artifact]!.outputHash = hash(content.trim());
        }
        finalized.artifacts.specs!.outputHash = hash(
            JSON.stringify({
                readme: (await readFile(path.join(root, "specs/readme/spec.md"), "utf8")).trim(),
            }),
        );
        finalized.artifacts.implementation!.outputHash = hash(finalized.implementationDiffHash!);

        // Rewrite to passed and archive via archiveCompletedRun.
        await writeRun(directory, started.change, {
            ...finalized,
            status: "passed",
            archivedAt: undefined,
        });
        const archived = await archiveCompletedRun(directory, started.change, DEFAULT_CONFIG);
        expect(archived.status).toBe("completed");
        expect(archived.archiveError).toBeUndefined();

        // Standard archive merges the delta into openspec/specs/<capability>/spec.md.
        const mergedSpec = path.join(directory, "openspec", "specs", "readme", "spec.md");
        const merged = await readFile(mergedSpec, "utf8");
        expect(merged).toContain("Document compatible behavior");
        expect(merged).toContain("The README SHALL describe the compatible behavior.");
        await expect(stat(path.join(root, "specops-run.json"))).rejects.toThrow();
    });

    it("serializes concurrent archive attempts across the directory move", async () => {
        const { directory, change } = await passedLeanRun();

        const results = await Promise.allSettled([
            archiveCompletedRun(directory, change, DEFAULT_CONFIG),
            archiveCompletedRun(directory, change, DEFAULT_CONFIG),
        ]);
        const fulfilled = results.filter(result => result.status === "fulfilled");
        const rejected = results.filter(result => result.status === "rejected");
        // The archive lock serializes the two calls: the first performs the
        // move and deletes the recovery sidecar; the second finds the active
        // directory gone with no sidecar and rejects safely.
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        if (fulfilled[0]?.status === "fulfilled") {
            expect(fulfilled[0].value.status).toBe("completed");
        }
        // Exactly one archive entry exists.
        const archiveDir = path.join(directory, "openspec", "changes", "archive");
        const entries = (await readdir(archiveDir)).filter(name => name.endsWith(change));
        expect(entries).toHaveLength(1);
    });

    it("rejects repeated finalize and maintenance calls without recreating the active root", async () => {
        const { directory, change } = await passedLeanRun();
        const first = await archiveCompletedRun(directory, change, DEFAULT_CONFIG);

        expect(first.status).toBe("completed");
        await expect(finalizeRun(directory, change, DEFAULT_CONFIG)).rejects.toThrow(
            /recovery identity is unavailable/,
        );
        await expect(archiveCompletedRun(directory, change, noArchiveConfig)).rejects.toThrow(
            /recovery identity is unavailable/,
        );
        await expect(
            stat(path.join(changeRoot(directory, change), "specops-run.json")),
        ).rejects.toThrow();
    });

    it("waits for an in-flight run transaction before moving the change", async () => {
        const { directory, change } = await passedLeanRun();
        let release!: () => void;
        let entered!: () => void;
        const released = new Promise<void>(resolve => {
            release = resolve;
        });
        const started = new Promise<void>(resolve => {
            entered = resolve;
        });
        const mutation = withRunLock(directory, change, "hold mutation", async () => {
            entered();
            await released;
        });
        await started;

        const archive = archiveCompletedRun(directory, change, DEFAULT_CONFIG);
        const archiveRejected = expect(archive).rejects.toThrow("being mutated");
        await new Promise(resolve => setTimeout(resolve, 25));
        await expect(stat(path.join(changeRoot(directory, change), "specops-run.json"))).resolves;

        await archiveRejected;
        release();
        await mutation;
        expect((await archiveCompletedRun(directory, change, DEFAULT_CONFIG)).status).toBe(
            "completed",
        );
    });

    it("recovers a prepared in-directory transaction before archiving", async () => {
        const { directory, change } = await passedLeanRun();
        const root = changeRoot(directory, change);
        const transaction = path.join(root, "specops-transaction", "prepared");
        const content = '{"recovered":true}\n';
        await mkdir(path.join(transaction, "files"), { recursive: true });
        await writeFile(path.join(transaction, "files", "specops-context.json"), content);
        await writeFile(
            path.join(transaction, "manifest.json"),
            JSON.stringify({
                version: 1,
                id: "prepared",
                status: "prepared",
                entries: [
                    {
                        destination: "specops-context.json",
                        staged: "files/specops-context.json",
                        hash: hash(content),
                    },
                ],
            }),
        );

        const archived = await archiveCompletedRun(directory, change, DEFAULT_CONFIG);

        expect(archived.status).toBe("completed");
        const archiveDir = path.join(directory, "openspec", "changes", "archive");
        const moved = (await readdir(archiveDir)).find(name => name.endsWith(change))!;
        await expect(
            readFile(path.join(archiveDir, moved, "specops-context.json"), "utf8"),
        ).resolves.toBe(content);
        await expect(stat(path.join(archiveDir, moved, "specops-transaction"))).rejects.toThrow();
    });

    it("exposes the maintenance archive tool through the registered public tools", async () => {
        const { directory, change } = await passedLeanRun();
        const plugin = await SpecOpsPlugin({} as never);
        const archiveTool = plugin.tool?.[TOOL_IDS.archive];
        if (!archiveTool) throw new Error("archive tool was not registered");
        // The confirmArchive tool no longer exists.
        expect(plugin.tool?.["specops_confirm_archive"]).toBeUndefined();

        const result = await archiveTool.execute({ change }, {
            directory,
            agent: AGENT_IDS.controller.automatic,
        } as never);
        const output = typeof result === "string" ? result : result.output;
        expect(output).toContain("Run archived");
        await expect(
            stat(path.join(changeRoot(directory, change), "specops-run.json")),
        ).rejects.toThrow();
    });

    it("reports maintenance success for a real completed-unarchived run", async () => {
        const { directory, change } = await verifiedLeanRun();
        const plugin = await SpecOpsPlugin({} as never);
        const archiveTool = plugin.tool?.[TOOL_IDS.archive];
        if (!archiveTool) throw new Error("archive tool was not registered");

        const result = await archiveTool.execute({ change }, {
            directory,
            agent: AGENT_IDS.controller.interactive,
        } as never);
        const output = typeof result === "string" ? result : result.output;
        expect(output).toContain("Run archived");
        expect(output).not.toContain("Archive not completed");
        await expect(
            stat(path.join(changeRoot(directory, change), "specops-run.json")),
        ).rejects.toThrow();
    });
});

describe("archive crash recovery", () => {
    it("recovers an archiving run whose directory was already moved", async () => {
        const { directory, change, state } = await passedLeanRun();
        const activeDir = changeRoot(directory, change);
        const archiveDir = path.join(directory, "openspec", "changes", "archive");
        await mkdir(archiveDir, { recursive: true });
        const expectedArchivedAs = `${new Date().toISOString().slice(0, 10)}-${change}`;
        const movedDir = path.join(archiveDir, expectedArchivedAs);
        // Simulate the archive command having moved the directory but the
        // process crashing before the completed state was written.
        await rename(activeDir, movedDir);
        const archivingState: RunState = { ...state, status: "archiving" };
        await writeRunIn(movedDir, archivingState);
        const nextRevision = state.revision + 1;
        await writeArchiveAttemptSidecar(directory, change, {
            expectedArchivedAs,
            runRevision: nextRevision,
            runCreatedAt: state.createdAt,
            runBaseline: state.baseline,
            attemptAt: new Date().toISOString(),
        });
        // writeRunIn incremented the revision; update the sidecar's expectation
        // to the actual persisted revision so identity verification matches.
        const movedState = await readRunIn(movedDir);
        await writeArchiveAttemptSidecar(directory, change, {
            expectedArchivedAs,
            runRevision: movedState.revision,
            runCreatedAt: state.createdAt,
            runBaseline: state.baseline,
            attemptAt: new Date().toISOString(),
        });

        const recovered = await archiveCompletedRun(directory, change, DEFAULT_CONFIG);

        expect(recovered.status).toBe("completed");
        expect(recovered.archivedAt).toBeDefined();
        expect(recovered.archiveError).toBeUndefined();
        // The active directory was not recreated.
        await expect(stat(path.join(activeDir, "specops-run.json"))).rejects.toThrow();
        // The sidecar was cleaned up.
        await expect(readArchiveAttemptSidecar(directory, change)).resolves.toBeUndefined();
        void nextRevision;
    });

    it.each(["2026-08-03-foo", "2026-08-03-bar-foo"])(
        "rejects a completed candidate without a sidecar for requested change foo: %s",
        async archivedAs => {
            const { directory, change } = await passedLeanRun();
            const { candidate } = await moveCompletedCandidate(directory, change, archivedAs);
            const statePath = path.join(candidate, "specops-run.json");
            const before = await readFile(statePath, "utf8");

            await expect(archiveCompletedRun(directory, "foo", DEFAULT_CONFIG)).rejects.toThrow(
                /recovery identity is unavailable/,
            );
            await expect(readFile(statePath, "utf8")).resolves.toBe(before);
        },
    );

    it("rejects multiple completed candidates without a sidecar without mutating either", async () => {
        const { directory, change } = await passedLeanRun();
        const first = await moveCompletedCandidate(directory, change, `2026-08-03-${change}`);
        const secondCandidate = path.join(
            directory,
            "openspec",
            "changes",
            "archive",
            `2026-08-04-${change}`,
        );
        await mkdir(secondCandidate, { recursive: true });
        await writeRunIn(secondCandidate, first.state);
        const firstPath = path.join(first.candidate, "specops-run.json");
        const secondPath = path.join(secondCandidate, "specops-run.json");
        const firstBefore = await readFile(firstPath, "utf8");
        const secondBefore = await readFile(secondPath, "utf8");

        await expect(archiveCompletedRun(directory, change, DEFAULT_CONFIG)).rejects.toThrow(
            /recovery identity is unavailable/,
        );
        await expect(readFile(firstPath, "utf8")).resolves.toBe(firstBefore);
        await expect(readFile(secondPath, "utf8")).resolves.toBe(secondBefore);
    });

    it("accepts a completed candidate when a valid sidecar proves its identity", async () => {
        const { directory, change } = await passedLeanRun();
        const { candidate, state } = await moveCompletedCandidate(
            directory,
            change,
            `2026-08-03-${change}`,
        );
        await writeArchiveAttemptSidecar(directory, change, {
            expectedArchivedAs: path.basename(candidate),
            runRevision: state.revision,
            runCreatedAt: state.createdAt,
            runBaseline: state.baseline,
            attemptAt: new Date().toISOString(),
        });

        const recovered = await archiveCompletedRun(directory, change, DEFAULT_CONFIG);

        expect(recovered.status).toBe("completed");
        expect(recovered.archivedAt).toBe(state.archivedAt);
        await expect(readRunIn(candidate)).resolves.toEqual(state);
        await expect(readArchiveAttemptSidecar(directory, change)).resolves.toBeUndefined();
    });

    it("rejects a completed candidate when the sidecar identity does not match", async () => {
        const { directory, change } = await passedLeanRun();
        const { candidate, state } = await moveCompletedCandidate(
            directory,
            change,
            `2026-08-03-${change}`,
        );
        await writeArchiveAttemptSidecar(directory, change, {
            expectedArchivedAs: path.basename(candidate),
            runRevision: state.revision + 1,
            runCreatedAt: state.createdAt,
            runBaseline: state.baseline,
            attemptAt: new Date().toISOString(),
        });
        const before = await readFile(path.join(candidate, "specops-run.json"), "utf8");

        await expect(archiveCompletedRun(directory, change, DEFAULT_CONFIG)).rejects.toThrow(
            /no archived candidate matches the recovery identity/,
        );
        await expect(readFile(path.join(candidate, "specops-run.json"), "utf8")).resolves.toBe(
            before,
        );
    });

    it("does not recover a single archived archiving candidate without a sidecar", async () => {
        const { directory, change } = await passedLeanRun();
        const archiveDir = path.join(directory, "openspec", "changes", "archive");
        const candidate = path.join(archiveDir, `2000-01-01-${change}`);
        await mkdir(archiveDir, { recursive: true });
        await rename(changeRoot(directory, change), candidate);
        const moved = await readRunIn(candidate);
        await writeRunIn(candidate, { ...moved, status: "archiving" });

        await expect(archiveCompletedRun(directory, change, DEFAULT_CONFIG)).rejects.toThrow(
            /recovery identity is unavailable/,
        );
        expect((await readRunIn(candidate)).status).toBe("archiving");
    });

    it("fails safely when multiple archived candidates match", async () => {
        const { directory, change, state } = await passedLeanRun();
        const activeDir = changeRoot(directory, change);
        const archiveDir = path.join(directory, "openspec", "changes", "archive");
        const date = new Date().toISOString().slice(0, 10);
        // Two archived candidates with different date prefixes.
        for (const prefix of [`${date}-a`, `${date}-b`]) {
            const candidateDir = path.join(archiveDir, `${prefix}-${change}`);
            await mkdir(candidateDir, { recursive: true });
            await writeRunIn(candidateDir, { ...state, status: "archiving" });
        }
        await rename(activeDir, path.join(archiveDir, `${date}-c-${change}`));
        await expect(archiveCompletedRun(directory, change, DEFAULT_CONFIG)).rejects.toThrow(
            /recovery identity is unavailable/,
        );
    });

    it("reports a missing change when no active directory and no candidate exist", async () => {
        const { directory, change } = await passedLeanRun();
        const activeDir = changeRoot(directory, change);
        await rename(
            activeDir,
            path.join(directory, "openspec", "changes", "archive", `moved-${change}`),
        );

        await expect(archiveCompletedRun(directory, change, DEFAULT_CONFIG)).rejects.toThrow(
            /recovery identity is unavailable/,
        );
    });

    it("detects a path conflict when both source and an archive entry exist", async () => {
        const { directory, change } = await passedLeanRun();
        const archiveDir = path.join(directory, "openspec", "changes", "archive");
        const date = new Date().toISOString().slice(0, 10);
        const candidateDir = path.join(archiveDir, `${date}-${change}`);
        await mkdir(candidateDir, { recursive: true });

        const failed = await archiveCompletedRun(directory, change, DEFAULT_CONFIG);
        expect(failed.status).toBe("archive_failed");
        expect(failed.archiveError?.kind).toBe("path_conflict");
    });
});

describe("store validation of archive fields", () => {
    it("rejects archivedAt set on a non-completed run", async () => {
        const { directory, change } = await passedLeanRun();
        const statePath = path.join(changeRoot(directory, change), "specops-run.json");
        const raw = JSON.parse(await readFile(statePath, "utf8")) as RunState;
        raw.archivedAt = new Date().toISOString();
        await writeFile(statePath, `${JSON.stringify(raw, null, 2)}\n`);
        await expect(readRun(directory, change)).rejects.toThrow(
            /archivedAt may only be set on a completed/,
        );
    });

    it("rejects an archiveError with an unknown kind", async () => {
        const { directory, change } = await passedLeanRun();
        const statePath = path.join(changeRoot(directory, change), "specops-run.json");
        const raw = JSON.parse(await readFile(statePath, "utf8")) as RunState;
        raw.status = "archive_failed";
        raw.archiveError = {
            attempt: 1,
            kind: "bogus" as RunState["archiveError"] extends infer E
                ? E extends { kind: infer K }
                    ? K
                    : never
                : never,
            message: "x",
            at: new Date().toISOString(),
        };
        raw.outcome = { category: "completed", message: "done", at: new Date().toISOString() };
        await writeFile(statePath, `${JSON.stringify(raw, null, 2)}\n`);
        await expect(readRun(directory, change)).rejects.toThrow(
            /invalid SpecOps archive error state/,
        );
    });

    it("rejects archive_failed without an archiveError", async () => {
        const { directory, change } = await passedLeanRun();
        const statePath = path.join(changeRoot(directory, change), "specops-run.json");
        const raw = JSON.parse(await readFile(statePath, "utf8")) as RunState;
        raw.status = "archive_failed";
        raw.outcome = { category: "completed", message: "done", at: new Date().toISOString() };
        await writeFile(statePath, `${JSON.stringify(raw, null, 2)}\n`);
        await expect(readRun(directory, change)).rejects.toThrow(
            /archive_failed state requires an archive error/,
        );
    });
});

describe("countIncompleteTasks", () => {
    async function writeTasks(directory: string, change: string, content: string): Promise<void> {
        await writeFile(path.join(changeRoot(directory, change), "tasks.md"), content);
    }

    it("counts unchecked task boxes in the canonical tasks file", async () => {
        const { directory, change } = await passedLeanRun();
        await writeTasks(
            directory,
            change,
            "# Tasks\n\n- [x] Done\n- [ ] Pending\n- [ ] Also pending\n",
        );
        expect(await countIncompleteTasks(directory, change)).toBe(2);
    });

    it("ignores task-like lines inside fenced code blocks", async () => {
        const { directory, change } = await passedLeanRun();
        await writeTasks(
            directory,
            change,
            [
                "# Tasks",
                "",
                "- [x] Done",
                "",
                "```",
                "- [ ] This is an example, not a task",
                "```",
                "",
                "- [ ] Real pending task",
                "",
            ].join("\n"),
        );
        expect(await countIncompleteTasks(directory, change)).toBe(1);
    });

    it("ignores task-like lines inside HTML comments", async () => {
        const { directory, change } = await passedLeanRun();
        await writeTasks(
            directory,
            change,
            [
                "# Tasks",
                "",
                "<!--",
                "- [ ] Quoted example inside a comment",
                "-->",
                "",
                "- [ ] Real pending task",
                "",
            ].join("\n"),
        );
        expect(await countIncompleteTasks(directory, change)).toBe(1);
    });

    it("counts a leading checkbox with an inline HTML comment", async () => {
        const { directory, change } = await passedLeanRun();
        await writeTasks(
            directory,
            change,
            [
                "- [ ] Implement feature <!-- tracked note -->",
                "<!-- - [ ] Commented example -->",
                "<!--",
                "- [ ] Multiline example",
                "-->",
            ].join("\n"),
        );

        expect(await countIncompleteTasks(directory, change)).toBe(1);
    });

    it("uses the canonical tasks file and does not recurse when it exists", async () => {
        const { directory, change } = await passedLeanRun();
        await writeTasks(directory, change, "# Tasks\n\n- [x] Done\n");
        // A nested tasks file with unchecked boxes should be ignored.
        await mkdir(path.join(changeRoot(directory, change), "nested"), { recursive: true });
        await writeFile(
            path.join(changeRoot(directory, change), "nested", "tasks.md"),
            "# Nested Tasks\n\n- [ ] Should be ignored\n",
        );
        expect(await countIncompleteTasks(directory, change)).toBe(0);
    });

    it("recurses into nested directories only when no canonical tasks file exists", async () => {
        const directory = await initializedRepository();
        await onboard(directory);
        // No canonical tasks.md; create a nested one.
        const change = "nested-tasks-test";
        await mkdir(path.join(directory, "openspec", "changes", change, "nested"), {
            recursive: true,
        });
        await writeFile(
            path.join(directory, "openspec", "changes", change, "nested", "tasks.md"),
            "# Nested Tasks\n\n- [ ] Pending\n",
        );
        expect(await countIncompleteTasks(directory, change)).toBe(1);
    });
});

// Silence the unused-import linter for contracts imported for completeness parity
// with the sibling lean-workflow test harness.
void ASSURANCE_FINDINGS_CONTRACT;
void JUDGMENT_CONTRACT;
void REVIEW_LEDGER_CONTRACT;
void AGENT_IDS;

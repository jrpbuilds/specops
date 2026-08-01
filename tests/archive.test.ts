import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile, readdir, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { AGENT_IDS } from "../src/capabilities/ids.js"
import { hash } from "../src/artifacts/lifecycle.js"
import { DEFAULT_CONFIG, type SpecOpsConfig } from "../src/config.js"
import { onboard } from "../src/openspec.js"
import { SpecOpsPlugin } from "../src/orchestrator.js"
import { TOOL_IDS } from "../src/protocol.js"
import { requirementsFor, scopeForActualDiff } from "../src/routing/policy.js"
import { changeRoot, readRun, writeRun } from "../src/state/store.js"
import type { ArtifactId, Assessment, RunState } from "../src/types.js"
import {
    archiveRun,
    completeAction,
    confirmArchiveRun,
    finalizeRun,
    issueDirective,
    startRun,
} from "../src/workflow/engine.js"
import { nextAction, dispatchHash } from "../src/workflow/scheduler.js"
import {
    ASSURANCE_FINDINGS_CONTRACT,
    JUDGMENT_CONTRACT,
    REVIEW_LEDGER_CONTRACT,
} from "../src/workflow/contracts.generated.js"

const leanAssessment: Assessment = {
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
    }
}

function assuranceBundle(): string {
    return JSON.stringify({
        verification: "# Verification\n\nREADME links pass.",
        correctnessJudgment: { verdict: "PASS", summary: "Correct.", findings: [] },
        reviewLedger: { findings: [] },
    })
}

async function initializedRepository(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "specops-archive-repository-"))
    execFileSync("git", ["init", "--quiet"], { cwd: directory })
    execFileSync("git", ["config", "user.email", "specops@example.test"], { cwd: directory })
    execFileSync("git", ["config", "user.name", "SpecOps Test"], { cwd: directory })
    await writeFile(path.join(directory, "README.md"), "# Test\n")
    execFileSync("git", ["add", "README.md"], { cwd: directory })
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: directory })
    return directory
}

/** Drive a complete Lean lifecycle (automatic mode) to a `passed` run. */
async function passedLeanRun(): Promise<{ directory: string; change: string; state: RunState }> {
    const directory = await initializedRepository()
    await onboard(directory)
    const started = await startRun(directory, DEFAULT_CONFIG, {
        goal: "Update README wording",
        assessmentOutput: JSON.stringify(leanAssessment),
        requestedTier: "auto",
        mode: "automatic",
    })

    const planning = await issueDirective(directory, started.change, DEFAULT_CONFIG)
    if (planning.type !== "dispatch") throw new Error("expected planning dispatch")
    await completeAction(
        directory,
        started.change,
        planning.action.id,
        "# Tasks\n\n- Update the README wording.",
        DEFAULT_CONFIG,
    )

    const implementation = await issueDirective(directory, started.change, DEFAULT_CONFIG)
    if (implementation.type !== "dispatch") throw new Error("expected implementation dispatch")
    await writeFile(path.join(directory, "README.md"), "# Updated test\n")
    await completeAction(
        directory,
        started.change,
        implementation.action.id,
        "Updated README wording.",
        DEFAULT_CONFIG,
    )

    const verification = await issueDirective(directory, started.change, DEFAULT_CONFIG)
    if (verification.type !== "dispatch") throw new Error("expected verifier dispatch")
    await completeAction(
        directory,
        started.change,
        verification.action.id,
        assuranceBundle(),
        DEFAULT_CONFIG,
    )

    const finalized = await finalizeRun(directory, started.change, DEFAULT_CONFIG)
    if (finalized.status !== "passed") throw new Error(`expected passed, got ${finalized.status}`)
    return { directory, change: started.change, state: finalized }
}

describe("archive phase", () => {
    it("raises a confirmation gate on a passed run without mutating the change directory", async () => {
        const { directory, change } = await passedLeanRun()
        const before = await readRun(directory, change)

        const raised = await archiveRun(directory, change)

        expect(raised.status).toBe("passed")
        expect(raised.archivePending).toBeDefined()
        expect(raised.archivePending?.id).toMatch(/^[0-9a-f-]{36}$/)
        expect(raised.archivePending?.scopeTier).toBe("lean")
        // The terminal outcome is preserved while the gate is pending.
        expect(raised.outcome).toEqual(before.outcome)
        // The change directory is untouched (no move yet).
        await expect(stat(path.join(changeRoot(directory, change), "specops-run.json"))).resolves
    })

    it("returns the same persisted confirmation while a request is pending", async () => {
        const { directory, change } = await passedLeanRun()
        const first = await archiveRun(directory, change)

        const second = await archiveRun(directory, change)
        expect(second.archivePending?.id).toBe(first.archivePending?.id)
    })

    it("rejects a stale confirmation id", async () => {
        const { directory, change } = await passedLeanRun()
        await archiveRun(directory, change)

        await expect(
            confirmArchiveRun(directory, change, DEFAULT_CONFIG, "wrong-id", "archive"),
        ).rejects.toThrow(/missing, stale, or already consumed/)
    })

    it("declines a pending confirmation and leaves the run passed", async () => {
        const { directory, change } = await passedLeanRun()
        const raised = await archiveRun(directory, change)

        const declined = await confirmArchiveRun(
            directory,
            change,
            DEFAULT_CONFIG,
            raised.archivePending!.id,
            "decline",
        )

        expect(declined.status).toBe("passed")
        expect(declined.archivePending).toBeUndefined()
        expect(declined.outcome).toBeDefined()
        await expect(stat(path.join(changeRoot(directory, change), "specops-run.json"))).resolves
    })

    it("decline with no pending confirmation is an error", async () => {
        const { directory, change } = await passedLeanRun()

        await expect(
            confirmArchiveRun(directory, change, DEFAULT_CONFIG, "missing", "decline"),
        ).rejects.toThrow(/missing, stale, or already consumed/)
    })

    it("archives a passed Lean run on a matching confirmation id and moves the change directory", async () => {
        const { directory, change } = await passedLeanRun()
        const raised = await archiveRun(directory, change)
        const confirmationId = raised.archivePending!.id

        const archived = await confirmArchiveRun(
            directory,
            change,
            DEFAULT_CONFIG,
            confirmationId,
            "archive",
        )

        expect(archived.status).toBe("passed")
        expect(archived.archivePending).toBeUndefined()
        expect(archived.archiveError).toBeUndefined()
        // The original change directory is gone (moved to openspec/changes/archive/).
        await expect(
            stat(path.join(changeRoot(directory, change), "specops-run.json")),
        ).rejects.toThrow()

        const archiveDir = path.join(directory, "openspec", "changes", "archive")
        const entries = await readdir(archiveDir)
        const moved = entries.find(name => name.endsWith(change))
        expect(moved, "archived change directory was not created").toBeDefined()
        // The persisted passed state moved with the change directory.
        const movedState = JSON.parse(
            await readFile(path.join(archiveDir, moved!, "specops-run.json"), "utf8"),
        ) as RunState
        expect(movedState.status).toBe("passed")
        expect(movedState.archiveError).toBeUndefined()
    })

    it("records a retryable archiveError and keeps the run passed when archive fails", async () => {
        const { directory, change } = await passedLeanRun()
        const raised = await archiveRun(directory, change)
        const confirmationId = raised.archivePending!.id

        // A failing OpenSpec binary: exit non-zero with a stderr message.
        const failingConfig: SpecOpsConfig = {
            ...DEFAULT_CONFIG,
            openspec: {
                command: [
                    "node",
                    "-e",
                    "process.stderr.write('archive failed: simulated'); process.exit(1)",
                ],
            },
        }

        const failed = await confirmArchiveRun(
            directory,
            change,
            failingConfig,
            confirmationId,
            "archive",
        )

        expect(failed.status).toBe("passed")
        expect(failed.archivePending).toBeUndefined()
        expect(failed.archiveError).toBeDefined()
        expect(failed.archiveError?.attempt).toBe(1)
        expect(failed.archiveError?.message).toContain("simulated")
        // The change directory is still present (archive did not move it).
        await expect(stat(path.join(changeRoot(directory, change), "specops-run.json"))).resolves
    })

    it("records a retryable archiveError when the OpenSpec process cannot spawn", async () => {
        const { directory, change } = await passedLeanRun()
        const raised = await archiveRun(directory, change)
        const brokenConfig: SpecOpsConfig = {
            ...DEFAULT_CONFIG,
            openspec: { command: ["/definitely/missing/specops"] },
        }

        const failed = await confirmArchiveRun(
            directory,
            change,
            brokenConfig,
            raised.archivePending!.id,
            "archive",
        )

        expect(failed.status).toBe("passed")
        expect(failed.archiveError?.attempt).toBe(1)
        expect(failed.archiveError?.message).toMatch(/ENOENT|spawn/i)
    })

    it("blocks archive when tracked tasks are incomplete", async () => {
        const { directory, change } = await passedLeanRun()
        await writeFile(
            path.join(changeRoot(directory, change), "tasks.md"),
            "# Tasks\n\n- [ ] Finish the remaining implementation\n",
        )
        const raised = await archiveRun(directory, change)

        await expect(
            confirmArchiveRun(
                directory,
                change,
                DEFAULT_CONFIG,
                raised.archivePending!.id,
                "archive",
            ),
        ).rejects.toThrow(/incomplete task/)
        expect((await readRun(directory, change)).archivePending).toBeDefined()
    })

    it("rejects malformed persisted archive confirmation state", async () => {
        const { directory, change } = await passedLeanRun()
        const statePath = path.join(changeRoot(directory, change), "specops-run.json")
        const raw = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>
        raw.archivePending = {
            id: "not-a-uuid",
            scopeTier: "lean",
            raisedAt: new Date().toISOString(),
        }
        await writeFile(statePath, `${JSON.stringify(raw, null, 2)}\n`)

        await expect(readRun(directory, change)).rejects.toThrow(
            /invalid SpecOps archive confirmation state/,
        )
    })

    it("retries archive after a prior failure by raising a fresh confirmation", async () => {
        const { directory, change } = await passedLeanRun()
        const first = await archiveRun(directory, change)
        const failingConfig: SpecOpsConfig = {
            ...DEFAULT_CONFIG,
            openspec: {
                command: ["node", "-e", "process.exit(1)"],
            },
        }
        await confirmArchiveRun(
            directory,
            change,
            failingConfig,
            first.archivePending!.id,
            "archive",
        )

        // A retry raises a new confirmation gate (fresh id), then succeeds.
        const reraised = await archiveRun(directory, change)
        expect(reraised.archivePending?.id).not.toBe(first.archivePending!.id)
        const archived = await confirmArchiveRun(
            directory,
            change,
            DEFAULT_CONFIG,
            reraised.archivePending!.id,
            "archive",
        )
        expect(archived.archiveError).toBeUndefined()
        await expect(
            stat(path.join(changeRoot(directory, change), "specops-run.json")),
        ).rejects.toThrow()
    })

    it("refuses to archive a run that is not passed", async () => {
        const directory = await initializedRepository()
        await onboard(directory)
        const started = await startRun(directory, DEFAULT_CONFIG, {
            goal: "Update README wording",
            assessmentOutput: JSON.stringify(leanAssessment),
            requestedTier: "auto",
            mode: "automatic",
        })

        await expect(archiveRun(directory, started.change)).rejects.toThrow(/not passed/)
    })

    it("archives a Standard run and merges spec deltas into the main specs", async () => {
        const directory = await initializedRepository()
        await onboard(directory)
        const started = await startRun(directory, DEFAULT_CONFIG, {
            goal: "Document a compatible behavior",
            assessmentOutput: JSON.stringify({
                ...leanAssessment,
                changeKind: "feature",
                changesRequirements: true,
                suggestedTier: "standard",
            } satisfies Assessment),
            requestedTier: "auto",
            mode: "automatic",
        })
        const root = changeRoot(directory, started.change)
        await mkdir(path.join(root, "specs", "readme"), { recursive: true })
        await writeFile(path.join(root, "exploration.md"), "# Exploration\n\nREADME inspected.\n")
        await writeFile(
            path.join(root, "proposal.md"),
            "# Proposal\n\nDocument compatible behavior.\n",
        )
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
        )
        await writeFile(path.join(root, "tasks.md"), "# Tasks\n\n- [x] Update README.\n")
        await writeFile(path.join(root, "verification.md"), "# Verification\n\nREADME reviewed.\n")
        await writeFile(
            path.join(root, "judgment-correctness.json"),
            JSON.stringify({ verdict: "PASS", summary: "Correct.", findings: [] }),
        )
        await writeFile(
            path.join(root, "judgment-compliance.json"),
            JSON.stringify({ verdict: "PASS", summary: "Compliant.", findings: [] }),
        )
        await writeFile(
            path.join(root, "review-ledger.json"),
            JSON.stringify({ findings: [], dismissed: [] }),
        )

        for (const artifact of started.state.requirements.requiredArtifacts.filter(
            artifact => artifact !== "routing" && artifact !== "receipt",
        )) {
            started.state.artifacts[artifact] = validArtifact(started.state, artifact)
        }
        started.state.implementationDiffHash = hash("(no implementation diff)")
        const reviewAction = nextAction(started.state)
        if (!reviewAction || reviewAction.capability !== "general-risk") {
            throw new Error("expected general-risk review")
        }
        started.state.dispatches.push({
            ...reviewAction,
            action: reviewAction.mode ?? reviewAction.capability,
            inputHash: dispatchHash(reviewAction, started.state),
            outputHash: "output",
            status: "completed",
            at: "now",
        })
        await writeRun(directory, started.change, started.state)

        const finalized = await finalizeRun(directory, started.change, DEFAULT_CONFIG)
        expect(finalized.status).toBe("passed")

        const raised = await archiveRun(directory, started.change)
        const archived = await confirmArchiveRun(
            directory,
            started.change,
            DEFAULT_CONFIG,
            raised.archivePending!.id,
            "archive",
        )

        expect(archived.archiveError).toBeUndefined()
        // Standard archive merges the delta into openspec/specs/<capability>/spec.md.
        const mergedSpec = path.join(directory, "openspec", "specs", "readme", "spec.md")
        const merged = await readFile(mergedSpec, "utf8")
        expect(merged).toContain("Document compatible behavior")
        expect(merged).toContain("The README SHALL describe the compatible behavior.")
        // The original change directory is gone.
        await expect(stat(path.join(root, "specops-run.json"))).rejects.toThrow()
    })

    it("serializes concurrent confirmations across the archive directory move", async () => {
        const { directory, change } = await passedLeanRun()
        const raised = await archiveRun(directory, change)
        const confirmationId = raised.archivePending!.id

        const results = await Promise.allSettled([
            confirmArchiveRun(directory, change, DEFAULT_CONFIG, confirmationId, "archive"),
            confirmArchiveRun(directory, change, DEFAULT_CONFIG, confirmationId, "archive"),
        ])
        expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
        expect(results.filter(result => result.status === "rejected")).toHaveLength(1)
        const rejection = results.find(result => result.status === "rejected")
        expect(rejection?.status === "rejected" ? String(rejection.reason) : "").toMatch(
            /archive is busy|already archived|no run state/,
        )
    })

    it("exposes native confirmation through the registered public tools", async () => {
        const { directory, change } = await passedLeanRun()
        const plugin = await SpecOpsPlugin({} as never)
        const archiveTool = plugin.tool?.[TOOL_IDS.archive]
        const confirmTool = plugin.tool?.[TOOL_IDS.confirmArchive]
        if (!archiveTool || !confirmTool) throw new Error("archive tools were not registered")

        await expect(
            archiveTool.execute({ change }, {
                directory,
                agent: AGENT_IDS.controller.automatic,
            } as never),
        ).rejects.toThrow(/interactive controller/)

        const requestResult = await archiveTool.execute({ change }, {
            directory,
            agent: AGENT_IDS.controller.interactive,
        } as never)
        const request = JSON.parse(
            typeof requestResult === "string" ? requestResult : requestResult.output,
        ) as { type: string; confirmationId: string; questionTools: unknown[] }
        expect(request.type).toBe("archive-confirmation")
        expect(request.questionTools).toHaveLength(1)

        const result = await confirmTool.execute(
            { change, confirmationId: request.confirmationId, decision: "decline" },
            { directory, agent: AGENT_IDS.controller.interactive } as never,
        )
        expect(typeof result === "string" ? result : result.output).toContain("Archive declined")
    })
})

// Silence the unused-import linter for contracts imported for completeness parity
// with the sibling lean-workflow test harness.
void ASSURANCE_FINDINGS_CONTRACT
void JUDGMENT_CONTRACT
void REVIEW_LEDGER_CONTRACT
void AGENT_IDS
void requirementsFor
void scopeForActualDiff

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_IDS } from "../src/agents/ids.js";
import { SpecOpsPlugin } from "../src/plugin.js";
import { WORKFLOW_TOOL_IDS } from "../src/workflow/tools.js";
import { createV1Run, readV1Run, updateV1Run } from "../src/state/store.js";
import { reviewPath } from "../src/state/paths.js";
import { reconcileStage } from "../src/workflow/reconcile.js";
import { MAX_REVIEW_REPAIRS } from "../src/workflow/limits.js";
import { collectDoctorDiagnostics } from "../src/doctor.js";

const identity = "a".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map(directory => rm(directory, { recursive: true, force: true })),
    );
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "specops-phase11-"));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, ".specops", "runs", "phase11"), {
        recursive: true,
    });
    return directory;
}

/** Initialize a minimal git repository so the real repository identity works. */
async function gitRepository(): Promise<string> {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, ".gitignore"), "node_modules/\n");
    await writeFile(path.join(directory, "README.md"), "# phase11\n");
    const { exec } = await import("node:child_process");
    await new Promise<void>((resolve, reject) =>
        exec(
            "git init -q && git add -A && git -c user.name=t -c user.email=t commit -qm init",
            {
                cwd: directory,
            },
            err => (err ? reject(err) : resolve()),
        ),
    );
    return directory;
}

function toolContext(directory: string, agent: string = AGENT_IDS.coordinator) {
    const controller = new AbortController();
    return {
        sessionID: "session-1",
        messageID: "message-1",
        agent,
        directory,
        worktree: directory,
        abort: controller.signal,
        metadata() {
            /* noop */
        },
        async ask() {
            /* noop */
        },
    } as never;
}

/** A deterministic passing review artifact bound to the supplied identity. */
async function writePassReview(
    directory: string,
    change: string,
    reviewed = identity,
): Promise<void> {
    await mkdir(path.dirname(reviewPath(directory, change)), { recursive: true });
    await writeFile(
        reviewPath(directory, change),
        [
            "## Verdict\npass",
            `## Reviewed state\nRepository identity: ${reviewed}`,
            "## Validation\nall required validation passed.",
            "## Blocking findings\nNone.",
            "## Non-blocking observations\n- None.",
            "## Conclusion\nReviewed independently.",
        ].join("\n\n"),
    );
}

/**
 * Phase 11 regression tests reproducing the cold adversarial findings against
 * the registered six-tool runtime. Each test first reproduces the defect
 * against the active V1 surface, then the accompanying fix makes it fail
 * closed.
 */
describe("Phase 11 — active runtime integration regressions", () => {
    describe("B-08 completion actions reachable through specops_finalize", () => {
        it("exposes a completionAction argument instead of hardcoding complete-and-archive", async () => {
            const plugin = await SpecOpsPlugin({} as never);
            const finalize = plugin.tool?.[WORKFLOW_TOOL_IDS.finalize];

            expect(finalize?.args).toBeDefined();
            // The registered finalizer must accept a completionAction, not
            // silently force complete-and-archive.
            expect(Object.keys(finalize?.args ?? {})).toEqual(
                expect.arrayContaining(["completionAction"]),
            );
        });

        it("routes request-implementation-changes back to implementation without re-running", async () => {
            const directory = await gitRepository();
            await createV1Run(directory, {
                change: "phase11",
                goal: "remediate completion",
                baselineRepositoryState: identity,
            });
            await updateV1Run(directory, "phase11", state => ({
                ...state,
                status: "awaiting-user",
                stage: "archive",
                currentRepositoryState: identity,
                validatedRepositoryState: identity,
                reviewedRepositoryState: identity,
            }));
            await writePassReview(directory, "phase11");
            const plugin = await SpecOpsPlugin({} as never);

            const raw = await plugin.tool?.[WORKFLOW_TOOL_IDS.finalize].execute(
                {
                    change: "phase11",
                    completionAction: {
                        kind: "request-implementation-changes",
                        feedback: "Tighten the timeout handling",
                    },
                } as never,
                toolContext(directory),
            );

            const result = JSON.parse(raw as string);
            expect(result.kind).toBe("request-changes");
            const state = await readV1Run(directory, "phase11");
            expect(state.status).toBe("active");
            expect(state.stage).toBe("implementation");
            expect(state.validatedRepositoryState).toBeNull();
            expect(state.reviewedRepositoryState).toBeNull();
        });

        it("routes leave-change-open to the verified state", async () => {
            const directory = await gitRepository();
            await createV1Run(directory, {
                change: "phase11",
                goal: "remediate completion",
                baselineRepositoryState: identity,
            });
            await updateV1Run(directory, "phase11", state => ({
                ...state,
                status: "awaiting-user",
                stage: "archive",
                currentRepositoryState: identity,
                validatedRepositoryState: identity,
                reviewedRepositoryState: identity,
            }));
            await writePassReview(directory, "phase11");
            const plugin = await SpecOpsPlugin({} as never);

            const raw = await plugin.tool?.[WORKFLOW_TOOL_IDS.finalize].execute(
                { change: "phase11", completionAction: { kind: "leave-change-open" } } as never,
                toolContext(directory),
            );

            const result = JSON.parse(raw as string);
            expect(result.kind).toBe("verified");
            const state = await readV1Run(directory, "phase11");
            expect(state.status).toBe("verified");
            expect(state.stage).toBe("archive");
        });
    });

    describe("B-08 review-repair limit enforced on the registered reconcile path", () => {
        it("blocks once repair attempts exceed MAX_REVIEW_REPAIRS", async () => {
            const directory = await temporaryDirectory();
            await createV1Run(directory, {
                change: "phase11",
                goal: "remediate repair limit",
                baselineRepositoryState: identity,
            });
            await updateV1Run(directory, "phase11", state => ({
                ...state,
                status: "active",
                stage: "review",
                currentRepositoryState: identity,
                validatedRepositoryState: identity,
                repairAttempts: MAX_REVIEW_REPAIRS,
            }));
            await writePassReview(directory, "phase11", identity);
            // A fresh changes-required review that would otherwise start
            // another repair beyond the configured budget.
            await writeFile(
                reviewPath(directory, "phase11"),
                [
                    "## Verdict\nchanges-required",
                    `## Reviewed state\nRepository identity: ${identity}`,
                    "## Validation\nall required validation passed.",
                    "## Blocking findings\n- ID: B-08-stale-evidence: timeout evidence is stale.",
                    "## Non-blocking observations\n- None.",
                    "## Conclusion\nRepair required.",
                ].join("\n\n"),
            );

            const outcome = await reconcileStage(
                {
                    directory,
                    adapter: { validate: async () => ({ valid: true, issues: [] }) },
                    calculateIdentity: async () => identity,
                },
                await readV1Run(directory, "phase11"),
            );

            expect(outcome.kind).toBe("blocked");
            expect(outcome.state.status).toBe("blocked");
        });
    });

    describe("B-01 planning readiness reaches owning agents through the active runtime", () => {
        it("reconciles an accepted planning artifact by surfacing the next owning agent and stage", async () => {
            const directory = await temporaryDirectory();
            await createV1Run(directory, {
                change: "phase11",
                goal: "remediate planning wiring",
                baselineRepositoryState: identity,
            });
            await updateV1Run(directory, "phase11", state => ({
                ...state,
                status: "active",
                stage: "proposal",
                currentRepositoryState: identity,
            }));
            const outcome = await reconcileStage(
                {
                    directory,
                    adapter: { validate: async () => ({ valid: true, issues: [] }) },
                    calculateIdentity: async () => identity,
                },
                await readV1Run(directory, "phase11"),
            );

            expect(outcome.kind).toBe("success");
            // The bounded outcome must tell the coordinator which agent owns
            // the next stage so planning instructions reach the right agent.
            expect(outcome).toMatchObject({
                next: { stage: "specs", agent: AGENT_IDS.planner },
            });
        });
    });

    describe("B-11 doctor is deterministic with respect to V1 configuration", () => {
        it("uses the configured OpenSpec command override and reports no errors for a valid environment", async () => {
            const directory = await temporaryDirectory();
            await mkdir(path.join(directory, "openspec", "changes"), { recursive: true });
            await writeFile(
                path.join(directory, "openspec", "config.yaml"),
                "schema: spec-driven\n",
            );
            const cleanPackageRoot = await mkdtemp(path.join(os.tmpdir(), "specops-pkg-"));
            temporaryDirectories.push(cleanPackageRoot);
            const adapterCalls: string[] = [];
            const diagnostics = await collectDoctorDiagnostics(directory, {
                adapter: {
                    version: async () => {
                        adapterCalls.push("version");
                        return "1.7.0";
                    },
                    schemas: async () => {
                        adapterCalls.push("schemas");
                        return [{ name: "spec-driven" }];
                    },
                },
                openCodeVersion: async () => "opencode 1.0",
                packageRoot: cleanPackageRoot,
                resolveConfiguration: async () => ({
                    version: 1,
                    models: Object.fromEntries(Object.values(AGENT_IDS).map(id => [id, {}])),
                    openspec: { command: ["node", "custom-openspec.js"] },
                    validation: { commands: [] },
                    integrations: { mcp: "allow" },
                }),
            });

            expect(diagnostics.filter(item => item.level === "error")).toEqual([]);
            expect(adapterCalls).toContain("version");
            expect(adapterCalls).toContain("schemas");
        });
    });

    describe("B-11 seven-role manifest mappings drive runtime agent registration", () => {
        it("registers each agent with the manifest's model and variant through the config hook", async () => {
            const { DEFAULT_MANIFEST } = await import("../src/agents/manifest.js");
            const { registerManifestAgents } = await import("../src/installation.js");
            const manifest = {
                version: 3 as const,
                agents: {
                    ...DEFAULT_MANIFEST.agents,
                    "specops-implementer": { model: "provider/impl-model", variant: "fast" },
                    "specops-reviewer": { model: "provider/review-model" },
                },
            };
            const config: Record<string, unknown> = { agent: {}, mcp: {} };
            registerManifestAgents(config as never, manifest, "disabled");

            expect(
                (config.agent as Record<string, { model?: string; variant?: string }>)[
                    "specops-implementer"
                ],
            ).toMatchObject({ model: "provider/impl-model", variant: "fast" });
            expect(
                (config.agent as Record<string, { model?: string; variant?: string }>)[
                    "specops-reviewer"
                ],
            ).toMatchObject({ model: "provider/review-model" });
        });
    });
});

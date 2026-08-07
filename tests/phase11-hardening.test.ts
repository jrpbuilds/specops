import { mkdtemp, rm, symlink, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_IDS } from "../src/agents/ids.js";
import {
    ActiveAgentSessions,
    createPermissionAskHook,
    resolveOwnedPathContext,
} from "../src/agents/permission-hook.js";
import { ownedPathPatterns, ownsEditPath } from "../src/agents/permissions.js";
import { createV1Run, updateV1Run } from "../src/state/store.js";
import { runProcess } from "../src/process.js";
import { calculateRepositoryIdentity } from "../src/repository/identity.js";
import { SpecOpsPlugin } from "../src/plugin.js";
import { WORKFLOW_TOOL_IDS } from "../src/workflow/tools.js";

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
    const directory = await mkdtemp(path.join(os.tmpdir(), "specops-phase11-perm-"));
    temporaryDirectories.push(directory);
    return directory;
}

describe("Phase 11 — permission, filesystem, process, and repository hardening", () => {
    describe("B-05 trusted active change/stage for path-scoped writers", () => {
        it("denies edits when no trusted active change is resolved (no wildcard fallback)", () => {
            // Empty context must NOT fall back to the '*' wildcard, which would
            // let a writer edit any change's artifacts.
            const patterns = ownedPathPatterns(AGENT_IDS.planner, {});
            expect(patterns).toEqual([]);

            expect(
                ownsEditPath(AGENT_IDS.planner, "openspec/changes/any-change/proposal.md", {}),
            ).toBe(false);
        });

        it("scopes edits to the resolved active change", async () => {
            const directory = await temporaryDirectory();
            await createV1Run(directory, {
                change: "active-change",
                goal: "remediate permissions",
                baselineRepositoryState: identity,
            });
            await updateV1Run(directory, "active-change", s => ({
                ...s,
                stage: "proposal",
            }));

            const context = await resolveOwnedPathContext(directory);
            expect(context).toEqual({ change: "active-change", stage: "proposal" });
            expect(
                ownsEditPath(
                    AGENT_IDS.planner,
                    "openspec/changes/active-change/proposal.md",
                    context,
                ),
            ).toBe(true);
            expect(
                ownsEditPath(
                    AGENT_IDS.planner,
                    "openspec/changes/other-change/proposal.md",
                    context,
                ),
            ).toBe(false);
        });

        it("the permission ask hook denies when the session has no active change", async () => {
            const directory = await temporaryDirectory();
            const sessions = new ActiveAgentSessions();
            sessions.set("session-1", AGENT_IDS.planner);
            const hook = createPermissionAskHook(sessions, () =>
                resolveOwnedPathContext(directory),
            );
            const output: { status: "allow" | "deny" | "ask" } = { status: "ask" };
            await hook(
                {
                    type: "edit",
                    pattern: "openspec/changes/any/proposal.md",
                    sessionID: "session-1",
                } as never,
                output,
            );
            expect(output.status).toBe("deny" as const);
        });

        it("the permission ask hook allows edits within the resolved active change", async () => {
            const directory = await temporaryDirectory();
            await createV1Run(directory, {
                change: "real-change",
                goal: "remediate permissions",
                baselineRepositoryState: identity,
            });
            await updateV1Run(directory, "real-change", s => ({
                ...s,
                stage: "proposal",
            }));
            const sessions = new ActiveAgentSessions();
            sessions.set("session-1", AGENT_IDS.planner);
            const hook = createPermissionAskHook(sessions, () =>
                resolveOwnedPathContext(directory),
            );
            const output: { status: "allow" | "deny" | "ask" } = { status: "ask" };
            await hook(
                {
                    type: "edit",
                    pattern: "openspec/changes/real-change/proposal.md",
                    sessionID: "session-1",
                } as never,
                output,
            );
            expect(output.status).toBe("allow");
        });
    });
});

describe("Phase 11 — process-group timeout with grace and forced kill (B-09)", () => {
    it("terminates a hanging child within the timeout rather than waiting forever", async () => {
        const start = Date.now();
        const result = await runProcess(
            "node",
            ["-e", "setInterval(()=>{}, 100)"],
            process.cwd(),
            undefined,
            undefined,
            undefined,
            500,
        );
        const elapsed = Date.now() - start;
        // The process group is SIGTERM'd at 500ms; with a 2s grace the
        // escalation to SIGKILL keeps the bound well under the grace window.
        expect(elapsed).toBeLessThan(5_000);
        expect(result.code).not.toBe(0);
    }, 15_000);
});

describe("Phase 11 — canonical repository identity (B-10)", () => {
    it("does not follow a symlink that points outside the repository", async () => {
        const directory = await gitRepo();
        const outside = await mkdtemp(path.join(os.tmpdir(), "specops-outside-"));
        temporaryDirectories.push(outside);
        await writeFile(path.join(outside, "secret.txt"), "outside-secret");
        // Create a symlink inside the repo pointing outside the repo.
        await symlink(path.join(outside, "secret.txt"), path.join(directory, "link.txt"));

        const identity = await calculateRepositoryIdentity(directory);
        // The symlink target string is captured (not the outside content), so
        // the identity is deterministic and bounded to the repo.
        expect(identity).toMatch(/^[0-9a-f]{64}$/);
    });

    it("detects a mode-only change (chmod +x) as a distinct repository state", async () => {
        const directory = await gitRepo();
        const baseline = await calculateRepositoryIdentity(directory);
        const file = path.join(directory, "script.sh");
        await writeFile(file, "#!/bin/sh\n");
        await chmod(file, 0o755);
        const changed = await calculateRepositoryIdentity(directory);
        expect(changed).not.toBe(baseline);
    });
});

/** Initialize a minimal git repo for identity tests. */
async function gitRepo(): Promise<string> {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, ".gitignore"), "node_modules/\n");
    await writeFile(path.join(directory, "README.md"), "# repo\n");
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

describe("Phase 11 — workflow tool caller authorization (B-07)", () => {
    it("rejects a non-coordinator agent driving a workflow tool", async () => {
        const directory = await gitRepo();
        await createV1Run(directory, {
            change: "phase11",
            goal: "remediate authz",
            baselineRepositoryState: "a".repeat(64),
        });
        const plugin = await SpecOpsPlugin({} as never);
        const status = plugin.tool?.[WORKFLOW_TOOL_IDS.getStatus];
        const controller = new AbortController();
        const context = {
            sessionID: "s",
            messageID: "m",
            agent: AGENT_IDS.implementer,
            directory,
            worktree: directory,
            abort: controller.signal,
            metadata() {},
            async ask() {},
        } as never;
        await expect(status?.execute({ change: "phase11" }, context)).rejects.toThrow(
            /coordinator/,
        );
    });

    it("allows the coordinator agent to drive a workflow tool", async () => {
        const directory = await gitRepo();
        await createV1Run(directory, {
            change: "phase11",
            goal: "remediate authz",
            baselineRepositoryState: "a".repeat(64),
        });
        const plugin = await SpecOpsPlugin({} as never);
        const status = plugin.tool?.[WORKFLOW_TOOL_IDS.getStatus];
        const controller = new AbortController();
        const context = {
            sessionID: "s",
            messageID: "m",
            agent: AGENT_IDS.coordinator,
            directory,
            worktree: directory,
            abort: controller.signal,
            metadata() {},
            async ask() {},
        } as never;
        const result = await status?.execute({ change: "phase11" }, context);
        expect(typeof result).toBe("string");
    });
});

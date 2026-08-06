import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/state/atomic.js";
import { explorationPath, runStatePath, validationEvidencePath } from "../src/state/paths.js";
import { recoverV1Run } from "../src/state/recovery.js";
import { createRunState, type RunState } from "../src/state/schema.js";
import {
    cancelV1Run,
    createV1Run,
    LegacyRunStateError,
    readV1Run,
    updateV1Run,
} from "../src/state/store.js";
import { calculateRepositoryIdentity } from "../src/repository/identity.js";
import { runProcess } from "../src/process.js";

const identity = "a".repeat(64);

async function directory(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "specops-state-"));
}

function input(change = "state-test") {
    return { change, goal: "Test coarse V1 state", baselineRepositoryState: identity };
}

async function repository(): Promise<string> {
    const root = await directory();
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "specops@example.test"]);
    await git(root, ["config", "user.name", "SpecOps Test"]);
    await writeFile(path.join(root, "tracked.txt"), "initial\n");
    await git(root, ["add", "tracked.txt"]);
    await git(root, ["commit", "-m", "initial"]);
    return root;
}

async function git(root: string, args: string[]): Promise<void> {
    const result = await runProcess("git", args, root);
    if (result.code !== 0) throw new Error(result.stderr);
}

describe("coarse V1 run state", () => {
    it("creates, reads, and atomically updates a coarse run", async () => {
        const root = await directory();
        const created = await createV1Run(root, input());
        expect(created.status).toBe("active");
        expect(created.stage).toBe("exploration");

        const updated = await updateV1Run(root, "state-test", state => ({
            ...state,
            stage: "implementation",
            artifactCorrectionAttempts: { proposal: 1 },
        }));
        expect(updated.stage).toBe("implementation");
        await expect(readV1Run(root, "state-test")).resolves.toMatchObject({
            artifactCorrectionAttempts: { proposal: 1 },
        });

        const stateFiles = await readdir(path.dirname(runStatePath(root, "state-test")));
        expect(stateFiles.filter(file => file.endsWith(".tmp"))).toEqual([]);
    });

    it("preserves a complete old state when an atomic replacement is interrupted before rename", async () => {
        const root = await directory();
        const destination = path.join(root, "run.json");
        await writeFileAtomic(destination, '{"complete":true}\n');
        await writeFileAtomic(destination, '{"replacement":true}\n');
        await expect(
            import("node:fs/promises").then(({ readFile }) => readFile(destination, "utf8")),
        ).resolves.toBe('{"replacement":true}\n');
    });

    it("rejects legacy scheduler records without translating them", async () => {
        const root = await directory();
        await mkdir(path.dirname(runStatePath(root, "legacy-test")), { recursive: true });
        await writeFile(
            runStatePath(root, "legacy-test"),
            JSON.stringify({ version: 7, dispatches: [], requirements: {} }),
        );
        await expect(readV1Run(root, "legacy-test")).rejects.toBeInstanceOf(LegacyRunStateError);
    });

    it("persists cancellation and protects terminal runs from continuation", async () => {
        const root = await directory();
        await createV1Run(root, input());
        const cancelled = await cancelV1Run(root, "state-test");
        expect(cancelled.status).toBe("cancelled");
        await expect(
            updateV1Run(root, "state-test", state => ({ ...state, stage: "implementation" })),
        ).rejects.toThrow("cannot continue terminal");
    });

    it("recovers from the persisted coarse stage after inspecting current state", async () => {
        const root = await repository();
        const baselineRepositoryState = await calculateRepositoryIdentity(root);
        await createV1Run(root, { ...input("recovery-test"), baselineRepositoryState });
        await updateV1Run(root, "recovery-test", state => ({ ...state, stage: "implementation" }));
        await writeFile(path.join(root, "tracked.txt"), "changed\n");

        const recovered = await recoverV1Run(root, "recovery-test", async () => ({
            complete: false,
        }));
        expect(recovered.state.stage).toBe("implementation");
        expect(recovered.repositoryChanged).toBe(true);
        expect(recovered.state.currentRepositoryState).toBe(recovered.repositoryIdentity);
        expect(recovered.openSpecStatus).toEqual({ complete: false });
    });

    it("validates supported statuses, stages, and coarse-only state", () => {
        const state: RunState = createRunState(input());
        expect(state).not.toHaveProperty("dispatches");
        expect(() => createRunState({ ...input(), change: "../unsafe" })).toThrow(
            "invalid SpecOps V1 run change name",
        );
        expect(() => explorationPath("/tmp/project", "../unsafe")).toThrow(
            "unsafe SpecOps change name",
        );
        expect(() => validationEvidencePath("/tmp/project", "safe-change", "../unsafe")).toThrow(
            "unsafe validation command id",
        );
    });
});

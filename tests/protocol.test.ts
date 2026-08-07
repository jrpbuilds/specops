import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SpecOpsPlugin } from "../src/plugin.js";
import { ALL_WORKFLOW_TOOL_IDS } from "../src/workflow/tools.js";
import { createV1Run, readV1Run, updateV1Run } from "../src/state/store.js";
import { reconcileStage } from "../src/workflow/reconcile.js";

const identity = "a".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map(directory => rm(directory, { recursive: true, force: true })),
    );
});

/** Tests the active minimal workflow protocol rather than retained legacy modules. */
describe("V1 workflow protocol", () => {
    it("registers exactly the approved six workflow tools", async () => {
        const plugin = await SpecOpsPlugin({} as never);

        expect(Object.keys(plugin.tool ?? {}).sort()).toEqual([
            "specops_cancel",
            "specops_finalize",
            "specops_get_status",
            "specops_reconcile_stage",
            "specops_run_validation",
            "specops_start_or_resume",
        ]);
    expect([...ALL_WORKFLOW_TOOL_IDS].sort()).toEqual(Object.keys(plugin.tool ?? {}).sort());
    });

    it("atomically advances a complete explorer output to the proposal boundary", async () => {
        const directory = await temporaryDirectory();
        await createV1Run(directory, {
            change: "phase-eight",
            goal: "test",
            baselineRepositoryState: identity,
        });
        await writeFile(
            path.join(directory, ".specops", "runs", "phase-eight", "exploration.md"),
            "Repository findings\n",
        );

        const outcome = await reconcileStage(
            { directory, adapter: { validate: async () => ({ valid: true, issues: [] }) } },
            await readV1Run(directory, "phase-eight"),
        );

        expect(outcome).toMatchObject({ kind: "success", message: "exploration report accepted" });
        await expect(readV1Run(directory, "phase-eight")).resolves.toMatchObject({
            stage: "proposal",
            status: "active",
        });
    });

    it("returns correction then user-input outcomes for bounded invalid artifacts", async () => {
        const directory = await temporaryDirectory();
        await createV1Run(directory, {
            change: "phase-eight",
            goal: "test",
            baselineRepositoryState: identity,
        });
        await updateV1Run(directory, "phase-eight", state => ({ ...state, stage: "proposal" }));
        const adapter = {
            validate: async () => ({ valid: false, issues: ["missing requirement"] }),
        };

        const first = await reconcileStage(
            { directory, adapter },
            await readV1Run(directory, "phase-eight"),
        );
        const second = await reconcileStage(
            { directory, adapter },
            await readV1Run(directory, "phase-eight"),
        );
        const exhausted = await reconcileStage(
            { directory, adapter },
            await readV1Run(directory, "phase-eight"),
        );

        expect(first.kind).toBe("correction-required");
        expect(second.kind).toBe("correction-required");
        expect(exhausted).toMatchObject({
            kind: "user-input-required",
            state: { status: "awaiting-user" },
        });
    });
});

/** Create one isolated V1 run root for a reconciliation test. */
async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "specops-protocol-"));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, ".specops", "runs", "phase-eight"), { recursive: true });
    return directory;
}

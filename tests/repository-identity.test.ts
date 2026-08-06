import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureRepositoryBaseline } from "../src/repository/baseline.js";
import { detectRepositoryMutation } from "../src/repository/changes.js";
import { calculateRepositoryIdentity } from "../src/repository/identity.js";
import { runProcess } from "../src/process.js";

async function repository(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "specops-identity-"));
    await git(directory, ["init"]);
    await git(directory, ["config", "user.email", "specops@example.test"]);
    await git(directory, ["config", "user.name", "SpecOps Test"]);
    await writeFile(path.join(directory, "tracked.txt"), "initial\n");
    await git(directory, ["add", "tracked.txt"]);
    await git(directory, ["commit", "-m", "initial"]);
    return directory;
}

async function git(directory: string, args: string[]): Promise<void> {
    const result = await runProcess("git", args, directory);
    if (result.code !== 0) throw new Error(result.stderr);
}

describe("repository identity", () => {
    it("is deterministic and changes for staged, deleted, and untracked files", async () => {
        const directory = await repository();
        const initial = await calculateRepositoryIdentity(directory);
        await expect(calculateRepositoryIdentity(directory)).resolves.toBe(initial);

        await writeFile(path.join(directory, "tracked.txt"), "staged\n");
        await git(directory, ["add", "tracked.txt"]);
        const staged = await calculateRepositoryIdentity(directory);
        expect(staged).not.toBe(initial);

        await writeFile(path.join(directory, "untracked.txt"), "new\n");
        const untracked = await calculateRepositoryIdentity(directory);
        expect(untracked).not.toBe(staged);

        await git(directory, ["rm", "--force", "tracked.txt"]);
        await expect(calculateRepositoryIdentity(directory)).resolves.not.toBe(untracked);
    });

    it("excludes SpecOps metadata and OpenSpec planning artifacts", async () => {
        const directory = await repository();
        const initial = await calculateRepositoryIdentity(directory);
        await mkdir(path.join(directory, ".specops", "runs", "change"), { recursive: true });
        await writeFile(path.join(directory, ".specops", "runs", "change", "run.json"), "{}\n");
        await mkdir(path.join(directory, "openspec", "changes", "change"), { recursive: true });
        await writeFile(
            path.join(directory, "openspec", "changes", "change", "tasks.md"),
            "# Tasks\n",
        );
        await expect(calculateRepositoryIdentity(directory)).resolves.toBe(initial);
    });

    it("captures a dirty baseline and detects later external mutation", async () => {
        const directory = await repository();
        await writeFile(path.join(directory, "before-run.txt"), "existing\n");
        const baseline = await captureRepositoryBaseline(directory);
        expect(baseline.changedFiles.map(file => file.path)).toEqual(["before-run.txt"]);
        expect(baseline.warning).toContain("pre-existing changes");

        await writeFile(path.join(directory, "after-run.txt"), "external\n");
        const mutation = await detectRepositoryMutation(directory, baseline.identity);
        expect(mutation.changed).toBe(true);
        expect(mutation.files.map(file => file.path)).toEqual(["after-run.txt", "before-run.txt"]);
    });
});

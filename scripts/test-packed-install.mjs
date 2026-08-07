import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "specops-packed-"));
const npmCache = path.join(temporaryRoot, "npm-cache");

try {
    const packed = spawnSync("npm", ["pack", "--pack-destination", temporaryRoot], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: npmCache },
    });
    assertProcess(packed, "npm pack");
    const archive = path.join(
        temporaryRoot,
        (await readdir(temporaryRoot)).find(file => file.endsWith(".tgz")) ?? "missing.tgz",
    );
    assert(
        (await readdir(temporaryRoot)).some(file => file.endsWith(".tgz")),
        "package archive missing",
    );
    assertProcess(
        spawnSync("tar", ["-xzf", archive, "-C", temporaryRoot], { encoding: "utf8" }),
        "tar extraction",
    );

    const packageDirectory = path.join(temporaryRoot, "package");
    await symlink(
        path.join(repositoryRoot, "node_modules"),
        path.join(packageDirectory, "node_modules"),
    );
    process.env.XDG_CONFIG_HOME = path.join(temporaryRoot, "config");
    const module = await import(
        `${pathToFileURL(path.join(packageDirectory, "dist", "index.js")).href}?${randomUUID()}`
    );
    const hooks = await module.default.server(pluginInput(packageDirectory));
    const config = {};
    await hooks.config(config);

    assertEqual(
        Object.keys(config.command).sort(),
        ["specops", "specops-cancel", "specops-doctor", "specops-onboard", "specops-status"],
        "packed command catalogue",
    );
    assertEqual(
        Object.keys(hooks.tool).sort(),
        [
            "specops_cancel",
            "specops_finalize",
            "specops_get_status",
            "specops_reconcile_stage",
            "specops_run_validation",
            "specops_start_or_resume",
        ],
        "packed workflow tool catalogue",
    );

    const files = await recursiveFiles(packageDirectory);
    for (const forbidden of [
        "orchestrator.js",
        "protocol.js",
        "worker_output.js",
        "finalization.js",
        "scheduler.js",
    ]) {
        assert(
            !files.some(file => file.endsWith(`/${forbidden}`)),
            `packed legacy module: ${forbidden}`,
        );
    }
    assert(!files.some(file => /\/schemas\/specops(?:-|\/|$)/.test(file)), "packed custom schema");
    for (const prompt of [
        "coordinator",
        "explorer",
        "planner",
        "designer",
        "implementer",
        "reviewer",
        "frontier",
    ]) {
        assert(
            (await readFile(path.join(packageDirectory, "prompts", `${prompt}.md`), "utf8")).trim(),
            `missing prompt ${prompt}`,
        );
    }
    process.stderr.write(
        "Packed install smoke passed: V1 commands, tools, prompts, and package exclusions verified\n",
    );
} finally {
    await rm(temporaryRoot, { recursive: true, force: true });
}

function pluginInput(directory) {
    return {
        directory,
        worktree: directory,
        project: {},
        client: {},
        serverUrl: new URL("http://127.0.0.1"),
        $() {},
        experimental_workspace: { register() {} },
    };
}

async function recursiveFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    return (
        await Promise.all(
            entries.map(async entry => {
                const target = path.join(directory, entry.name);
                return entry.isDirectory() ? recursiveFiles(target) : [target];
            }),
        )
    ).flat();
}

function assert(value, message) {
    if (!value) throw new Error(message);
}

function assertEqual(actual, expected, label) {
    if (actual.join("|") !== expected.join("|"))
        throw new Error(`${label} mismatch: ${actual.join(", ")}`);
}

function assertProcess(result, label) {
    if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
}

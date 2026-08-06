/**
 * Opt-in live-model smoke benchmark for the evidence-backed review fixer.
 *
 * The benchmark is intentionally excluded from `npm run check`: it requires a
 * configured OpenCode installation, provider credentials, and the SpecOps
 * plugin under evaluation. Set SPECOPS_REPAIR_EVAL=1 to run three temporary,
 * committed fixture repositories through the public automatic command.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (process.env.SPECOPS_REPAIR_EVAL !== "1") {
    throw new Error("Set SPECOPS_REPAIR_EVAL=1 to run the live review-fixer benchmark");
}

const fixtures = [
    {
        id: "implementation-defect",
        goal: "Correct the add implementation without changing its public API and add regression coverage.",
        files: {
            "math.mjs": "export const add = (left, right) => left - right\n",
            "math.test.mjs":
                'import test from "node:test"\nimport assert from "node:assert/strict"\nimport { add } from "./math.mjs"\ntest("adds", () => assert.equal(add(2, 3), 5))\n',
        },
    },
    {
        id: "missing-regression-test",
        goal: "Make slugify collapse repeated whitespace and add a regression test for that behavior.",
        files: {
            "slug.mjs": "export const slugify = value => value.trim().replace(' ', '-')\n",
            "slug.test.mjs":
                'import test from "node:test"\nimport assert from "node:assert/strict"\nimport { slugify } from "./slug.mjs"\ntest("slugifies", () => assert.equal(slugify("hello world"), "hello-world"))\n',
        },
        hiddenCheck:
            'import assert from "node:assert/strict"; import { slugify } from "./slug.mjs"; assert.equal(slugify("hello   world"), "hello-world")',
    },
    {
        id: "multi-file-review-finding",
        goal: "Correct the cache freshness check across the cache modules and preserve the exported API.",
        files: {
            "cache-policy.mjs":
                "export const isFresh = (storedAt, now, ttl) => now - storedAt > ttl\n",
            "cache.mjs":
                'import { isFresh } from "./cache-policy.mjs"\nexport const readCache = (entry, now, ttl) => isFresh(entry.storedAt, now, ttl) ? entry.value : undefined\n',
            "cache.test.mjs":
                'import test from "node:test"\nimport assert from "node:assert/strict"\nimport { readCache } from "./cache.mjs"\ntest("reads fresh entries", () => assert.equal(readCache({storedAt: 90, value: "ok"}, 100, 20), "ok"))\n',
        },
    },
];

const results = [];
for (const fixture of selectedFixtures()) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `specops-eval-${fixture.id}-`));
    for (const [relative, content] of Object.entries(fixture.files)) {
        await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
        await writeFile(path.join(directory, relative), content);
    }
    run("git", ["init", "--quiet"], directory);
    run("git", ["config", "user.email", "specops-eval@example.test"], directory);
    run("git", ["config", "user.name", "SpecOps Evaluation"], directory);
    run("git", ["add", "."], directory);
    run("git", ["commit", "--quiet", "-m", "seed defect"], directory);
    const baseline = run("git", ["rev-parse", "HEAD"], directory).stdout.trim();

    const workflow = run(
        "opencode",
        [
            "run",
            "--command",
            "specops-auto",
            "--dir",
            directory,
            "--print-logs",
            "--log-level",
            "ERROR",
            "--auto",
            fixture.goal,
        ],
        directory,
        false,
        evaluationTimeout(),
    );
    const tests = run("node", ["--test"], directory, false);
    const hidden = fixture.hiddenCheck
        ? run("node", ["--input-type=module", "--eval", fixture.hiddenCheck], directory, false)
        : { status: 0 };
    const head = run("git", ["rev-parse", "HEAD"], directory).stdout.trim();
    const receipt = await latestReceipt(directory);
    const artifactIntegrity = receipt ? await verifyArtifactIntegrity(receipt) : false;
    results.push({
        fixture: fixture.id,
        directory,
        workflowExitCode: workflow.status,
        workflowError: excerpt(
            workflow.error?.message ||
                workflow.stderr ||
                workflow.stdout ||
                (workflow.signal ? `terminated by ${workflow.signal}` : ""),
        ),
        testsPassed: tests.status === 0,
        hiddenCheckPassed: hidden.status === 0,
        headPreserved: head === baseline,
        protectedArtifactsIntact: artifactIntegrity,
        completed: receipt?.outcome?.category === "completed",
        repairTasks: receipt?.repairTasks?.length ?? 0,
        passed:
            workflow.status === 0 &&
            tests.status === 0 &&
            hidden.status === 0 &&
            head === baseline &&
            artifactIntegrity &&
            receipt?.outcome?.category === "completed",
    });
}

process.stdout.write(`${JSON.stringify({ version: 1, results }, null, 2)}\n`);
if (results.some(result => !result.passed)) process.exitCode = 1;

/**
 * Runs one benchmark command with deterministic non-interactive input.
 *
 * @param {string} command executable name
 * @param {string[]} args command arguments
 * @param {string} cwd working directory
 * @param {boolean} required whether a failure should abort the benchmark
 * @param {number | undefined} timeout timeout in milliseconds
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function run(command, args, cwd, required = true, timeout) {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, CI: "1", NO_COLOR: "1" },
        input: "",
        timeout,
    });
    if (required && result.status !== 0) {
        const detail =
            result.error?.message ||
            result.stderr ||
            result.stdout ||
            (result.signal ? `terminated by ${result.signal}` : "unknown process failure");
        throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
    }
    return result;
}

/**
 * Returns the bounded per-fixture live workflow timeout.
 *
 * @returns {number} timeout in milliseconds
 */
function evaluationTimeout() {
    const configured = Number(process.env.SPECOPS_REPAIR_EVAL_TIMEOUT_MS ?? 1_800_000);
    if (!Number.isFinite(configured) || configured <= 0) {
        throw new Error("SPECOPS_REPAIR_EVAL_TIMEOUT_MS must be a positive number");
    }
    return configured;
}

/**
 * Selects an optional comma-delimited subset of fixture IDs.
 *
 * @returns {typeof fixtures} selected benchmark fixtures
 */
function selectedFixtures() {
    const requested = process.env.SPECOPS_REPAIR_EVAL_FIXTURES?.split(",")
        .map(value => value.trim())
        .filter(Boolean);
    if (!requested?.length) return fixtures;

    const unknown = requested.filter(id => !fixtures.some(fixture => fixture.id === id));
    if (unknown.length > 0) {
        throw new Error(`Unknown SPECOPS_REPAIR_EVAL_FIXTURES: ${unknown.join(", ")}`);
    }
    return fixtures.filter(fixture => requested.includes(fixture.id));
}

async function latestReceipt(directory) {
    const changes = path.join(directory, "openspec", "changes");
    try {
        const entries = (await readdir(changes, { withFileTypes: true })).filter(entry =>
            entry.isDirectory(),
        );
        for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
            try {
                const file = path.join(changes, entry.name, "specops-receipt.json");
                return { ...JSON.parse(await readFile(file, "utf8")), __file: file };
            } catch {
                // Continue to the next change directory.
            }
        }
    } catch {
        return undefined;
    }
    return undefined;
}

async function verifyArtifactIntegrity(receipt) {
    const changeRoot = path.dirname(receipt.__file);
    const files = {
        routing: "routing.md",
        exploration: "exploration.md",
        proposal: "proposal.md",
        design: "design.md",
        tasks: "tasks.md",
        verification: "verification.md",
        "review-ledger": "review-ledger.json",
    };
    for (const [artifact, relative] of Object.entries(files)) {
        const provenance = receipt.artifacts?.[artifact];
        if (!provenance || provenance.validity !== "valid") continue;
        try {
            const content = await readFile(path.join(changeRoot, relative), "utf8");
            if (sha256(content.trim()) !== provenance.outputHash) return false;
        } catch {
            return false;
        }
    }
    return true;
}

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function excerpt(value) {
    const text = String(value ?? "").trim();
    return text.length > 2_000 ? `${text.slice(0, 2_000)}\n[truncated]` : text;
}

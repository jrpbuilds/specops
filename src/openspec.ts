/**
 * OpenSpec integration helpers: configuration, change lifecycle, schema
 * onboarding, and artifact persistence.
 *
 * Every OpenSpec invocation is shell-free and runs through {@link runProcess}
 * with a deliberately narrow environment.
 */

import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { type SpecOpsConfig, DEFAULT_CONFIG, validateConfig } from "./config.js"
import { runProcess } from "./git.js"
import { writeTextAtomic } from "./state/store.js"

// `openspec.ts` is emitted directly into `dist`, so one parent reaches the package root in both
// source and packed layouts. Keeping this package-relative avoids source-checkout path leakage.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)

/** OpenSpec subcommands that do not create, modify, or archive project state. */
export const READ_ONLY_OPENSPEC_COMMANDS = new Set([
    "status",
    "instructions",
    "schemas",
    "schema",
    "validate",
    "list",
    "show",
])

/**
 * Read the strict final configuration or return an isolated copy of defaults.
 * @param directory - Project root directory (`.opencode/specops.json` is
 * read from here).
 * @returns A validated {@link SpecOpsConfig}, or `structuredClone(DEFAULT_CONFIG)`
 * when no config file exists.
 * @throws If the file exists but fails schema validation or JSON parsing.
 */
export async function readConfig(directory: string): Promise<SpecOpsConfig> {
    try {
        return validateConfig(
            JSON.parse(await readFile(path.join(directory, ".opencode", "specops.json"), "utf8")),
        )
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return structuredClone(DEFAULT_CONFIG)
        }
        throw error
    }
}

/**
 * Execute a bundled or explicitly configured OpenSpec binary with no shell.
 * @param directory - Working directory for the OpenSpec process.
 * @param config - Resolved config; `config.openspec.command` selects the binary.
 * @param args - Arguments forwarded to the OpenSpec binary.
 * @param signal - Optional `AbortSignal` to cancel the running process.
 * @returns Captured stdout, stderr, and exit code.
 */
async function runOpenSpec(
    directory: string,
    config: SpecOpsConfig,
    args: string[],
    signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
    const command = config.openspec.command?.[0] ?? "node"
    const prefix = config.openspec.command?.slice(1) ?? [openSpecBinary()]
    const result = await runProcess(
        command,
        [...prefix, ...args, "--no-color"],
        directory,
        signal,
        {
            PATH: process.env.PATH ?? "",
            NO_COLOR: "1",
            OPENSPEC_TELEMETRY: "0",
        },
    )
    return result
}

/**
 * Run OpenSpec and attach useful command output to a thrown failure.
 * @param directory - Working directory for the OpenSpec process.
 * @param config - Resolved config used to locate the binary.
 * @param args - Arguments forwarded to the OpenSpec binary.
 * @returns The command's stdout on success.
 * @throws If the OpenSpec process exits with a non-zero code.
 */
export async function openSpecOrThrow(
    directory: string,
    config: SpecOpsConfig,
    args: string[],
): Promise<string> {
    const result = await runOpenSpec(directory, config, args)
    if (result.code) {
        throw new Error(`OpenSpec ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
    }
    return result.stdout
}

/**
 * Install only missing final schema files into a project.
 * Creates the `openspec/` directory tree, copies bundled schemas, and writes
 * a default `config.yaml` when none exists.
 * @param directory - Project root directory.
 */
export async function onboard(directory: string): Promise<void> {
    const openSpecDirectory = path.join(directory, "openspec")
    await mkdir(path.join(openSpecDirectory, "changes"), { recursive: true })
    await mkdir(path.join(openSpecDirectory, "specs"), { recursive: true })
    for (const schema of ["specops-lean", "specops-standard", "specops"]) {
        const target = path.join(openSpecDirectory, "schemas", schema)
        await mkdir(target, { recursive: true })
        await copyMissing(path.join(PACKAGE_ROOT, "schemas", schema), target)
    }

    try {
        await stat(path.join(openSpecDirectory, "config.yaml"))
    } catch {
        await writeFile(
            path.join(openSpecDirectory, "config.yaml"),
            "schema: specops\nrules:\n  verification:\n    - Record only registry-backed commands.\n",
        )
    }
}

/**
 * Create an OpenSpec change using the schema selected by deterministic
 * routing.
 * @param directory - Project root directory.
 * @param config - Resolved config used to locate the binary.
 * @param change - Unique change identifier (filesystem-safe slug).
 * @param goal - Human-readable change goal passed to `--goal`.
 * @param tier - Scope tier that selects the schema (`lean` → `specops-lean`,
 * `standard` → `specops-standard`, `full` → `specops`).
 * @throws If the `openspec new change` invocation fails.
 */
export async function createChange(
    directory: string,
    config: SpecOpsConfig,
    change: string,
    goal: string,
    tier: "lean" | "standard" | "full",
): Promise<void> {
    const schema =
        tier === "lean" ? "specops-lean" : tier === "standard" ? "specops-standard" : "specops"
    await openSpecOrThrow(directory, config, [
        "new",
        "change",
        change,
        "--schema",
        schema,
        "--goal",
        goal,
        "--json",
    ])
}

/**
 * Persist a controller-owned artifact through the atomic state-store
 * boundary.
 * @param directory - Project root directory.
 * @param change - Change identifier scoping the artifact.
 * @param relative - Relative path within the change directory.
 * @param content - String content to write atomically.
 */
export async function writeArtifact(
    directory: string,
    change: string,
    relative: string,
    content: string,
): Promise<void> {
    await writeTextAtomic(directory, change, relative, content)
}

/**
 * Derive a readable, filesystem-safe unique change identifier from a goal.
 * Strips non-alphanumeric characters, truncates to 48 characters, and
 * appends a base-36 timestamp suffix when the base name is already taken.
 * @param directory - Project root directory.
 * @param goal - Human-readable change description.
 * @returns A unique, filesystem-safe slug for the change directory.
 */
export async function uniqueChangeName(directory: string, goal: string): Promise<string> {
    const base =
        goal
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 48) || "specops-change"
    try {
        await stat(path.join(directory, "openspec", "changes", base))
        return `${base}-${Date.now().toString(36)}`
    } catch {
        return base
    }
}

/**
 * Resolve the path to the bundled OpenSpec binary by following the
 * `@fission-ai/openspec` package entry point to its sibling `bin` directory.
 * @returns Absolute path to the bundled `openspec.js` launcher.
 */
function openSpecBinary(): string {
    const entry = require.resolve("@fission-ai/openspec")
    return path.resolve(path.dirname(entry), "..", "bin", "openspec.js")
}

/**
 * Recursively copy a directory tree into a target, skipping files that already
 * exist at the destination so prior user edits are preserved.
 * @param source - Absolute path to the source directory.
 * @param target - Absolute path to the target directory.
 */
async function copyMissing(source: string, target: string): Promise<void> {
    for (const entry of await readdir(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name)
        const to = path.join(target, entry.name)
        if (entry.isDirectory()) {
            await mkdir(to, { recursive: true })
            await copyMissing(from, to)
            continue
        }
        try {
            await stat(to)
        } catch {
            await copyFile(from, to)
        }
    }
}

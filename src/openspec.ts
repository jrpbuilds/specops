/**
 * OpenSpec integration helpers: configuration, change lifecycle, schema
 * onboarding, and artifact persistence.
 *
 * Every OpenSpec invocation is shell-free and runs through {@link runProcess}
 * with a deliberately narrow environment.
 */

import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { type SpecOpsConfig, resolveConfig } from "./config.js"
import { runProcess } from "./git.js"
import { writeTextAtomic } from "./state/store.js"
import { redactSensitiveText } from "./security/redact.js"

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

/** OpenSpec's maximum change-name length. */
export const MAX_CHANGE_NAME_LENGTH = 200

/**
 * Resolve the final configuration from defaults, the global user file, and the
 * project file.
 *
 * Values are merged with deep object recursion: plain objects combine, arrays
 * and primitives replace, and explicit `null` takes precedence.
 *
 * @param directory - Project root directory (`.opencode/specops.json` is read
 * from here).
 * @returns A validated {@link SpecOpsConfig}.
 * @throws If any existing file fails JSON parsing or validation.
 */
export async function readConfig(directory: string): Promise<SpecOpsConfig> {
    return resolveConfig(directory)
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
 * Archive a completed OpenSpec change deterministically, returning the raw
 * process result rather than throwing so the caller can record a retryable
 * {@link RunState}["archiveError"] without unwinding the run lock.
 *
 * The invocation is non-interactive (`--json --yes`). `--skip-specs` is used
 * for changes with no spec deltas (e.g. the lean tier) so archive only moves
 * the change directory without touching `openspec/specs/`. Archive re-validates
 * the change by default; a validation failure surfaces as a non-zero exit code
 * that the caller records as `archiveError`.
 *
 * @param directory - Project root directory.
 * @param config - Resolved config used to locate the OpenSpec binary.
 * @param change - Unique change identifier to archive.
 * @param skipSpecs - When `true`, pass `--skip-specs` (no main-spec merge).
 * @returns Captured stdout, stderr, and exit code from the OpenSpec process.
 */
export async function archiveChange(
    directory: string,
    config: SpecOpsConfig,
    change: string,
    skipSpecs: boolean,
): Promise<{ stdout: string; stderr: string; code: number }> {
    const args = ["archive", change, "--json", "--yes"]
    if (skipSpecs) args.push("--skip-specs")
    return runOpenSpec(directory, config, args)
}

/**
 * Count unchecked Markdown task boxes in a change's task artifacts.
 *
 * OpenSpec 1.7's `--yes` option intentionally bypasses its incomplete-task
 * confirmation. SpecOps performs this deterministic preflight itself so an
 * archive cannot silently discard unfinished implementation work.
 *
 * The canonical change-root `tasks.md` is authoritative when present. Only when
 * it is absent does the scan recurse into nested directories for other
 * `tasks.md` files. Lines inside fenced code blocks (``` or ~~~) and HTML
 * comments (`<!-- ... -->`) are not counted, while an inline comment after a
 * leading checkbox does not hide the task itself.
 *
 * @param directory - Project root directory.
 * @param change - OpenSpec change identifier.
 * @returns The number of unchecked task boxes found in `tasks.md` files.
 */
export async function countIncompleteTasks(directory: string, change: string): Promise<number> {
    const root = path.join(directory, "openspec", "changes", change)
    const canonicalTasks = path.join(root, "tasks.md")
    let incomplete = 0

    try {
        await stat(canonicalTasks)
        incomplete += countIncompleteBoxes(await readFile(canonicalTasks, "utf8"))
        return incomplete
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        // Fall through to recursive descent when no canonical tasks file exists.
    }

    async function visit(current: string): Promise<void> {
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const target = path.join(current, entry.name)
            if (entry.isDirectory()) {
                await visit(target)
                continue
            }
            if (entry.name.toLowerCase() !== "tasks.md") continue
            const content = await readFile(target, "utf8")
            incomplete += countIncompleteBoxes(content)
        }
    }

    await visit(root)
    return incomplete
}

/** Match an opening task-list checkbox line: `- [ ]` or `* [ ]` (unchecked). */
const UNCHECKED_TASK_PATTERN = /^[-*]\s+\[[\sx]\]/i
const CHECKED_TASK_PATTERN = /^[-*]\s+\[x\]/i

/**
 * Count unchecked task boxes in one Markdown document, skipping fenced code
 * blocks and HTML comments.
 *
 * @param content - The Markdown text of a tasks artifact.
 * @returns The number of unchecked task boxes outside code/HTML-comment spans.
 */
function countIncompleteBoxes(content: string): number {
    let count = 0
    let inFence = false
    let fenceChar = ""
    let fenceLength = 0
    let inComment = false
    for (const line of content.split("\n")) {
        if (inFence) {
            if (isClosingFence(line, fenceChar, fenceLength)) {
                inFence = false
                fenceChar = ""
                fenceLength = 0
            }
            continue
        }
        if (inComment) {
            if (line.includes("-->")) inComment = false
            continue
        }
        const open = openingFence(line)
        if (open) {
            inFence = true
            fenceChar = open.char
            fenceLength = open.length
            continue
        }
        const commentStart = line.indexOf("<!--")
        if (commentStart >= 0) {
            const visible = line.slice(0, commentStart)
            if (UNCHECKED_TASK_PATTERN.test(visible) && !CHECKED_TASK_PATTERN.test(visible)) {
                count += 1
            }
            if (!line.slice(commentStart + 4).includes("-->")) inComment = true
            continue
        }
        if (UNCHECKED_TASK_PATTERN.test(line) && !CHECKED_TASK_PATTERN.test(line)) {
            count += 1
        }
    }
    return count
}

/**
 * Match an opening Markdown fence at the start of a line.
 *
 * A run of three or more backticks or tildes opens a fenced block; the info
 * string after the opening fence is ignored.
 *
 * @param line - A single line of Markdown.
 * @returns The fence character and run length, or `undefined` when not opening.
 */
function openingFence(line: string): { char: string; length: number } | undefined {
    const match = /^\s*([`~])(\1{2,})/.exec(line)
    if (!match) return undefined
    return { char: match[1]!, length: 1 + match[2]!.length }
}

/**
 * Match a closing fence for an open fenced block.
 *
 * The closing fence must use the same character as the opening and a run length
 * at least as long; the info string is not permitted on a closing fence.
 *
 * @param line - A single line of Markdown.
 * @param char - The opening fence character.
 * @param minLength - The opening fence run length.
 * @returns `true` when the line is a matching closing fence.
 */
function isClosingFence(line: string, char: string, minLength: number): boolean {
    const escaped = char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`^\\s*${escaped}{${minLength},}\\s*$`).test(line)
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
    await writeTextAtomic(directory, change, relative, redactSensitiveText(content))
}

/**
 * Derive a readable, filesystem-safe unique change identifier from a goal.
 * Strips non-alphanumeric characters, bounds the result to OpenSpec's maximum
 * length, and appends a base-36 timestamp suffix when the base name is taken.
 * @param directory - Project root directory.
 * @param goal - Human-readable change description.
 * @returns A unique, filesystem-safe slug for the change directory.
 */
export async function uniqueChangeName(directory: string, goal: string): Promise<string> {
    const normalized = goal
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
    const base = normalized.slice(0, MAX_CHANGE_NAME_LENGTH).replace(/-+$/g, "") || "specops-change"
    try {
        await stat(path.join(directory, "openspec", "changes", base))
        const suffix = `-${Date.now().toString(36)}`
        const availableBaseLength = MAX_CHANGE_NAME_LENGTH - suffix.length
        const uniqueBase =
            base.slice(0, availableBaseLength).replace(/-+$/g, "") || "specops-change"
        return `${uniqueBase}${suffix}`
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

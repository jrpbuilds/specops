/**
 * Git helpers for the SpecOps workflow.
 *
 * All Git interaction is funneled through this module so the orchestrator can
 * enforce a clean-worktree baseline, collect bounded diffs, and measure the
 * implementation footprint without leaking Git concerns elsewhere.
 */

import { readFile } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import type { SpecOpsConfig, WorkflowTier } from "./core.js"

/** The result of a spawned child process. */
type CommandResult = { stdout: string; stderr: string; code: number }

/** A UTF-8 decoder configured to reject invalid byte sequences (binary detection). */
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true })

/**
 * Spawn a command with sanitized environment and capture its output.
 *
 * `shell: false` prevents shell injection. `NO_COLOR` and `OPENSPEC_TELEMETRY`
 * are forced off so output is parseable and telemetry stays local.
 *
 * @param command - The executable to run.
 * @param args - Arguments passed verbatim (no shell expansion).
 * @param cwd - The working directory for the child.
 * @param signal - Optional abort signal to kill the child on cancellation.
 */
export async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1", OPENSPEC_TELEMETRY: "0" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
        code: code ?? 1,
      })
    })
    const abort = () => child.kill("SIGTERM")
    signal?.addEventListener("abort", abort, { once: true })
    child.on("close", () => signal?.removeEventListener("abort", abort))
  })
}

/**
 * Run a Git command and return its stdout. Throws on non-zero exit.
 *
 * @param directory - The repository working tree.
 * @param args - Git arguments (e.g. `["rev-parse", "HEAD"]`).
 */
export async function git(directory: string, args: string[]): Promise<string> {
  const result = await runProcess("git", args, directory)
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

/** Return the current HEAD commit SHA of the repository. */
export async function baseCommit(directory: string): Promise<string> {
  return (await git(directory, ["rev-parse", "HEAD"])).trim()
}

/**
 * Assert that the working tree is clean outside `openspec/`. The automatic
 * workflow requires an unambiguous implementation baseline so its evidence
 * has a single base commit to bind against.
 *
 * @throws {Error} when tracked or untracked changes exist outside `openspec/`.
 */
export async function assertCleanWorktree(directory: string): Promise<void> {
  const status = await git(directory, ["status", "--porcelain=v1", "--untracked-files=all"])
  const implementationChanges = status
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      const changedPath = line.slice(3).replace(/^"|"$/g, "")
      const paths = changedPath.split(" -> ")
      return !paths.every((candidate) => candidate.startsWith("openspec/"))
    })
  if (implementationChanges.length) {
    throw new Error(
      "SpecOps automatic mode requires a clean implementation worktree outside openspec/ so its evidence has an unambiguous baseline. Commit, stash, or remove existing code changes yourself, then retry.\n" +
        implementationChanges.join("\n"),
    )
  }
}

/**
 * Detect whether a buffer contains binary content. Uses a NUL-byte check
 * followed by strict UTF-8 decoding so the diff stays text-only.
 *
 * @param buffer - The file bytes to inspect.
 */
export function isBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true
  try {
    TEXT_DECODER.decode(buffer)
    return false
  } catch {
    return true
  }
}

/**
 * Collect the complete implementation diff against HEAD, excluding `openspec/`.
 *
 * Includes tracked changes (via `git diff`) and untracked files (via
 * `git ls-files`), each rendered as a unified-diff hunk. Throws when the
 * resulting diff exceeds `review.max_diff_bytes`.
 *
 * @param directory - The repository working tree.
 * @param maximumBytes - Hard upper bound from `review.max_diff_bytes`.
 */
export async function collectDiff(directory: string, maximumBytes: number): Promise<string> {
  const tracked = await git(directory, [
    "diff",
    "--no-ext-diff",
    "--binary",
    "HEAD",
    "--",
    ".",
    ":(exclude)openspec/**",
  ])
  const untrackedOutput = await git(directory, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ".",
    ":(exclude)openspec/**",
  ])
  const sections = [tracked]
  for (const relative of untrackedOutput.split("\0").filter(Boolean).sort()) {
    const data = await readFile(path.join(directory, relative))
    if (isBinary(data)) {
      sections.push(`\n--- untracked binary: ${relative} (${data.byteLength} bytes) ---\n`)
    } else {
      sections.push(
        `\ndiff --git a/${relative} b/${relative}\nnew file mode 100644\n--- /dev/null\n+++ b/${relative}\n` +
          data
            .toString("utf-8")
            .split("\n")
            .map((line) => `+${line}`)
            .join("\n"),
      )
    }
  }
  const diff = sections.join("")
  if (Buffer.byteLength(diff) > maximumBytes) {
    throw new Error(
      `Review diff is ${Buffer.byteLength(diff)} bytes, above review.max_diff_bytes=${maximumBytes}. Increase the explicit limit or split the change.`,
    )
  }
  return diff || "(no implementation diff)"
}

/**
 * Measure the actual implementation footprint: file count, module count, and
 * the list of changed paths (tracked + untracked, excluding `openspec/`).
 *
 * Used by {@link footprintEscalation} to detect when the real diff outgrew the
 * tier that was originally selected.
 *
 * @param directory - The repository working tree.
 */
export async function implementationFootprint(directory: string): Promise<{
  files: number
  modules: number
  paths: string[]
}> {
  const tracked = await git(directory, [
    "diff",
    "--name-only",
    "HEAD",
    "--",
    ".",
    ":(exclude)openspec/**",
  ])
  const untracked = await git(directory, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    ".",
    ":(exclude)openspec/**",
  ])
  const paths = [...new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean))].sort()
  const modules = new Set(paths.map(moduleKey))
  return { files: paths.length, modules: modules.size, paths }
}

/** Group changed paths by a useful repository boundary rather than only the first segment. */
export function moduleKey(relative: string): string {
  const parts = relative.split("/")
  if (parts.length === 1) return "(root)"
  if (["src", "app", "lib", "packages"].includes(parts[0])) return parts.slice(0, 2).join("/")
  if (parts[0] === "tests" && parts.length >= 2) return parts.slice(0, 2).join("/")
  if (parts[0] === "resources" && parts.length >= 2) return parts.slice(0, 2).join("/")
  if (parts[0] === "database" && parts.length >= 2) return parts.slice(0, 2).join("/")
  return parts[0]
}

/**
 * Decide whether the actual implementation footprint should escalate the
 * workflow tier. Returns the target tier when escalation is required, or
 * `undefined` when the current tier still fits.
 *
 * - Files/modules at or above `full_min_*` force Full.
 * - Files/modules above `lean_max_*` (when currently Lean) raise to Standard.
 *
 * @param tier - The currently active tier.
 * @param footprint - The measured footprint from {@link implementationFootprint}.
 * @param config - The merged project configuration.
 */
export function footprintEscalation(
  tier: WorkflowTier,
  footprint: { files: number; modules: number },
  config: SpecOpsConfig,
): WorkflowTier | undefined {
  if (
    footprint.files >= config.workflow.full_min_files ||
    footprint.modules >= config.workflow.full_min_modules
  ) {
    return tier === "full" ? undefined : "full"
  }
  if (
    tier === "lean" &&
    (footprint.files > config.workflow.lean_max_files ||
      footprint.modules > config.workflow.lean_max_modules)
  ) {
    return "standard"
  }
  return undefined
}

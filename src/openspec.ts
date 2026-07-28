/**
 * Bundled OpenSpec CLI access and artifact persistence.
 *
 * Resolves the bundled `@fission-ai/openspec` binary, runs read-only and
 * read/write OpenSpec commands, onboards projects, and writes worker-generated
 * artifacts into OpenSpec change directories with safe path enforcement.
 */

import { createRequire } from "node:module"
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { SpecOpsConfig } from "./core.js"
import type { AgentRunner } from "./progress.js"
import { runProcess } from "./git.js"
import { stripFence, untrusted } from "./parsing.js"
import { extractJson } from "./parsing.js"

/** Directory of this compiled module (used to locate bundled assets relative to it). */
const PLUGIN_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))

/**
 * The project asset root: two levels up from the compiled plugin module.
 *
 * When published via npm, the plugin ships at `dist/index.js` and OpenSpec
 * assets ship at `openspec/`, so `PROJECT_ASSET_ROOT` resolves to the package
 * root. When loaded from a project's `.opencode/plugins/`, it resolves to the
 * project root. Both layouts keep `openspec/schemas/` reachable.
 */
const PROJECT_ASSET_ROOT = path.resolve(PLUGIN_DIRECTORY, "..", "..")

/**
 * OpenSpec CLI subcommands that are safe to expose read-only via the
 * `specops_openspec` tool. Anything outside this set is rejected to prevent
 * the controller from mutating OpenSpec state directly.
 */
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
 * Resolve the absolute path to the bundled `openspec` CLI binary.
 *
 * Uses `require.resolve` to find `@fission-ai/openspec`'s entry point, then
 * locates the `bin/openspec.js` sibling. This keeps the plugin self-contained
 * without relying on a global OpenSpec install.
 */
export function resolveBundledOpenSpec(): string {
  const require = createRequire(import.meta.url)
  const entry = require.resolve("@fission-ai/openspec")
  return path.resolve(path.dirname(entry), "..", "bin", "openspec.js")
}

/**
 * Read and merge the project's `.opencode/specops.json` configuration.
 *
 * Returns a validated {@link SpecOpsConfig}. When the file is missing, returns
 * a fresh clone of `DEFAULT_CONFIG`. Invalid JSON or validation failures throw.
 *
 * @param directory - The project root directory.
 */
export async function readConfig(directory: string): Promise<SpecOpsConfig> {
  const { DEFAULT_CONFIG, mergeConfig, validateConfig } = await import("./core.js")
  const filename = path.join(directory, ".opencode", "specops.json")
  try {
    return validateConfig(mergeConfig(JSON.parse(await readFile(filename, "utf-8"))))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG)
    throw new Error(`Invalid ${filename}: ${String(error)}`)
  }
}

/**
 * Run the bundled OpenSpec CLI with the given arguments.
 *
 * Honors `config.openspec.command` when the user has overridden the binary.
 * Always appends `--no-color` for parseable output.
 *
 * @param directory - The project root (passed as `cwd` to the CLI).
 * @param config - The merged SpecOps configuration.
 * @param args - OpenSpec CLI arguments (without the `openspec` executable).
 * @param signal - Optional abort signal.
 */
export async function runOpenSpec(
  directory: string,
  config: SpecOpsConfig,
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const override = config.openspec.command
  const command = override?.[0] ?? "node"
  const prefix = override?.slice(1) ?? [resolveBundledOpenSpec()]
  return runProcess(command, [...prefix, ...args, "--no-color"], directory, signal)
}

/**
 * Run the OpenSpec CLI and throw on non-zero exit. Returns stdout on success.
 *
 * @param directory - The project root.
 * @param config - The merged SpecOps configuration.
 * @param args - OpenSpec CLI arguments.
 * @param signal - Optional abort signal.
 * @throws {Error} when the CLI exits non-zero.
 */
export async function openSpecOrThrow(
  directory: string,
  config: SpecOpsConfig,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await runOpenSpec(directory, config, args, signal)
  if (result.code !== 0) {
    throw new Error(
      `OpenSpec ${args.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`,
    )
  }
  return result.stdout
}

/**
 * Fetch the OpenSpec instructions block for a specific artifact in a change.
 *
 * @param directory - The project root.
 * @param config - The merged SpecOps configuration.
 * @param change - The OpenSpec change slug.
 * @param artifact - The artifact name (e.g. `"exploration"`, `"specs"`).
 */
export async function instructions(
  directory: string,
  config: SpecOpsConfig,
  change: string,
  artifact: string,
): Promise<string> {
  return openSpecOrThrow(directory, config, [
    "instructions",
    artifact,
    "--change",
    change,
    "--json",
  ])
}

/**
 * Recursively copy a source tree into a destination, skipping files that
 * already exist. Used by {@link onboard} to seed OpenSpec schema assets.
 *
 * @param source - Absolute source directory.
 * @param destination - Absolute destination directory.
 * @returns The number of files copied.
 */
async function copyMissingTree(source: string, destination: string): Promise<number> {
  const entries = await readdir(source, { withFileTypes: true })
  let count = 0
  for (const entry of entries) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true })
      count += await copyMissingTree(from, to)
      continue
    }
    try {
      await stat(to)
    } catch {
      await copyFile(from, to)
      count += 1
    }
  }
  return count
}

/**
 * Onboard a project: create the `openspec/` skeleton and copy the three
 * SpecOps schema bundles (lean, standard, full) if missing. Existing files
 * and configuration are never overwritten.
 *
 * @param directory - The project root.
 * @returns A human-readable summary of what was created.
 */
export async function onboard(directory: string): Promise<string> {
  const openspec = path.join(directory, "openspec")
  await mkdir(path.join(openspec, "specs"), { recursive: true })
  await mkdir(path.join(openspec, "changes"), { recursive: true })

  let copied = 0
  for (const schema of ["specops", "specops-lean", "specops-standard"]) {
    const schemaSource = path.join(PROJECT_ASSET_ROOT, "openspec", "schemas", schema)
    const schemaDestination = path.join(openspec, "schemas", schema)
    await mkdir(schemaDestination, { recursive: true })
    try {
      copied += await copyMissingTree(schemaSource, schemaDestination)
    } catch (error) {
      throw new Error(
        `SpecOps schema assets are unavailable at ${schemaSource}. Install the complete plugin bundle. ${String(error)}`,
      )
    }
  }

  const configPath = path.join(openspec, "config.yaml")
  try {
    await stat(configPath)
  } catch {
    await writeFile(
      configPath,
      `schema: specops\ncontext: |\n  Add stable project architecture, conventions, constraints, and validation commands here.\nrules:\n  verification:\n    - Record only commands that were actually executed and their exit status.\n`,
      "utf-8",
    )
    copied += 1
  }
  return `SpecOps onboarding complete. Created ${copied} missing file(s); existing OpenSpec configuration and schema defaults were preserved.`
}

/**
 * Onboard and then run the `sdd-onboard` worker to produce durable project
 * memory at `openspec/onboarding.md`. Existing onboarding is passed as
 * context so the worker can preserve still-correct facts.
 *
 * @param directory - The project root.
 * @param runner - The agent runner.
 * @param context - Optional user-supplied context string.
 * @param parentID - The parent session ID for the worker.
 */
export async function onboardWithContext(
  directory: string,
  runner: AgentRunner,
  context: string,
  parentID: string,
): Promise<{ message: string; projectContext: string }> {
  const message = await onboard(directory)
  const onboardingPath = path.join(directory, "openspec", "onboarding.md")
  const existing = await readFile(onboardingPath, "utf-8").catch(
    () => "(no existing onboarding memory)",
  )
  const projectContext = await runner(
    "sdd-onboard",
    `Analyze this repository and return the complete durable onboarding Markdown to store at openspec/onboarding.md. Cover architecture, stack, conventions, validation commands, safety boundaries, and important unknowns. Preserve still-correct useful facts from existing memory, correct stale facts, and incorporate the user's context. Do not edit files and do not include a code fence.\n\n${untrusted("user-context", context || "(none provided)")}\n\n${untrusted("existing-onboarding-memory", existing)}`,
    parentID,
  )
  await writeFile(onboardingPath, stripFence(projectContext), "utf-8")
  return { message, projectContext }
}

/**
 * Write a worker-generated artifact into an OpenSpec change directory.
 *
 * Path safety is enforced: relative paths only, no `..` traversal, no leading
 * dot, and the resolved destination must stay inside the change root. Markdown
 * fences are stripped from the content.
 *
 * @param directory - The project root.
 * @param change - The OpenSpec change slug.
 * @param relative - The artifact's relative path within the change directory.
 * @param content - The artifact content (possibly fenced).
 * @throws {Error} when the path escapes the change directory.
 */
export async function writeArtifact(
  directory: string,
  change: string,
  relative: string,
  content: string,
): Promise<void> {
  if (
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).includes("..") ||
    relative.startsWith(".")
  ) {
    throw new Error(`Unsafe artifact path returned by agent: ${relative}`)
  }
  const changeRoot = path.join(directory, "openspec", "changes", change)
  const destination = path.resolve(changeRoot, relative)
  if (!destination.startsWith(changeRoot + path.sep)) throw new Error(`Artifact escaped change: ${relative}`)
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, stripFence(content), "utf-8")
}

/** Maps single-file artifact names to their on-disk filenames. */
const ARTIFACT_FILENAMES: Record<string, string> = {
  exploration: "exploration.md",
  proposal: "proposal.md",
  design: "design.md",
  tasks: "tasks.md",
  verification: "verification.md",
}

/**
 * Generate a single OpenSpec artifact by running the appropriate worker.
 *
 * For the `specs` artifact, the worker returns JSON with a `files` map; each
 * file is validated and written separately. For all other artifacts, the
 * worker returns Markdown written to the canonical filename.
 *
 * @param runner - The agent runner.
 * @param directory - The project root.
 * @param config - The merged SpecOps configuration.
 * @param change - The OpenSpec change slug.
 * @param artifact - The artifact name (e.g. `"exploration"`, `"specs"`).
 * @param agent - The worker agent ID (e.g. `"sdd-explore"`).
 * @param parentID - The parent session ID.
 * @param additionalContext - Optional extra context appended to the prompt.
 */
export async function generateArtifact(
  runner: AgentRunner,
  directory: string,
  config: SpecOpsConfig,
  change: string,
  artifact: string,
  agent: string,
  parentID: string,
  additionalContext?: string,
): Promise<string> {
  const guide = await instructions(directory, config, change, artifact)
  const contextBlock = additionalContext
    ? `\n\n${untrusted("specops-stage-context", additionalContext)}`
    : ""
  if (artifact === "specs") {
    const output = await runner(
      agent,
      `Create the requested OpenSpec specification artifacts. Return ONLY valid JSON in this shape: {"files":{"specs/<capability>/spec.md":"complete markdown"}}. Do not use absolute paths or '..'.\n\n${untrusted("openspec-instructions", guide)}${contextBlock}`,
      parentID,
    )
    const value = extractJson(output) as { files?: Record<string, unknown> }
    if (!value.files || typeof value.files !== "object" || !Object.keys(value.files).length) {
      throw new Error("sdd-spec returned no specification files")
    }
    for (const [relative, content] of Object.entries(value.files)) {
      if (!/^specs\/[a-z0-9][a-z0-9-]*\/spec\.md$/.test(relative) || typeof content !== "string") {
        throw new Error(`sdd-spec returned an invalid file entry: ${relative}`)
      }
      await writeArtifact(directory, change, relative, content)
    }
    return output
  }
  const output = await runner(
    agent,
    `Create the complete ${artifact} artifact from these current OpenSpec instructions. Return ONLY the Markdown file content; do not edit repository files.\n\n${untrusted("openspec-instructions", guide)}${contextBlock}`,
    parentID,
  )
  await writeArtifact(directory, change, ARTIFACT_FILENAMES[artifact], output)
  return output
}

/**
 * Generate a unique OpenSpec change slug from a goal. If the slug already
 * exists, appends a short timestamp suffix to avoid collisions.
 *
 * @param directory - The project root.
 * @param goal - The user's goal text.
 */
export async function uniqueChangeName(directory: string, goal: string): Promise<string> {
  const { slugifyGoal } = await import("./core.js")
  const base = slugifyGoal(goal)
  try {
    await stat(path.join(directory, "openspec", "changes", base))
  } catch {
    return base
  }
  return `${base.slice(0, 42).replace(/-+$/g, "")}-${Date.now().toString(36)}`
}

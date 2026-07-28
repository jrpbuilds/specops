/**
 * Read-only readiness diagnostics.
 *
 * The `specops-doctor` command runs these checks and reports each result as
 * `PASS`/`FAIL`/`INFO`. Diagnostics never mutate state.
 */

import { stat } from "node:fs/promises"
import path from "node:path"
import type { SpecOpsConfig } from "./core.js"
import { openSpecOrThrow } from "./openspec.js"
import { runProcess } from "./git.js"

/**
 * Run all SpecOps readiness checks for a project.
 *
 * Checks performed:
 * 1. Node.js is available and reports a version.
 * 2. The directory is inside a Git repository.
 * 3. The bundled OpenSpec CLI reports a version.
 * 4. The three SpecOps schemas are present on disk.
 * 5. The configured MCP policy is reported (never required by SpecOps).
 *
 * @param directory - The project root.
 * @param config - The merged SpecOps configuration.
 * @returns A newline-joined list of `PASS`/`FAIL`/`INFO` lines.
 */
export async function doctor(directory: string, config: SpecOpsConfig): Promise<string> {
  const checks: string[] = []
  const node = await runProcess("node", ["--version"], directory)
  checks.push(`${node.code === 0 ? "PASS" : "FAIL"} Node: ${(node.stdout || node.stderr).trim()}`)
  const repository = await runProcess("git", ["rev-parse", "--show-toplevel"], directory)
  checks.push(`${repository.code === 0 ? "PASS" : "FAIL"} Git repository`)
  try {
    const version = await openSpecOrThrow(directory, config, ["--version"])
    checks.push(`PASS bundled OpenSpec: ${version.trim()}`)
  } catch (error) {
    checks.push(`FAIL OpenSpec: ${String(error)}`)
  }
  for (const schema of ["specops-lean", "specops-standard", "specops"]) {
    try {
      await stat(path.join(directory, "openspec", "schemas", schema, "schema.yaml"))
      checks.push(`PASS schema: ${schema}`)
    } catch {
      checks.push(`FAIL schema: ${schema} missing; run /sdd-onboard`)
    }
  }
  checks.push(
    `${config.integrations.mcp === "inherit" ? "INFO" : "PASS"} MCP: ${config.integrations.mcp} (never required by SpecOps)`,
  )
  return checks.join("\n")
}

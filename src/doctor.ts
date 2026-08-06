import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { AGENT_IDS, ALL_AGENT_IDS, CONTROLLER_AGENT_IDS } from "./capabilities/ids.js"
import {
    AGENT_REGISTRY,
    SCHEDULER_CAPABILITIES,
    agentForCapability,
} from "./capabilities/registry.js"
import { COMMANDS } from "./commands.js"
import { type SpecOpsConfig, consumeConfigRepairs, validatePartialConfig } from "./config.js"
import { runProcess } from "./git.js"
import {
    inspectAgentManifest,
    resolveGlobalConfigPath,
    resolveManifestPath,
} from "./installation.js"
import { promptText } from "./prompts.generated.js"

/**
 * Outcome of a single diagnostic check: `status` plus a human-readable
 * `message` and an optional `repair` hint shown only on `FAIL`.
 */
type Diagnostic = {
    status: "PASS" | "FAIL" | "INFO" | "WARN"
    message: string
    repair?: string
}

/**
 * Run integration diagnostics that catch command/controller drift before use.
 *
 * Executes a fixed sequence of checks against the package metadata, manifest,
 * command mappings, host CLI, agent catalogue, capability mappings, prompts,
 * and installed OpenSpec schemas, then formats the collected diagnostics as a
 * newline-joined string.
 *
 * @param directory - Project directory the diagnostics operate against.
 * @param config - Parsed SpecOps configuration used to seed initial diagnostics.
 * @returns All collected diagnostics joined with newlines, with `Repair:`
 * hints appended to `FAIL` lines.
 */
export async function doctor(directory: string, config: SpecOpsConfig): Promise<string> {
    const subagentCount = ALL_AGENT_IDS.filter(id => AGENT_REGISTRY[id].mode === "subagent").length
    const diagnostics: Diagnostic[] = [
        { status: "PASS", message: `configuration format v${config.version} parsed` },
        {
            status: "INFO",
            message:
                config.integrations.mcp === "disabled"
                    ? `MCP policy: disabled (configured MCP server tools denied for ${subagentCount} SpecOps subagents)`
                    : "MCP policy: allow (configured host MCP server tools granted to SpecOps subagents)",
        },
    ]

    await checkConfigSources(diagnostics, directory)
    surfaceConfigRepairs(diagnostics)
    await checkPackageVersion(diagnostics)
    await checkManifest(diagnostics)
    checkCommandMappings(diagnostics)
    await checkOpenCodeCli(directory, diagnostics)
    checkAgentCatalogue(diagnostics)
    checkCapabilityMappings(diagnostics)
    checkPrompts(diagnostics)
    await checkOpenSpecAssets(directory, diagnostics)

    return diagnostics
        .map(item => {
            const base = `${item.status} ${item.message}`
            return item.status === "FAIL" && item.repair
                ? `${base}\n  Repair: ${item.repair}`
                : base
        })
        .join("\n")
}

/**
 * Surface a `WARN` diagnostic for every configuration file repaired during
 * the most recent `resolveConfig` call.
 *
 * Repairs are consumed (cleared) so each load-time repair is reported exactly
 * once. A repaired file is currently valid — it was rewritten at load time —
 * so the diagnostic is `WARN`, not `FAIL`.
 */
function surfaceConfigRepairs(diagnostics: Diagnostic[]): void {
    for (const repair of consumeConfigRepairs()) {
        const kept =
            repair.recoveredSections.length > 0 ? repair.recoveredSections.join(", ") : "none"
        diagnostics.push({
            status: "WARN",
            message: `configuration file ${repair.path} was repaired at load time: ${repair.reason}; kept sections: ${kept}`,
            repair: `Edit ${repair.path} and rerun /specops-doctor to confirm.`,
        })
    }
}

/**
 * Read and partially validate a configuration file, pushing a FAIL diagnostic
 * when it exists but is invalid.
 *
 * @param filePath - Configuration file to read.
 * @param diagnostics - Shared diagnostic accumulator.
 * @returns The parsed partial configuration, or `undefined` when the file is
 *   missing or invalid.
 */
async function readPartialDiagnostic(
    filePath: string,
    diagnostics: Diagnostic[],
): Promise<Record<string, unknown> | undefined> {
    try {
        const raw = JSON.parse(await readFile(filePath, "utf8"))
        return validatePartialConfig(raw, filePath) as Record<string, unknown>
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined
        }
        if (error instanceof Error) {
            diagnostics.push({
                status: "FAIL",
                message: `in ${filePath}: ${error.message}`,
                repair: `Fix ${filePath} and rerun /specops-doctor.`,
            })
            return undefined
        }
        throw error
    }
}

/**
 * Determine whether a value is a plain object (not null and not an array).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * Collect dotted key paths where `override` changes a value that `base` also
 * sets.
 *
 * Plain objects are recursed; arrays, primitives, and explicit `null` are
 * compared as leaf values. A key that `override` adds but `base` does not have
 * is not listed (it is an addition, not an override).
 */
function overridenDottedPaths(
    base: Record<string, unknown>,
    override: Record<string, unknown>,
    prefix = "",
): string[] {
    const paths: string[] = []
    for (const key of Object.keys(override)) {
        const full = prefix ? `${prefix}.${key}` : key
        const baseValue = base[key]
        const overrideValue = override[key]
        if (isRecord(baseValue) && isRecord(overrideValue)) {
            paths.push(...overridenDottedPaths(baseValue, overrideValue, full))
        } else if (baseValue !== undefined && !isDeepStrictEqual(baseValue, overrideValue)) {
            paths.push(full)
        }
    }
    return paths
}

/**
 * Warn when the project configuration overrides values provided by the global
 * configuration.
 *
 * Pushes a single diagnostic listing the dotted key paths of every value the
 * project overrides (i.e., changes a key the global file also sets). If either
 * file is missing, no override comparison is performed.
 *
 * @param diagnostics - Shared diagnostic accumulator.
 * @param directory - Project directory where `.opencode/specops.json` is read.
 */
async function checkConfigSources(diagnostics: Diagnostic[], directory: string): Promise<void> {
    const globalPath = resolveGlobalConfigPath()
    const projectPath = path.join(directory, ".opencode", "specops.json")
    const globalPartial = await readPartialDiagnostic(globalPath, diagnostics)
    const projectPartial = await readPartialDiagnostic(projectPath, diagnostics)

    if (!globalPartial || !projectPartial) {
        const sources: string[] = []
        if (globalPartial) sources.push(`global ${globalPath}`)
        if (projectPartial) sources.push(`project ${projectPath}`)
        if (!sources.length) sources.push("using defaults")
        diagnostics.push({
            status: "INFO",
            message: `configuration sources: ${sources.join(", ")}`,
        })
        return
    }

    const overridden = overridenDottedPaths(globalPartial, projectPartial)
    if (overridden.length) {
        diagnostics.push({
            status: "WARN",
            message: `project configuration overrides global at: ${overridden.join(", ")}`,
        })
    } else {
        diagnostics.push({
            status: "PASS",
            message: "project configuration does not override global values",
        })
    }
}

/**
 * Check that `package.json` exposes the correct `@jrpbuilds/specops` name and
 * a non-empty version string.
 *
 * Pushes a `PASS` or `FAIL` diagnostic into the shared array.
 *
 * @param diagnostics - Shared diagnostic accumulator.
 */
async function checkPackageVersion(diagnostics: Diagnostic[]): Promise<void> {
    try {
        const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
        const metadata = JSON.parse(
            await readFile(path.join(packageRoot, "package.json"), "utf8"),
        ) as {
            name?: string
            version?: string
        }
        diagnostics.push({
            status:
                metadata.name === "@jrpbuilds/specops" && Boolean(metadata.version)
                    ? "PASS"
                    : "FAIL",
            message: `packaged plugin metadata: ${metadata.name ?? "missing"}@${metadata.version ?? "missing"}`,
            repair: "Rebuild and reinstall the packed @jrpbuilds/specops package.",
        })
    } catch (error) {
        diagnostics.push({
            status: "FAIL",
            message: `packaged plugin metadata is unreadable: ${String(error)}`,
            repair: "Rebuild and reinstall the packed @jrpbuilds/specops package.",
        })
    }
}

/**
 * Check that the agent manifest at {@link resolveManifestPath} is valid and
 * contains the complete final agent catalogue.
 *
 * Pushes a single `PASS` or `FAIL` diagnostic.
 *
 * @param diagnostics - Shared diagnostic accumulator.
 */
async function checkManifest(diagnostics: Diagnostic[]): Promise<void> {
    const manifestPath = resolveManifestPath()
    const inspection = await inspectAgentManifest(manifestPath)
    if (inspection.status === "invalid") {
        diagnostics.push({
            status: "FAIL",
            message: `agent manifest ${inspection.path} is invalid: ${inspection.reason}`,
            repair: "Restart OpenCode to rematerialise the final manifest, or reinstall SpecOps; removed IDs are not retained.",
        })
        return
    }

    diagnostics.push({
        status: "PASS",
        message: `agent manifest ${inspection.path} contains all ${ALL_AGENT_IDS.length} final agents`,
    })
}

/**
 * Verify each command-to-agent mapping resolves to the canonical controller
 * agent from the registry.
 *
 * Pushes one diagnostic per command mapping checked.
 *
 * @param diagnostics - Shared diagnostic accumulator.
 */
function checkCommandMappings(diagnostics: Diagnostic[]): void {
    const mappings = [
        {
            command: "/specops",
            actual: COMMANDS.specops?.agent,
            expected: AGENT_IDS.controller.interactive,
        },
        {
            command: "/specops-auto",
            actual: COMMANDS["specops-auto"]?.agent,
            expected: AGENT_IDS.controller.automatic,
        },
    ]
    for (const mapping of mappings) {
        diagnostics.push({
            status:
                mapping.actual === mapping.expected && mapping.actual in AGENT_REGISTRY
                    ? "PASS"
                    : "FAIL",
            message: `${mapping.command} resolves ${mapping.actual ?? "no agent"}; expected ${mapping.expected}`,
            repair: "Rebuild and reinstall SpecOps so commands and the canonical agent registry match.",
        })
    }
}

/**
 * Verify the installed host exposes the documented non-interactive command
 * adapter by invoking `opencode run --help` and checking for the required
 * `--command`, `--dir`, and `--format` flags.
 *
 * Pushes a `PASS` or `FAIL` diagnostic depending on the CLI output.
 *
 * @param directory - Project directory used as the working directory for the
 * host CLI invocation.
 * @param diagnostics - Shared diagnostic accumulator.
 */
async function checkOpenCodeCli(directory: string, diagnostics: Diagnostic[]): Promise<void> {
    try {
        const result = await runProcess(
            "opencode",
            ["run", "--help"],
            directory,
            AbortSignal.timeout(5_000),
            { PATH: process.env.PATH ?? "" },
            16_000,
        )
        const help = `${result.stdout}\n${result.stderr}`
        const supported =
            result.code === 0 &&
            help.includes("--command") &&
            help.includes("--dir") &&
            help.includes("--format")
        diagnostics.push({
            status: supported ? "PASS" : "FAIL",
            message: supported
                ? "CLI auto available: opencode run --command specops-auto --dir <project> <goal>"
                : "installed OpenCode CLI does not expose run --command, --dir, and --format",
            repair: "Install a supported OpenCode release and rerun /specops-doctor.",
        })
    } catch (error) {
        diagnostics.push({
            status: "FAIL",
            message: `OpenCode CLI auto check failed: ${String(error)}`,
            repair: "Install OpenCode on PATH and rerun /specops-doctor.",
        })
    }
}

/**
 * Verify every controller agent is registered as `primary` and every
 * non-controller agent is registered as `subagent`.
 *
 * Pushes one diagnostic per controller plus one collective diagnostic for the
 * worker subagent check.
 *
 * @param diagnostics - Shared diagnostic accumulator.
 */
function checkAgentCatalogue(diagnostics: Diagnostic[]): void {
    for (const controller of CONTROLLER_AGENT_IDS) {
        const policy = AGENT_REGISTRY[controller]
        diagnostics.push({
            status: policy?.mode === "primary" ? "PASS" : "FAIL",
            message: `controller ${controller} is registered as ${policy?.mode ?? "missing"}`,
            repair: `Reinstall SpecOps; ${controller} must come from the canonical registry as a primary agent.`,
        })
    }

    const invalidWorker = ALL_AGENT_IDS.find(
        id =>
            !CONTROLLER_AGENT_IDS.includes(id as (typeof CONTROLLER_AGENT_IDS)[number]) &&
            AGENT_REGISTRY[id]?.mode !== "subagent",
    )
    diagnostics.push({
        status: invalidWorker ? "FAIL" : "PASS",
        message: invalidWorker
            ? `worker ${invalidWorker} is not registered as a subagent`
            : "all capability workers are registered as subagents",
        repair: "Reinstall SpecOps from a package generated from the canonical registry.",
    })
}

/**
 * Verify every scheduler capability resolves to a registered agent via
 * {@link agentForCapability}, distinguishing judgment and workflow purposes.
 *
 * Pushes a single `PASS` or `FAIL` diagnostic.
 *
 * @param diagnostics - Shared diagnostic accumulator.
 */
function checkCapabilityMappings(diagnostics: Diagnostic[]): void {
    const missing = SCHEDULER_CAPABILITIES.flatMap(capability => {
        const agent = agentForCapability(
            capability,
            capability === "correctness-judgment" || capability === "compliance-judgment"
                ? "judgment"
                : "workflow",
        )
        return agent in AGENT_REGISTRY ? [] : [`${capability} -> ${String(agent)}`]
    })
    diagnostics.push({
        status: missing.length ? "FAIL" : "PASS",
        message: missing.length
            ? `capability mappings are unresolved: ${missing.join(", ")}`
            : `all ${SCHEDULER_CAPABILITIES.length} scheduler capabilities resolve registered agents`,
        repair: "Rebuild SpecOps; capability mappings must derive from the canonical agent IDs.",
    })
}

/** Mandatory guardrail phrases that must be present in controller prompts. */
const CONTROLLER_GUARDRAIL_PHRASES = [
    "specops-assessor",
    "FIRST action",
    "Never do",
    "collapse, simulate",
    "specops_next_action",
    "specops_complete_action",
]

/**
 * Verify every final agent has a non-empty generated prompt via
 * {@link promptText} and that controller prompts carry the mandatory
 * guardrail phrases.
 *
 * Pushes a single `PASS` or `FAIL` diagnostic.
 *
 * @param diagnostics - Shared diagnostic accumulator.
 */
function checkPrompts(diagnostics: Diagnostic[]): void {
    const missing = ALL_AGENT_IDS.filter(id => !promptText(id).trim())
    const controllerDrift = CONTROLLER_AGENT_IDS.filter(id => {
        const text = promptText(id)
        return CONTROLLER_GUARDRAIL_PHRASES.some(phrase => !text.includes(phrase))
    })
    const status = missing.length || controllerDrift.length ? "FAIL" : "PASS"
    const message = missing.length
        ? `generated prompts are missing for: ${missing.join(", ")}`
        : controllerDrift.length
          ? `controller prompt guardrails are missing for: ${controllerDrift.join(", ")}`
          : `embedded prompts resolve for all ${ALL_AGENT_IDS.length} final agents with controller guardrails`
    diagnostics.push({
        status,
        message,
        repair: "Run npm run generate and reinstall the rebuilt package.",
    })
}

/**
 * Verify the project uses the standard upstream `spec-driven` schema.
 *
 * @param directory - Project directory where the schemas are expected.
 * @param diagnostics - Shared diagnostic accumulator.
 */
async function checkOpenSpecAssets(directory: string, diagnostics: Diagnostic[]): Promise<void> {
    try {
        const config = await readFile(path.join(directory, "openspec", "config.yaml"), "utf8")
        if (!/^schema:\s*spec-driven\s*$/m.test(config)) throw new Error("unsupported schema")
        diagnostics.push({ status: "PASS", message: "OpenSpec project uses spec-driven" })
    } catch {
        diagnostics.push({
            status: "FAIL",
            message: "OpenSpec project is not configured for spec-driven",
            repair: "Run /specops-onboard in this repository.",
        })
    }
}

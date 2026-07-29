import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { AGENT_IDS, ALL_AGENT_IDS, CONTROLLER_AGENT_IDS } from "./capabilities/ids.js"
import {
    AGENT_REGISTRY,
    SCHEDULER_CAPABILITIES,
    agentForCapability,
} from "./capabilities/registry.js"
import { COMMANDS } from "./commands.js"
import type { SpecOpsConfig } from "./config.js"
import { runProcess } from "./git.js"
import { inspectAgentManifest, resolveManifestPath } from "./installation.js"
import { promptText } from "./prompts.generated.js"

/**
 * Outcome of a single diagnostic check: `status` plus a human-readable
 * `message` and an optional `repair` hint shown only on `FAIL`.
 */
type Diagnostic = {
    status: "PASS" | "FAIL" | "INFO"
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
    const diagnostics: Diagnostic[] = [
        { status: "PASS", message: `configuration format v${config.version} parsed` },
        { status: "INFO", message: `MCP policy: ${config.integrations.mcp}` },
    ]

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
    if (inspection.status === "upgrade-required") {
        diagnostics.push({
            status: "FAIL",
            message: `agent manifest ${inspection.path} uses legacy schema v1`,
            repair: "Open “SpecOps: Configure agent models” in OpenCode and save the upgraded mapping.",
        })
        return
    }
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

/**
 * Verify every final agent has a non-empty generated prompt via
 * {@link promptText}.
 *
 * Pushes a single `PASS` or `FAIL` diagnostic.
 *
 * @param diagnostics - Shared diagnostic accumulator.
 */
function checkPrompts(diagnostics: Diagnostic[]): void {
    const missing = ALL_AGENT_IDS.filter(id => !promptText(id).trim())
    diagnostics.push({
        status: missing.length ? "FAIL" : "PASS",
        message: missing.length
            ? `generated prompts are missing for: ${missing.join(", ")}`
            : `embedded prompts resolve for all ${ALL_AGENT_IDS.length} final agents`,
        repair: "Run npm run generate and reinstall the rebuilt package.",
    })
}

/**
 * Verify the OpenSpec schemas for the `specops-lean`, `specops-standard`, and
 * `specops` tiers are installed in `<directory>/openspec/schemas/<tier>`.
 *
 * Pushes one `PASS` or `FAIL` diagnostic per schema.
 *
 * @param directory - Project directory where the schemas are expected.
 * @param diagnostics - Shared diagnostic accumulator.
 */
async function checkOpenSpecAssets(directory: string, diagnostics: Diagnostic[]): Promise<void> {
    for (const schema of ["specops-lean", "specops-standard", "specops"]) {
        try {
            await stat(path.join(directory, "openspec", "schemas", schema, "schema.yaml"))
            diagnostics.push({ status: "PASS", message: `OpenSpec schema installed: ${schema}` })
        } catch {
            diagnostics.push({
                status: "FAIL",
                message: `OpenSpec schema is missing: ${schema}`,
                repair: "Run /specops-onboard in this repository.",
            })
        }
    }
}

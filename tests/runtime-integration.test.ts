import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Config, PluginInput } from "@opencode-ai/plugin"
import { afterEach, describe, expect, it } from "vitest"
import { AGENT_IDS, ALL_AGENT_IDS, CONTROLLER_AGENT_IDS } from "../src/capabilities/ids.js"
import {
    AGENT_REGISTRY,
    SCHEDULER_CAPABILITIES,
    agentForCapability,
} from "../src/capabilities/registry.js"
import { COMMANDS } from "../src/commands.js"
import { DEFAULT_CONFIG, SPECOPS_CONFIG_SCHEMA_URL, validateConfig } from "../src/config.js"
import {
    MCP_TOOL_WILDCARD,
    resolveGlobalConfigPath,
    resolveManifestPath,
} from "../src/installation.js"
import { validateManifest } from "../src/manifest.js"
import { SpecOpsPluginWithManifest } from "../src/index.js"
import { promptText } from "../src/prompts.generated.js"
import { ALL_TOOL_IDS } from "../src/protocol.js"

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

afterEach(() => {
    if (originalXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
    } else {
        process.env.XDG_CONFIG_HOME = originalXdgConfigHome
    }
})

describe.sequential("installed runtime contract", () => {
    it("derives command controllers and worker resolution from the canonical IDs", () => {
        expect(COMMANDS.specops?.agent).toBe(AGENT_IDS.controller.interactive)
        expect(COMMANDS["specops-auto"]?.agent).toBe(AGENT_IDS.controller.automatic)
        expect(Object.keys(COMMANDS).sort()).toEqual(
            [
                "specops",
                "specops-auto",
                "specops-doctor",
                "specops-onboard",
                "specops-status",
            ].sort(),
        )
        expect(promptText(AGENT_IDS.controller.automatic)).toContain("mode automatic")

        for (const capability of SCHEDULER_CAPABILITIES) {
            expect(AGENT_REGISTRY[agentForCapability(capability)]).toBeDefined()
        }
        for (const id of ALL_AGENT_IDS) {
            expect(AGENT_REGISTRY[id].id).toBe(id)
            expect(promptText(id)).not.toHaveLength(0)
        }
    })

    it("materialises an exact final manifest and registers every packaged agent", async () => {
        const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "specops-runtime-"))
        process.env.XDG_CONFIG_HOME = path.join(temporaryHome, "config")
        const manifestPath = resolveManifestPath()

        // A partial file must be cleanly replaced, never merged with obsolete IDs.
        await mkdir(path.dirname(manifestPath), { recursive: true })
        await writeFile(manifestPath, `${JSON.stringify({ version: 2, agents: {} }, null, 2)}\n`)

        const hooks = await SpecOpsPluginWithManifest(fakePluginInput())
        const config: Config = {}
        await hooks.config?.(config)

        const globalConfig = JSON.parse(await readFile(resolveGlobalConfigPath(), "utf8"))
        expect(globalConfig.$schema).toBe(SPECOPS_CONFIG_SCHEMA_URL)
        expect(validateConfig(globalConfig)).toEqual(DEFAULT_CONFIG)

        const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")))
        expect(Object.keys(manifest.agents).sort()).toEqual([...ALL_AGENT_IDS].sort())
        expect(Object.keys(config.agent ?? {}).sort()).toEqual([...ALL_AGENT_IDS].sort())

        const interactive = config.agent?.[AGENT_IDS.controller.interactive]
        const automatic = config.agent?.[AGENT_IDS.controller.automatic]
        const interactivePermission = interactive?.permission as Record<string, string> | undefined
        const automaticPermission = automatic?.permission as Record<string, string> | undefined
        expect(interactive?.mode).toBe("primary")
        expect(automatic?.mode).toBe("primary")
        expect(interactive?.maxSteps).toBe(1_000)
        // Subagent dispatch is allowed for both controllers; the native
        // question tool is allowed only for the interactive variant.
        expect(automaticPermission?.task).toBe("allow")
        expect(interactivePermission?.task).toBe("allow")
        expect(automaticPermission?.question).toBe("deny")
        expect(interactivePermission?.question).toBe("allow")

        const controllerPermission: Record<string, string> = {
            bash: "deny",
            edit: "deny",
            read: "deny",
            glob: "deny",
            grep: "deny",
            todowrite: "deny",
            task: "allow",
        }
        // Both controllers share this exact permission key set; the per-key
        // loop below also catches an unexpected extra key (closed permission set).
        const controllerPermissionKeys = [
            "bash",
            "edit",
            "glob",
            "grep",
            "question",
            "read",
            "task",
            "todowrite",
        ].sort()
        for (const id of CONTROLLER_AGENT_IDS) {
            const permission = config.agent?.[id]?.permission as Record<string, string>
            expect(Object.keys(permission).sort()).toEqual(controllerPermissionKeys)
            for (const [key, value] of Object.entries(controllerPermission)) {
                expect(permission[key], `${id}.${key}`).toBe(value)
            }
            const expectedQuestion = id === AGENT_IDS.controller.interactive ? "allow" : "deny"
            expect(permission.question, `${id}.question`).toBe(expectedQuestion)
            const prompt = promptText(id)
            expect(prompt).toContain("FIRST action")
            expect(prompt).toContain("specops-assessor")
            expect(prompt).toContain("Never do")
            expect(prompt).toContain("collapse, simulate")
        }

        for (const id of ALL_AGENT_IDS) {
            expect(config.agent?.[id]?.prompt).toBe(promptText(id))
            if (!CONTROLLER_AGENT_IDS.includes(id as (typeof CONTROLLER_AGENT_IDS)[number])) {
                expect(config.agent?.[id]?.mode).toBe("subagent")
                expect(config.agent?.[id]?.tools?.[MCP_TOOL_WILDCARD]).toBeUndefined()
                expect(
                    (config.agent?.[id]?.permission as Record<string, string> | undefined)?.task,
                ).toBe("deny")
                // Workers need read/glob/grep to inspect the repository.
                expect(
                    (config.agent?.[id]?.permission as Record<string, string> | undefined)?.read,
                ).not.toBe("deny")
            }
        }

        expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([...ALL_TOOL_IDS].sort())
    })

    it("applies global MCP policy and project overrides in precedence order", async () => {
        const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "specops-mcp-precedence-"))
        const configHome = path.join(temporaryRoot, "config")
        const projectDirectory = path.join(temporaryRoot, "project")
        process.env.XDG_CONFIG_HOME = configHome
        await mkdir(path.join(configHome, "opencode"), { recursive: true })
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        await writeFile(
            path.join(configHome, "opencode", "specops.json"),
            `${JSON.stringify({ integrations: { mcp: "disabled" } })}\n`,
            "utf8",
        )

        const worker = ALL_AGENT_IDS.find(
            id => !CONTROLLER_AGENT_IDS.includes(id as (typeof CONTROLLER_AGENT_IDS)[number]),
        )!
        const disabledHooks = await SpecOpsPluginWithManifest(fakePluginInput(projectDirectory))
        const disabledConfig: Config = {}
        await disabledHooks.config?.(disabledConfig)
        expect(disabledConfig.agent?.[worker]?.tools?.[MCP_TOOL_WILDCARD]).toBe(false)

        await writeFile(
            path.join(projectDirectory, ".opencode", "specops.json"),
            `${JSON.stringify({ integrations: { mcp: "inherit" } })}\n`,
            "utf8",
        )
        const inheritedHooks = await SpecOpsPluginWithManifest(fakePluginInput(projectDirectory))
        const inheritedConfig: Config = {}
        await inheritedHooks.config?.(inheritedConfig)
        expect(inheritedConfig.agent?.[worker]?.tools?.[MCP_TOOL_WILDCARD]).toBeUndefined()
    })

    it.each(["global", "project"] as const)(
        "rejects invalid %s MCP configuration before mutating host config",
        async source => {
            const temporaryRoot = await mkdtemp(
                path.join(os.tmpdir(), `specops-mcp-invalid-${source}-`),
            )
            const configHome = path.join(temporaryRoot, "config")
            const projectDirectory = path.join(temporaryRoot, "project")
            process.env.XDG_CONFIG_HOME = configHome
            await mkdir(path.join(configHome, "opencode"), { recursive: true })
            await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
            const configPath =
                source === "global"
                    ? path.join(configHome, "opencode", "specops.json")
                    : path.join(projectDirectory, ".opencode", "specops.json")
            await writeFile(
                configPath,
                `${JSON.stringify({ integrations: { mcp: "invalid" } })}\n`,
                "utf8",
            )

            const hooks = await SpecOpsPluginWithManifest(fakePluginInput(projectDirectory))
            const config: Config = {}
            await expect(hooks.config?.(config)).rejects.toThrow(configPath)
            expect(config).toEqual({})
        },
    )

    it("disables MCP tools for subagents without changing host MCP servers", async () => {
        const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "specops-mcp-disabled-"))
        process.env.XDG_CONFIG_HOME = path.join(projectDirectory, "config")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        await writeFile(
            path.join(projectDirectory, ".opencode", "specops.json"),
            `${JSON.stringify({ integrations: { mcp: "disabled" } })}\n`,
            "utf8",
        )

        const hooks = await SpecOpsPluginWithManifest(fakePluginInput(projectDirectory))
        const worker = ALL_AGENT_IDS.find(
            id => !CONTROLLER_AGENT_IDS.includes(id as (typeof CONTROLLER_AGENT_IDS)[number]),
        )!
        const hostMcp = {
            example: { type: "remote" as const, url: "https://mcp.example.test", enabled: true },
        }
        const config: Config = {
            mcp: hostMcp,
            agent: {
                [worker]: {
                    tools: { [MCP_TOOL_WILDCARD]: true, bash: true },
                },
            },
        }

        await hooks.config?.(config)

        for (const id of ALL_AGENT_IDS) {
            const tools = config.agent?.[id]?.tools
            if (CONTROLLER_AGENT_IDS.includes(id as (typeof CONTROLLER_AGENT_IDS)[number])) {
                expect(tools?.[MCP_TOOL_WILDCARD]).toBeUndefined()
            } else {
                expect(tools?.[MCP_TOOL_WILDCARD]).toBe(false)
            }
        }
        expect(config.agent?.[worker]?.tools?.bash).toBe(true)
        expect(config.mcp).toEqual(hostMcp)
    })

    it("preserves inherited MCP settings on externally registered subagents", async () => {
        const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "specops-mcp-inherit-"))
        process.env.XDG_CONFIG_HOME = path.join(projectDirectory, "config")
        const worker = ALL_AGENT_IDS.find(
            id => !CONTROLLER_AGENT_IDS.includes(id as (typeof CONTROLLER_AGENT_IDS)[number]),
        )!
        const hooks = await SpecOpsPluginWithManifest(fakePluginInput(projectDirectory))
        const config: Config = {
            agent: { [worker]: { tools: { [MCP_TOOL_WILDCARD]: true } } },
        }

        await hooks.config?.(config)

        expect(config.agent?.[worker]?.tools?.[MCP_TOOL_WILDCARD]).toBe(true)
    })

    it("keeps every public command connected to an agent or protocol tool", async () => {
        const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "specops-commands-"))
        process.env.XDG_CONFIG_HOME = path.join(temporaryHome, "config")
        const hooks = await SpecOpsPluginWithManifest(fakePluginInput())
        const config: Config = {}
        await hooks.config?.(config)

        for (const [name, command] of Object.entries(config.command ?? {})) {
            if (command.agent) {
                expect(config.agent?.[command.agent], `command ${name}`).toBeDefined()
                continue
            }
            expect(
                ALL_TOOL_IDS.some(toolID => command.template.includes(toolID)),
                `command ${name}`,
            ).toBe(true)
        }
    })
})

function fakePluginInput(directory = process.cwd()): PluginInput {
    return {
        directory,
        worktree: directory,
        project: {} as PluginInput["project"],
        client: {} as PluginInput["client"],
        serverUrl: new URL("http://127.0.0.1"),
        $: (() => undefined) as unknown as PluginInput["$"],
        experimental_workspace: { register() {} },
    }
}

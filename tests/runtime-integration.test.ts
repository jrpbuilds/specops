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
import { resolveManifestPath } from "../src/installation.js"
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

        const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")))
        expect(Object.keys(manifest.agents).sort()).toEqual([...ALL_AGENT_IDS].sort())
        expect(Object.keys(config.agent ?? {}).sort()).toEqual([...ALL_AGENT_IDS].sort())

        const interactive = config.agent?.[AGENT_IDS.controller.interactive]
        const automatic = config.agent?.[AGENT_IDS.controller.automatic]
        expect(interactive?.mode).toBe("primary")
        expect(automatic?.mode).toBe("primary")
        expect(interactive?.maxSteps).toBe(1_000)
        expect(automatic?.tools?.task).toBe(true)
        expect(interactive?.tools?.question).toBe(true)
        expect(automatic?.tools?.question).toBe(false)

        const controllerPermission: Record<string, string> = {
            bash: "deny",
            edit: "deny",
            read: "deny",
            glob: "deny",
            grep: "deny",
            todowrite: "deny",
        }
        for (const id of CONTROLLER_AGENT_IDS) {
            expect(config.agent?.[id]?.permission as Record<string, string>).toEqual(
                controllerPermission,
            )
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
                expect(config.agent?.[id]?.tools?.task).toBe(false)
                // Workers need read/glob/grep to inspect the repository.
                expect(
                    (config.agent?.[id]?.permission as Record<string, string> | undefined)?.read,
                ).not.toBe("deny")
            }
        }

        expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([...ALL_TOOL_IDS].sort())
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

function fakePluginInput(): PluginInput {
    const directory = process.cwd()
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

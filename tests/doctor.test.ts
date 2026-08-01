import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG, resolveConfig, resetConfigRepairs } from "../src/config.js"
import { doctor } from "../src/doctor.js"
import { DEFAULT_MANIFEST } from "../src/manifest.js"

describe("doctor config-source warning", () => {
    let temporaryDirectory: string

    beforeEach(async () => {
        temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "specops-doctor-"))
        vi.stubEnv("XDG_CONFIG_HOME", path.join(temporaryDirectory, "config"))
        const configDirectory = path.join(process.env.XDG_CONFIG_HOME!, "opencode")
        await mkdir(configDirectory, { recursive: true })
        await writeFile(
            path.join(configDirectory, "specops-manifest.json"),
            JSON.stringify(DEFAULT_MANIFEST, null, 2),
        )
    })

    afterEach(async () => {
        vi.unstubAllEnvs()
        await rm(temporaryDirectory, { recursive: true, force: true })
    })

    it("warns when project overrides global values", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        await writeFile(
            path.join(process.env.XDG_CONFIG_HOME!, "opencode", "specops.json"),
            JSON.stringify({ version: 2, workflow: { defaultTier: "standard" } }),
        )
        await writeFile(
            path.join(projectDirectory, ".opencode", "specops.json"),
            JSON.stringify({ version: 2, workflow: { defaultTier: "lean" } }),
        )
        const output = await doctor(projectDirectory, DEFAULT_CONFIG)
        expect(output).toMatch(/^WARN project configuration overrides global/m)
        expect(output).toContain("workflow.defaultTier")
    })

    it("does not warn when project matches global values", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        await writeFile(
            path.join(process.env.XDG_CONFIG_HOME!, "opencode", "specops.json"),
            JSON.stringify({ version: 2, workflow: { defaultTier: "standard" } }),
        )
        await writeFile(
            path.join(projectDirectory, ".opencode", "specops.json"),
            JSON.stringify({ version: 2, workflow: { defaultTier: "standard" } }),
        )
        const output = await doctor(projectDirectory, DEFAULT_CONFIG)
        expect(output).not.toMatch(/^WARN project configuration overrides global/m)
        expect(output).toContain("project configuration does not override global values")
    })

    it("does not list $schema as an overridden path", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        await writeFile(
            path.join(process.env.XDG_CONFIG_HOME!, "opencode", "specops.json"),
            JSON.stringify({ version: 2, workflow: { defaultTier: "standard" } }),
        )
        await writeFile(
            path.join(projectDirectory, ".opencode", "specops.json"),
            JSON.stringify({ version: 2, workflow: { defaultTier: "lean" }, $schema: "./x.json" }),
        )
        const output = await doctor(projectDirectory, DEFAULT_CONFIG)
        expect(output).toMatch(/^WARN project configuration overrides global/m)
        expect(output).toContain("workflow.defaultTier")
        expect(output).not.toContain("$schema")
    })

    it("does not list project-added keys as overrides", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        await writeFile(
            path.join(process.env.XDG_CONFIG_HOME!, "opencode", "specops.json"),
            JSON.stringify({ version: 2, workflow: { defaultTier: "standard" } }),
        )
        await writeFile(
            path.join(projectDirectory, ".opencode", "specops.json"),
            JSON.stringify({ version: 2, workflow: { defaultTier: "lean" } }),
        )
        const output = await doctor(projectDirectory, DEFAULT_CONFIG)
        expect(output).toMatch(/^WARN project configuration overrides global/m)
        expect(output).toContain("workflow.defaultTier")
    })

    it("does not warn when only global configuration exists", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        await writeFile(
            path.join(process.env.XDG_CONFIG_HOME!, "opencode", "specops.json"),
            JSON.stringify({ version: 2, workflow: { defaultTier: "standard" } }),
        )
        const output = await doctor(projectDirectory, DEFAULT_CONFIG)
        expect(output).not.toMatch(/^WARN project configuration overrides global/m)
    })

    it("reports the effective MCP subagent policy", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        const output = await doctor(projectDirectory, {
            ...DEFAULT_CONFIG,
            integrations: { mcp: "disabled" },
        })

        expect(output).toContain("MCP policy: disabled (configured MCP server tools denied for")
        expect(output).toContain("SpecOps subagents)")
    })

    it("reports the allow MCP policy by default", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        const output = await doctor(projectDirectory, DEFAULT_CONFIG)
        expect(output).toContain("MCP policy: allow")
    })

    it("reports FAIL diagnostic with file path for malformed JSON", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        const projectPath = path.join(projectDirectory, ".opencode", "specops.json")
        await writeFile(projectPath, "{ version: 2")
        const output = await doctor(projectDirectory, DEFAULT_CONFIG)
        expect(output).toContain("FAIL")
        expect(output).toContain(projectPath)
    })

    it("surfaces WARN diagnostics for files repaired at load time", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        const globalPath = path.join(process.env.XDG_CONFIG_HOME!, "opencode", "specops.json")
        // Valid `review` survives; bad `routing` is dropped; file is rewritten.
        await writeFile(
            globalPath,
            JSON.stringify({
                version: 2,
                review: { ...DEFAULT_CONFIG.review, transientRetries: 3 },
                routing: { forceFullForFacets: ["not-a-facet"] },
            }),
        )
        resetConfigRepairs()
        await resolveConfig(projectDirectory)
        const output = await doctor(projectDirectory, DEFAULT_CONFIG)
        expect(output).toMatch(/WARN configuration file .* was repaired at load time/)
        expect(output).toContain(globalPath)
        expect(output).toContain("review")
        expect(output).toContain("routing")
    })
})

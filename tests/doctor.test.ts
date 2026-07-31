import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "../src/config.js"
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
            JSON.stringify({ version: 2, workflow: { defaultTier: "lean", onboarding: "always" } }),
        )
        const output = await doctor(projectDirectory, DEFAULT_CONFIG)
        expect(output).toMatch(/^WARN project configuration overrides global/m)
        expect(output).toContain("workflow.defaultTier")
        expect(output).not.toContain("workflow.onboarding")
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

    it("reports FAIL diagnostic with file path for malformed JSON", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        const projectPath = path.join(projectDirectory, ".opencode", "specops.json")
        await writeFile(projectPath, "{ version: 2")
        const output = await doctor(projectDirectory, DEFAULT_CONFIG)
        expect(output).toContain("FAIL")
        expect(output).toContain(projectPath)
    })
})

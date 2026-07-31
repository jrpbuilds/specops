import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
    DEFAULT_CONFIG,
    deepMergeConfig,
    resolveConfig,
    validateConfig,
    validatePartialConfig,
} from "../src/config.js"

describe("example configuration", () => {
    it("matches the strict current configuration format", async () => {
        const examplePath = path.resolve(import.meta.dirname, "..", "examples", "specops.json")
        const example = JSON.parse(await readFile(examplePath, "utf8"))

        expect(validateConfig(example)).toMatchObject({
            version: 2,
            workflow: { defaultTier: example.workflow.defaultTier },
        })
    })
})

describe("validateConfig", () => {
    it("accepts the shipped default configuration", () => {
        expect(validateConfig(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG)
    })

    it("rejects unknown top-level keys", () => {
        expect(() =>
            validateConfig({ ...DEFAULT_CONFIG, extra: true } as unknown as typeof DEFAULT_CONFIG),
        ).toThrow("invalid SpecOps configuration field: root.extra")
    })
})

describe("validatePartialConfig", () => {
    it("allows an empty partial configuration", () => {
        expect(validatePartialConfig({})).toEqual({})
    })

    it("allows a minimal partial configuration", () => {
        expect(
            validatePartialConfig({
                version: 2,
                openspec: { command: ["node", "./tools/openspec.js"] },
            }),
        ).toEqual({
            version: 2,
            openspec: { command: ["node", "./tools/openspec.js"] },
        })
    })

    it("rejects unknown top-level keys", () => {
        expect(() => validatePartialConfig({ unknown: true })).toThrow(
            "invalid SpecOps configuration field: root.unknown",
        )
    })

    it("rejects unknown nested keys", () => {
        expect(() =>
            validatePartialConfig({
                workflow: { defaultTier: "auto", unknown: true },
            }),
        ).toThrow("invalid SpecOps configuration field: workflow.unknown")
    })

    it("rejects bad types in present fields", () => {
        expect(() =>
            validatePartialConfig({
                openspec: { command: "node" },
            }),
        ).toThrow("invalid SpecOps configuration field: openspec.command")
    })

    it("allows omitted required nested fields", () => {
        expect(
            validatePartialConfig({
                workflow: { defaultTier: "standard" },
            } as unknown as Record<string, unknown>),
        ).toEqual({
            workflow: { defaultTier: "standard" },
        })
    })

    it("includes the source path in error messages", () => {
        expect(() =>
            validatePartialConfig({ openspec: { command: "bad" } }, "/home/user/specops.json"),
        ).toThrow(
            "in /home/user/specops.json: invalid SpecOps configuration field: openspec.command",
        )
    })
})

describe("deepMergeConfig", () => {
    it("fills from defaults when no overrides are given", () => {
        expect(deepMergeConfig(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG)
    })

    it("overrides primitives", () => {
        const merged = deepMergeConfig(DEFAULT_CONFIG, {
            automation: { requireCleanWorktree: false },
        })
        expect(merged.automation.requireCleanWorktree).toBe(false)
        expect(merged.workflow.defaultTier).toBe(DEFAULT_CONFIG.workflow.defaultTier)
    })

    it("replaces arrays", () => {
        const merged = deepMergeConfig(DEFAULT_CONFIG, {
            routing: { forceFullForFacets: ["security"] },
        })
        expect(merged.routing.forceFullForFacets).toEqual(["security"])
    })

    it("recurses into plain objects", () => {
        const merged = deepMergeConfig(
            DEFAULT_CONFIG,
            {
                workflow: { defaultTier: "standard" },
            } as unknown as Record<string, unknown>,
            {
                workflow: { onboarding: "always" },
            } as unknown as Record<string, unknown>,
        )
        expect(merged.workflow.defaultTier).toBe("standard")
        expect(merged.workflow.onboarding).toBe("always")
        expect(merged.workflow.scopeThresholds).toEqual(DEFAULT_CONFIG.workflow.scopeThresholds)
    })

    it("applies explicit null", () => {
        const merged = deepMergeConfig(DEFAULT_CONFIG, {
            openspec: { command: null },
        })
        expect(merged.openspec.command).toBeNull()
    })
})

describe("resolveConfig", () => {
    let temporaryDirectory: string

    beforeEach(async () => {
        temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "specops-config-"))
        vi.stubEnv("XDG_CONFIG_HOME", path.join(temporaryDirectory, "config"))
        await mkdir(path.join(temporaryDirectory, "config", "opencode"), { recursive: true })
    })

    afterEach(async () => {
        vi.unstubAllEnvs()
        await rm(temporaryDirectory, { recursive: true, force: true })
    })

    it("returns defaults when no configuration files exist", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        await expect(resolveConfig(projectDirectory)).resolves.toEqual(DEFAULT_CONFIG)
    })

    it("merges global configuration", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        const configHome = process.env.XDG_CONFIG_HOME!
        await writeFile(
            path.join(configHome, "opencode", "specops.json"),
            JSON.stringify({ version: 2, openspec: { command: ["node", "./openspec.js"] } }),
        )
        const config = await resolveConfig(projectDirectory)
        expect(config.openspec.command).toEqual(["node", "./openspec.js"])
        expect(config.workflow.defaultTier).toBe(DEFAULT_CONFIG.workflow.defaultTier)
    })

    it("merges project configuration when global is absent", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        await writeFile(
            path.join(projectDirectory, ".opencode", "specops.json"),
            JSON.stringify({ version: 2, openspec: { command: ["node", "./openspec.js"] } }),
        )
        const config = await resolveConfig(projectDirectory)
        expect(config.openspec.command).toEqual(["node", "./openspec.js"])
        expect(config.workflow.defaultTier).toBe(DEFAULT_CONFIG.workflow.defaultTier)
    })

    it("merges project configuration over global", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        const configHome = process.env.XDG_CONFIG_HOME!
        await writeFile(
            path.join(configHome, "opencode", "specops.json"),
            JSON.stringify({
                version: 2,
                workflow: { defaultTier: "standard" },
                routing: { forceFullForFacets: ["security"] },
            }),
        )
        await writeFile(
            path.join(projectDirectory, ".opencode", "specops.json"),
            JSON.stringify({
                version: 2,
                workflow: { onboarding: "always" },
                automation: { requireCleanWorktree: false },
            }),
        )
        const config = await resolveConfig(projectDirectory)
        expect(config.workflow.defaultTier).toBe("standard")
        expect(config.workflow.onboarding).toBe("always")
        expect(config.routing.forceFullForFacets).toEqual(["security"])
        expect(config.automation.requireCleanWorktree).toBe(false)
    })

    it("reports the offending file path in validation errors", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        const globalPath = path.join(process.env.XDG_CONFIG_HOME!, "opencode", "specops.json")
        await writeFile(globalPath, JSON.stringify({ openspec: { command: "bad" } }))
        await expect(resolveConfig(projectDirectory)).rejects.toThrow(globalPath)
    })

    it("reports project file path in validation errors", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        const projectPath = path.join(projectDirectory, ".opencode", "specops.json")
        await writeFile(projectPath, JSON.stringify({ openspec: { command: "bad" } }))
        await expect(resolveConfig(projectDirectory)).rejects.toThrow(projectPath)
    })
})

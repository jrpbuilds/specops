import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
    DEFAULT_CONFIG,
    deepMergeConfig,
    materializeGlobalConfig,
    resolveConfig,
    resetConfigRepairs,
    validateConfig,
    validateConfigLenient,
    validatePartialConfig,
} from "../src/config.js"
import { resolveGlobalConfigPath } from "../src/installation.js"

describe("example configuration", () => {
    it.each(["specops.json", "specops.global.json"])(
        "%s matches the strict current configuration format",
        async filename => {
            const examplePath = path.resolve(import.meta.dirname, "..", "examples", filename)
            const example = JSON.parse(await readFile(examplePath, "utf8"))

            expect(validateConfig(example)).toEqual(DEFAULT_CONFIG)
        },
    )
})

describe("global configuration path", () => {
    it("uses XDG_CONFIG_HOME and falls back to the home config directory", () => {
        expect(
            resolveGlobalConfigPath({ XDG_CONFIG_HOME: "/custom/config" }, "/home/example"),
        ).toBe("/custom/config/opencode/specops.json")
        expect(resolveGlobalConfigPath({}, "/home/example")).toBe(
            "/home/example/.config/opencode/specops.json",
        )
    })
})

describe("validateConfig", () => {
    it("accepts the shipped default configuration", () => {
        expect(validateConfig(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG)
    })

    it("accepts the disabled MCP policy", () => {
        expect(
            validateConfig({ ...DEFAULT_CONFIG, integrations: { mcp: "disabled" } }),
        ).toMatchObject({ integrations: { mcp: "disabled" } })
    })

    it("accepts the allow MCP policy", () => {
        expect(validateConfig(DEFAULT_CONFIG)).toMatchObject({ integrations: { mcp: "allow" } })
    })

    it("rejects an unknown MCP policy", () => {
        expect(() =>
            validateConfig({
                ...DEFAULT_CONFIG,
                integrations: { mcp: "prompt" },
            } as unknown as typeof DEFAULT_CONFIG),
        ).toThrow("invalid SpecOps configuration field: integrations.mcp")
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
                openspec: { command: ["node", "./tools/openspec.js"], autoArchive: true },
            }),
        ).toEqual({
            version: 2,
            openspec: { command: ["node", "./tools/openspec.js"], autoArchive: true },
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
                openspec: { command: "node", autoArchive: true },
            }),
        ).toThrow("invalid SpecOps configuration field: openspec.command")
    })

    it("rejects a non-boolean openspec.autoArchive", () => {
        expect(() =>
            validatePartialConfig({
                openspec: { command: null, autoArchive: "yes" },
            }),
        ).toThrow("invalid SpecOps configuration field: openspec.autoArchive")
    })

    it("rejects a non-object openspec section", () => {
        expect(() => validatePartialConfig({ openspec: true })).toThrow(
            "invalid SpecOps configuration: openspec",
        )
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
            validatePartialConfig(
                { openspec: { command: "bad", autoArchive: true } },
                "/home/user/specops.json",
            ),
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
                workflow: { scopeThresholds: { leanMaxFiles: 3 } },
            } as unknown as Record<string, unknown>,
        )
        expect(merged.workflow.defaultTier).toBe("standard")
        expect(merged.workflow.scopeThresholds).toEqual({
            ...DEFAULT_CONFIG.workflow.scopeThresholds,
            leanMaxFiles: 3,
        })
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

    it("creates a complete valid global configuration and sibling schema when absent", async () => {
        const globalPath = resolveGlobalConfigPath()
        const schemaPath = path.join(path.dirname(globalPath), "specops.schema.json")
        const result = await materializeGlobalConfig()
        const document = JSON.parse(await readFile(globalPath, "utf8"))
        const writtenSchema = await readFile(schemaPath, "utf8")
        const packagedSchema = await readFile(
            path.resolve(import.meta.dirname, "..", "examples", "specops.schema.json"),
            "utf8",
        )

        expect(result).toEqual({ path: globalPath, created: true })
        expect(document.$schema).toBe("./specops.schema.json")
        expect(writtenSchema).toBe(packagedSchema)
        expect(validateConfig(document)).toEqual(DEFAULT_CONFIG)
        await expect(resolveConfig(path.join(temporaryDirectory, "project"))).resolves.toEqual(
            DEFAULT_CONFIG,
        )
    })

    it.each([
        ["valid partial", JSON.stringify({ workflow: { defaultTier: "standard" } })],
        ["malformed", "{ not-json"],
    ])("preserves an existing %s global configuration", async (_name, content) => {
        const globalPath = resolveGlobalConfigPath()
        await writeFile(globalPath, content)

        await expect(materializeGlobalConfig()).resolves.toEqual({
            path: globalPath,
            created: false,
        })
        await expect(readFile(globalPath, "utf8")).resolves.toBe(content)
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
                automation: { requireCleanWorktree: false },
            }),
        )
        const config = await resolveConfig(projectDirectory)
        expect(config.workflow.defaultTier).toBe("standard")
        expect(config.routing.forceFullForFacets).toEqual(["security"])
        expect(config.automation.requireCleanWorktree).toBe(false)
    })

    it("salvages valid sections and rewrites a bad global file in place", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        const globalPath = path.join(process.env.XDG_CONFIG_HOME!, "opencode", "specops.json")
        // Valid `review` section survives; bad `routing` section is dropped.
        await writeFile(
            globalPath,
            JSON.stringify({
                version: 2,
                review: { ...DEFAULT_CONFIG.review, transientRetries: 3 },
                routing: { forceFullForFacets: ["not-a-facet"] },
            }),
        )

        const config = await resolveConfig(projectDirectory)
        expect(config.review.transientRetries).toBe(3)
        expect(config.routing.forceFullForFacets).toEqual([])

        const rewritten = JSON.parse(await readFile(globalPath, "utf8"))
        expect(rewritten.$schema).toBe("./specops.schema.json")
        expect(rewritten.review.transientRetries).toBe(3)
        expect(rewritten.routing.forceFullForFacets).toEqual([])
        expect(validateConfig(rewritten)).toEqual({
            ...DEFAULT_CONFIG,
            review: { ...DEFAULT_CONFIG.review, transientRetries: 3 },
        })
    })

    it("salvages valid sections and rewrites a bad project file in place", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        const projectPath = path.join(projectDirectory, ".opencode", "specops.json")
        await writeFile(
            projectPath,
            JSON.stringify({
                version: 2,
                integrations: { mcp: "disabled" },
                workflow: { defaultTier: "not-a-tier" },
            }),
        )

        const config = await resolveConfig(projectDirectory)
        expect(config.integrations.mcp).toBe("disabled")
        expect(config.workflow.defaultTier).toBe(DEFAULT_CONFIG.workflow.defaultTier)

        const rewritten = JSON.parse(await readFile(projectPath, "utf8"))
        expect(rewritten.integrations.mcp).toBe("disabled")
        expect(rewritten.workflow.defaultTier).toBe(DEFAULT_CONFIG.workflow.defaultTier)
    })

    it("repairs a malformed-JSON file back to defaults", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        const globalPath = path.join(process.env.XDG_CONFIG_HOME!, "opencode", "specops.json")
        await writeFile(globalPath, "{ version: 2")

        const config = await resolveConfig(projectDirectory)
        expect(config).toEqual(DEFAULT_CONFIG)
        const rewritten = JSON.parse(await readFile(globalPath, "utf8"))
        expect(validateConfig(rewritten)).toEqual(DEFAULT_CONFIG)
    })

    it("drops unknown top-level keys and repairs the file", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        const projectPath = path.join(projectDirectory, ".opencode", "specops.json")
        await writeFile(
            projectPath,
            JSON.stringify({
                version: 2,
                automation: { requireCleanWorktree: false },
                bogusKey: true,
            }),
        )

        const config = await resolveConfig(projectDirectory)
        expect(config.automation.requireCleanWorktree).toBe(false)
        const rewritten = JSON.parse(await readFile(projectPath, "utf8"))
        expect(rewritten.automation.requireCleanWorktree).toBe(false)
        expect("bogusKey" in rewritten).toBe(false)
    })

    it("repairs both files when both are invalid and still loads defaults", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        const globalPath = path.join(process.env.XDG_CONFIG_HOME!, "opencode", "specops.json")
        const projectPath = path.join(projectDirectory, ".opencode", "specops.json")
        await writeFile(globalPath, "{ not-json")
        await writeFile(projectPath, "{ also not-json")

        const config = await resolveConfig(projectDirectory)
        expect(config).toEqual(DEFAULT_CONFIG)
        expect(validateConfig(JSON.parse(await readFile(globalPath, "utf8")))).toEqual(
            DEFAULT_CONFIG,
        )
        expect(validateConfig(JSON.parse(await readFile(projectPath, "utf8")))).toEqual(
            DEFAULT_CONFIG,
        )
    })

    it("leaves valid files untouched", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        const globalPath = path.join(process.env.XDG_CONFIG_HOME!, "opencode", "specops.json")
        const original = JSON.stringify(
            { version: 2, workflow: { defaultTier: "standard" } },
            null,
            2,
        )
        await writeFile(globalPath, `${original}\n`)

        await resolveConfig(projectDirectory)
        expect(await readFile(globalPath, "utf8")).toBe(`${original}\n`)
    })

    it("records repairs for doctor and clears them after consumption", async () => {
        const projectDirectory = path.join(temporaryDirectory, "project")
        await mkdir(path.join(projectDirectory, ".opencode"), { recursive: true })
        const globalPath = path.join(process.env.XDG_CONFIG_HOME!, "opencode", "specops.json")
        await writeFile(globalPath, "{ not-json")

        resetConfigRepairs()
        await resolveConfig(projectDirectory)
        // doctor consumes via consumeConfigRepairs through surfaceConfigRepairs;
        // import it to assert the recorded repairs are observable.
        const { consumeConfigRepairs } = await import("../src/config.js")
        const repairs = consumeConfigRepairs()
        expect(repairs).toHaveLength(1)
        expect(repairs[0].path).toBe(globalPath)
        expect(repairs[0].recoveredSections).toEqual([])
        expect(consumeConfigRepairs()).toEqual([])
    })
})

describe("validateConfigLenient", () => {
    it("returns empty partial for non-object input", () => {
        expect(validateConfigLenient(null)).toEqual({ partial: {}, recoveredSections: [] })
        expect(validateConfigLenient("string")).toEqual({ partial: {}, recoveredSections: [] })
    })

    it("drops a section whose strict parser rejects", () => {
        const { partial, recoveredSections } = validateConfigLenient({
            version: 2,
            review: { ...DEFAULT_CONFIG.review, transientRetries: 2 },
            routing: { forceFullForFacets: ["not-a-facet"] },
        })
        expect(recoveredSections).toEqual(["review"])
        expect(partial.review).toEqual({ ...DEFAULT_CONFIG.review, transientRetries: 2 })
        expect("routing" in partial).toBe(false)
    })

    it("ignores unknown top-level keys", () => {
        const { partial, recoveredSections } = validateConfigLenient({
            version: 2,
            automation: { requireCleanWorktree: false },
            bogusKey: true,
        })
        expect(recoveredSections).toEqual(["automation"])
        expect("bogusKey" in partial).toBe(false)
    })

    it("keeps a version field only when it equals 2", () => {
        expect(validateConfigLenient({ version: 2 }).partial).toEqual({ version: 2 })
        expect(validateConfigLenient({ version: 1 }).partial).toEqual({})
    })
})

import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { AGENT_IDS, ALL_AGENT_IDS } from "../src/capabilities/ids.js"
import { AGENT_REGISTRY } from "../src/capabilities/registry.js"
import {
    inspectAgentManifest,
    ManifestConflictError,
    materializeAgentManifest,
    saveAgentManifest,
} from "../src/installation.js"
import {
    agentSettingsCategory,
    configuredModels,
    createManifestDraft,
    selectConfiguredModel,
    validateManifestSelections,
} from "../src/model-settings.js"
import { DEFAULT_MANIFEST, manifestAgentConfig, validateManifest } from "../src/manifest.js"

describe("agent model manifest v2", () => {
    it("accepts only a complete model and optional variant catalogue", () => {
        const valid = structuredClone(DEFAULT_MANIFEST)
        const first = ALL_AGENT_IDS[0]
        valid.agents[first].variant = "high"
        expect(validateManifest(valid)).toEqual(valid)

        for (const invalid of [
            { ...valid, extra: true },
            { ...valid, version: 1 },
            {
                ...valid,
                agents: { ...valid.agents, [first]: { model: "x/y", steps: 10 } },
            },
            {
                ...valid,
                agents: {
                    ...valid.agents,
                    [first]: { model: "x/y", reasoningEffort: "high" },
                },
            },
            { ...valid, agents: { ...valid.agents, [first]: { model: "" } } },
            { ...valid, agents: { ...valid.agents, [first]: { model: "x/y", variant: "" } } },
            {
                ...valid,
                agents: Object.fromEntries(
                    Object.entries(valid.agents).filter(([id]) => id !== first),
                ),
            },
        ]) {
            expect(() => validateManifest(invalid)).toThrow()
        }
    })

    it("keeps workflow policy in the registry while applying model and variant", () => {
        const id = ALL_AGENT_IDS[0]
        const config = manifestAgentConfig(id, { model: "configured/model", variant: "high" })
        expect(config.model).toBe("configured/model")
        expect(config.variant).toBe("high")
        expect(config.maxSteps).toBe(AGENT_REGISTRY[id].steps)
        expect(config.prompt).toBeTruthy()
        expect(config.mode).toBe(AGENT_REGISTRY[id].mode)
    })

    it("preserves legacy bytes and uses packaged defaults for the session", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-v1-"))
        const destination = path.join(directory, "specops-manifest.json")
        const legacy = {
            version: 1,
            agents: Object.fromEntries(
                ALL_AGENT_IDS.map(id => [
                    id,
                    {
                        model: DEFAULT_MANIFEST.agents[id].model,
                        steps: 999,
                        reasoningEffort: "high",
                    },
                ]),
            ),
        }
        const bytes = `${JSON.stringify(legacy)}\n`
        await writeFile(destination, bytes)

        const result = await materializeAgentManifest(destination)
        expect(result.status).toBe("upgrade-required")
        expect(result.manifest).toEqual(DEFAULT_MANIFEST)
        expect(await readFile(destination, "utf8")).toBe(bytes)
        expect((await inspectAgentManifest(destination)).status).toBe("upgrade-required")
    })

    it("creates missing v2 defaults and replaces non-legacy invalid data", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-v2-"))
        const destination = path.join(directory, "specops-manifest.json")

        const created = await materializeAgentManifest(destination)
        expect(created.status).toBe("ready")
        expect(created.replacedInvalidFile).toBe(false)
        expect(validateManifest(JSON.parse(await readFile(destination, "utf8")))).toEqual(
            DEFAULT_MANIFEST,
        )

        await writeFile(destination, '{"version":2,"agents":{}}\n')
        const repaired = await materializeAgentManifest(destination)
        expect(repaired.status).toBe("ready")
        expect(repaired.replacedInvalidFile).toBe(true)
        expect(validateManifest(JSON.parse(await readFile(destination, "utf8")))).toEqual(
            DEFAULT_MANIFEST,
        )
    })

    it("atomically saves only the revision the editor inspected", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-save-"))
        const destination = path.join(directory, "specops-manifest.json")
        await materializeAgentManifest(destination)
        const inspection = await inspectAgentManifest(destination)
        if (inspection.status !== "ready") throw new Error("expected ready manifest")

        const updated = structuredClone(inspection.manifest)
        updated.agents[ALL_AGENT_IDS[0]].model = "configured/replacement"
        await saveAgentManifest(updated, inspection.contentHash, destination)
        expect(
            validateManifest(JSON.parse(await readFile(destination, "utf8"))).agents[
                ALL_AGENT_IDS[0]
            ].model,
        ).toBe("configured/replacement")

        await expect(
            saveAgentManifest(DEFAULT_MANIFEST, inspection.contentHash, destination),
        ).rejects.toBeInstanceOf(ManifestConflictError)
    })
})

describe("configured OpenCode model catalogue", () => {
    const models = configuredModels([
        {
            id: "provider",
            name: "Provider",
            models: {
                luna: {
                    id: "luna",
                    providerID: "provider",
                    name: "Luna",
                    variants: { low: {}, high: {} },
                },
                plain: {
                    id: "plain",
                    providerID: "provider",
                    name: "Plain",
                },
            },
        },
    ])

    it("flattens configured models and exposes provider variant IDs verbatim", () => {
        expect(models).toEqual([
            {
                id: "provider/luna",
                name: "Luna",
                providerID: "provider",
                providerName: "Provider",
                variants: ["high", "low"],
            },
            {
                id: "provider/plain",
                name: "Plain",
                providerID: "provider",
                providerName: "Provider",
                variants: [],
            },
        ])
    })

    it("groups mappings by functional agent family", () => {
        expect(agentSettingsCategory(AGENT_IDS.controller.automatic)).toBe("Controllers")
        expect(agentSettingsCategory(AGENT_IDS.core.planner)).toBe("Core workflow")
        expect(agentSettingsCategory(AGENT_IDS.core.repairer)).toBe("Review, judgment and repair")
        expect(agentSettingsCategory(AGENT_IDS.review.frontierLow)).toBe("Frontier escalation")
        expect(agentSettingsCategory(AGENT_IDS.specialist.security)).toBe("Specialists")
        expect(DEFAULT_MANIFEST.agents[AGENT_IDS.core.repairer].model).toBe(
            "opencode/north-mini-code-free",
        )
    })

    it("retains available legacy models, falls back, and marks unresolved agents", () => {
        const legacy = {
            version: 1 as const,
            agents: Object.fromEntries(
                ALL_AGENT_IDS.map(id => [id, { model: "provider/plain", steps: 20 }]),
            ),
        }
        const retained = createManifestDraft(legacy, models)
        expect(retained.unresolved).toEqual([])
        expect(
            ALL_AGENT_IDS.every(id => retained.manifest.agents[id].model === "provider/plain"),
        ).toBe(true)

        legacy.agents[ALL_AGENT_IDS[0]] = { model: "missing/model", steps: 20 }
        const unresolved = createManifestDraft(legacy, models)
        expect(unresolved.unresolved).toContain(ALL_AGENT_IDS[0])
        expect(validateManifestSelections(unresolved.manifest, models)).toContain(
            `${ALL_AGENT_IDS[0]}: model ${DEFAULT_MANIFEST.agents[ALL_AGENT_IDS[0]].model} is not currently configured`,
        )
    })

    it("preserves unavailable v2 selections so the user must resolve them", () => {
        const current = structuredClone(DEFAULT_MANIFEST)
        current.agents[ALL_AGENT_IDS[0]] = {
            model: "temporarily/unavailable",
            variant: "provider-specific",
        }

        const draft = createManifestDraft(current, models)
        expect(draft.manifest.agents[ALL_AGENT_IDS[0]]).toEqual({
            model: "temporarily/unavailable",
            variant: "provider-specific",
        })
        expect(draft.unresolved).toContain(ALL_AGENT_IDS[0])
        expect(validateManifestSelections(draft.manifest, models)[0]).toContain(
            "temporarily/unavailable",
        )
    })

    it("retains a variant on model change only when the new model supports it", () => {
        const high = { model: "old/model", variant: "high" }
        expect(selectConfiguredModel(high, models[0])).toEqual({
            model: "provider/luna",
            variant: "high",
        })
        expect(selectConfiguredModel(high, models[1])).toEqual({
            model: "provider/plain",
        })
    })

    it("rejects unavailable models and variants before save", () => {
        const manifest = structuredClone(DEFAULT_MANIFEST)
        for (const id of ALL_AGENT_IDS) manifest.agents[id] = { model: "provider/luna" }
        manifest.agents[ALL_AGENT_IDS[0]].variant = "unsupported"
        expect(validateManifestSelections(manifest, models)).toEqual([
            `${ALL_AGENT_IDS[0]}: variant unsupported is unavailable for provider/luna`,
        ])
    })
})

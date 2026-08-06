import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_IDS, ALL_AGENT_IDS } from "../src/agents/ids.js";
import { AGENT_REGISTRY } from "../src/agents/registry.js";
import {
    inspectAgentManifest,
    ManifestConflictError,
    materializeAgentManifest,
    saveAgentManifest,
} from "../src/installation.js";
import {
    agentSettingsCategory,
    clearConfiguredModel,
    configuredModels,
    createManifestDraft,
    selectConfiguredModel,
    validateManifestSelections,
} from "../src/model-settings.js";
import { DEFAULT_MANIFEST, manifestAgentConfig, validateManifest } from "../src/agents/manifest.js";

describe("agent model manifest v3", () => {
    it("accepts optional model and optional variant for every agent", () => {
        const valid = structuredClone(DEFAULT_MANIFEST);
        const first = ALL_AGENT_IDS[0];
        valid.agents[first].variant = "high";
        expect(validateManifest(valid)).toEqual(valid);

        // Empty model means "use OpenCode's configured global default".
        const blankModel = structuredClone(DEFAULT_MANIFEST);
        blankModel.agents[first] = {};
        expect(validateManifest(blankModel)).toEqual(blankModel);

        for (const invalid of [
            { ...valid, extra: true },
            { ...valid, version: 2 },
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
            { ...valid, agents: { ...valid.agents, [first]: { model: "x/y", variant: "" } } },
            {
                ...valid,
                agents: Object.fromEntries(
                    Object.entries(valid.agents).filter(([id]) => id !== first),
                ),
            },
        ]) {
            expect(() => validateManifest(invalid)).toThrow();
        }
    });

    it("keeps workflow policy in the registry while applying model and variant", () => {
        const id = ALL_AGENT_IDS[0];
        const config = manifestAgentConfig(id, { model: "configured/model", variant: "high" });
        expect(config.model).toBe("configured/model");
        expect(config.variant).toBe("high");
        expect(config.maxSteps).toBe(AGENT_REGISTRY[id].maxSteps);
        expect(config.prompt).toBeTruthy();
        expect(config.mode).toBe(AGENT_REGISTRY[id].mode);
    });

    it("omits the model field when manifest entry is blank so OpenCode uses its global default", () => {
        const id = ALL_AGENT_IDS[0];
        const config = manifestAgentConfig(id, { variant: "high" });
        expect("model" in config).toBe(false);
        // A dangling variant without a model has no meaning and must not be forwarded.
        expect("variant" in config).toBe(false);
    });

    it("replaces an unrecognised legacy manifest with current defaults", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-v1-"));
        const destination = path.join(directory, "specops-manifest.json");
        const legacy = {
            version: 1,
            agents: Object.fromEntries(
                ALL_AGENT_IDS.map(id => [
                    id,
                    {
                        model: "legacy/obsolete",
                        steps: 999,
                        reasoningEffort: "high",
                    },
                ]),
            ),
        };
        const bytes = `${JSON.stringify(legacy)}\n`;
        await writeFile(destination, bytes);

        const result = await materializeAgentManifest(destination);
        expect(result.status).toBe("ready");
        expect(result.manifest).toEqual(DEFAULT_MANIFEST);
        expect(result.replacedInvalidFile).toBe(true);
        // The legacy file is now overwritten with the current defaults.
        const rewritten = await readFile(destination, "utf8");
        expect(rewritten).not.toBe(bytes);
        const inspection = await inspectAgentManifest(destination);
        expect(inspection.status).toBe("ready");
    });

    it("creates missing v3 defaults and replaces non-legacy invalid data", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-v2-"));
        const destination = path.join(directory, "specops-manifest.json");

        const created = await materializeAgentManifest(destination);
        expect(created.status).toBe("ready");
        expect(created.replacedInvalidFile).toBe(false);
        expect(validateManifest(JSON.parse(await readFile(destination, "utf8")))).toEqual(
            DEFAULT_MANIFEST,
        );

        await writeFile(destination, '{"version":3,"agents":{}}\n');
        const repaired = await materializeAgentManifest(destination);
        expect(repaired.status).toBe("ready");
        expect(repaired.replacedInvalidFile).toBe(true);
        expect(validateManifest(JSON.parse(await readFile(destination, "utf8")))).toEqual(
            DEFAULT_MANIFEST,
        );
    });

    it("atomically saves only the revision the editor inspected", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-save-"));
        const destination = path.join(directory, "specops-manifest.json");
        await materializeAgentManifest(destination);
        const inspection = await inspectAgentManifest(destination);
        if (inspection.status !== "ready") throw new Error("expected ready manifest");

        const updated = structuredClone(inspection.manifest);
        updated.agents[ALL_AGENT_IDS[0]].model = "configured/replacement";
        await saveAgentManifest(updated, inspection.contentHash, destination);
        expect(
            validateManifest(JSON.parse(await readFile(destination, "utf8"))).agents[
                ALL_AGENT_IDS[0]
            ].model,
        ).toBe("configured/replacement");

        await expect(
            saveAgentManifest(DEFAULT_MANIFEST, inspection.contentHash, destination),
        ).rejects.toBeInstanceOf(ManifestConflictError);
    });
});

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
    ]);

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
        ]);
    });

    it("groups mappings by functional agent family", () => {
        expect(agentSettingsCategory(AGENT_IDS.coordinator)).toBe("Coordination");
        expect(agentSettingsCategory(AGENT_IDS.planner)).toBe("Planning");
        expect(agentSettingsCategory(AGENT_IDS.implementer)).toBe("Implementation");
        expect(agentSettingsCategory(AGENT_IDS.reviewer)).toBe("Review");
        expect(agentSettingsCategory(AGENT_IDS.frontier)).toBe("Frontier");
        // Packaged defaults are intentionally blank so the agent inherits OpenCode's global model.
        expect(DEFAULT_MANIFEST.agents[AGENT_IDS.implementer].model).toBeUndefined();
    });

    it("retains available models and flags unavailable ones as unresolved", () => {
        const current = structuredClone(DEFAULT_MANIFEST);
        for (const id of ALL_AGENT_IDS) {
            current.agents[id] = { model: "provider/plain" };
        }
        const retained = createManifestDraft(current, models);
        expect(retained.unresolved).toEqual([]);
        expect(
            ALL_AGENT_IDS.every(id => retained.manifest.agents[id].model === "provider/plain"),
        ).toBe(true);

        // Unavailable models are flagged unresolved so the user is prompted to fix them.
        current.agents[ALL_AGENT_IDS[0]!] = { model: "missing/model" };
        const fallback = createManifestDraft(current, models);
        expect(fallback.unresolved).toEqual([ALL_AGENT_IDS[0]]);
        expect(fallback.manifest.agents[ALL_AGENT_IDS[0]!]?.model).toBe("missing/model");
        expect(validateManifestSelections(fallback.manifest, models)).toEqual([
            `${ALL_AGENT_IDS[0]}: model missing/model is not currently configured`,
        ]);
    });

    it("produces a blank clean-install draft and clears models back to default", () => {
        const draft = createManifestDraft(DEFAULT_MANIFEST, models);
        expect(draft.unresolved).toEqual([]);
        expect(validateManifestSelections(draft.manifest, models)).toEqual([]);
        expect(ALL_AGENT_IDS.every(id => draft.manifest.agents[id].model === undefined)).toBe(true);

        const selectedSource = structuredClone(DEFAULT_MANIFEST);
        selectedSource.agents[ALL_AGENT_IDS[0]!] = { model: "provider/luna", variant: "high" };
        const selected = createManifestDraft(selectedSource, models);
        const cleared = clearConfiguredModel(selected.manifest.agents[ALL_AGENT_IDS[0]!]);
        expect(cleared.model).toBeUndefined();
        expect(cleared.variant).toBe("high");
    });

    it("preserves unavailable v3 selections so the user must resolve them", () => {
        const current = structuredClone(DEFAULT_MANIFEST);
        current.agents[ALL_AGENT_IDS[0]] = {
            model: "temporarily/unavailable",
            variant: "provider-specific",
        };

        const draft = createManifestDraft(current, models);
        expect(draft.manifest.agents[ALL_AGENT_IDS[0]]).toEqual({
            model: "temporarily/unavailable",
            variant: "provider-specific",
        });
        expect(draft.unresolved).toContain(ALL_AGENT_IDS[0]);
        expect(validateManifestSelections(draft.manifest, models)[0]).toContain(
            "temporarily/unavailable",
        );
    });

    it("retains a variant on model change only when the new model supports it", () => {
        const high = { model: "old/model", variant: "high" };
        expect(selectConfiguredModel(high, models[0])).toEqual({
            model: "provider/luna",
            variant: "high",
        });
        expect(selectConfiguredModel(high, models[1])).toEqual({
            model: "provider/plain",
        });
    });

    it("rejects unavailable models and variants before save", () => {
        const manifest = structuredClone(DEFAULT_MANIFEST);
        for (const id of ALL_AGENT_IDS) manifest.agents[id] = { model: "provider/luna" };
        manifest.agents[ALL_AGENT_IDS[0]].variant = "unsupported";
        expect(validateManifestSelections(manifest, models)).toEqual([
            `${ALL_AGENT_IDS[0]}: variant unsupported is unavailable for provider/luna`,
        ]);
    });

    it("accepts blank models as OpenCode's global default", () => {
        const manifest = structuredClone(DEFAULT_MANIFEST);
        // Blank entries should produce no issues, even if OpenCode exposes no models at all.
        expect(validateManifestSelections(manifest, [])).toEqual([]);
    });
});

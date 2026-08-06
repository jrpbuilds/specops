import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_IDS, ALL_AGENT_IDS } from "../src/agents/ids.js";
import { DEFAULT_MANIFEST, validateManifest } from "../src/agents/manifest.js";
import { materializeAgentManifest, migrateV2Manifest } from "../src/installation.js";

describe("V3 agent manifest", () => {
    it("uses exact seven-role defaults and rejects stale catalogues", () => {
        expect(DEFAULT_MANIFEST.version).toBe(3);
        expect(Object.keys(DEFAULT_MANIFEST.agents).sort()).toEqual([...ALL_AGENT_IDS].sort());
        expect(() =>
            validateManifest({ version: 3, agents: { ...DEFAULT_MANIFEST.agents, obsolete: {} } }),
        ).toThrow("catalogue");
    });

    it("migrates unambiguous V2 model selections and reports a frontier conflict", () => {
        const migration = migrateV2Manifest({
            version: 2,
            agents: {
                "specops-interactive-controller": { model: "provider/coordinator", steps: 20 },
                "specops-explorer": { model: "provider/explorer" },
                "specops-planner": { model: "provider/planner", variant: "high" },
                "specops-frontier-low": { model: "provider/frontier-low" },
                "specops-frontier-high": { model: "provider/frontier-high" },
            },
        });
        if (!migration) throw new Error("expected a V2 migration");
        expect(migration.manifest.agents[AGENT_IDS.coordinator]).toEqual({
            model: "provider/coordinator",
        });
        expect(migration.manifest.agents[AGENT_IDS.explorer]).toEqual({
            model: "provider/explorer",
        });
        expect(migration.manifest.agents[AGENT_IDS.planner]).toEqual({
            model: "provider/planner",
            variant: "high",
        });
        expect(migration.manifest.agents[AGENT_IDS.frontier]).toEqual({});
        expect(migration.warnings).toEqual([
            "specops-frontier: legacy mappings conflict; using the OpenCode default model",
        ]);
    });

    it("atomically materializes a V2 manifest as V3", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-manifest-v3-"));
        const destination = path.join(directory, "specops-manifest.json");
        await writeFile(
            destination,
            JSON.stringify({
                version: 2,
                agents: { "specops-interactive-controller": { model: "provider/coordinator" } },
            }),
        );

        const materialized = await materializeAgentManifest(destination);
        expect(materialized.migratedFromV2).toBe(true);
        expect(materialized.manifest.version).toBe(3);
        expect(materialized.manifest.agents[AGENT_IDS.coordinator]).toEqual({
            model: "provider/coordinator",
        });
        expect(validateManifest(JSON.parse(await readFile(destination, "utf8")))).toEqual(
            materialized.manifest,
        );
    });
});

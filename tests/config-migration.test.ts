import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateV1ConfigurationFile, validateV1Configuration } from "../src/installation.js";

const temporaryDirectories: string[] = [];

/** Tests one-time, destructive-only-to-obsolete V2 configuration migration. */
describe("V1 configuration migration", () => {
    it("preserves supported values, removes obsolete fields, and reports each removal", async () => {
        const directory = await temporaryDirectory();
        const configuration = path.join(directory, "specops.json");
        await writeFile(
            configuration,
            JSON.stringify({
                version: 2,
                openspec: { command: ["node", "openspec.js"], autoArchive: true },
                integrations: { mcp: "disabled" },
                workflow: { defaultTier: "full" },
                routing: { forceFullForFacets: ["security"] },
                automation: { requireCleanWorktree: true },
                escalation: { budgets: {} },
                frontier: { mode: "adaptive" },
                review: { blockingSeverities: ["HIGH"] },
            }),
        );

        const report = await migrateV1ConfigurationFile(configuration);
        const migrated = JSON.parse(await readFile(configuration, "utf8"));

        expect(report?.removedFields).toEqual([
            "automation",
            "escalation",
            "frontier",
            "openspec.autoArchive",
            "review",
            "routing",
            "workflow",
        ]);
        expect(migrated.openspec.command).toEqual(["node", "openspec.js"]);
        expect(migrated.integrations.mcp).toBe("disabled");
        expect(migrated).not.toHaveProperty("workflow");
        expect(validateV1Configuration(migrated)).toEqual(migrated);
    });

    it("does not repeat a completed migration and rejects invalid current configuration", async () => {
        const directory = await temporaryDirectory();
        const configuration = path.join(directory, "specops.json");
        await writeFile(configuration, JSON.stringify({ version: 1 }));

        await expect(migrateV1ConfigurationFile(configuration)).rejects.toThrow("invalid V1");
        await writeFile(
            configuration,
            JSON.stringify({
                version: 1,
                models: Object.fromEntries(
                    [
                        "specops-coordinator",
                        "specops-explorer",
                        "specops-planner",
                        "specops-designer",
                        "specops-implementer",
                        "specops-reviewer",
                        "specops-frontier",
                    ].map(id => [id, {}]),
                ),
                openspec: { command: null },
                validation: { commands: [] },
                integrations: { mcp: "allow" },
            }),
        );

        await expect(migrateV1ConfigurationFile(configuration)).resolves.toBeUndefined();
    });
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "specops-config-migration-"));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map(directory => rm(directory, { recursive: true, force: true })),
    );
});

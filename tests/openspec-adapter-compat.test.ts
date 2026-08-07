import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { OpenSpecAdapter } from "../src/openspec/adapter.js";
import { parseOpenSpecVersion } from "../src/openspec/version.js";
import { parseOpenSpecSchemas } from "../src/openspec/schema.js";
import { parseOpenSpecStatus } from "../src/openspec/status.js";
import { parseOpenSpecInstructions } from "../src/openspec/instructions.js";
import { parseOpenSpecValidation } from "../src/openspec/validation.js";
import { parseOpenSpecArchive } from "../src/openspec/archive.js";

/**
 * B-12 repair (task 12.4.4): drive the real `OpenSpecAdapter` TypeScript
 * class against the installed `@fission-ai/openspec@1.7.0` binary and assert
 * each parser accepts the real JSON output shape. The CLI compat gate in
 * `npm run test:openspec:compat` remains a secondary check; these tests own
 * adapter-level compatibility.
 *
 * Each test constructs an `OpenSpecAdapter` pointed at a throwaway git repo
 * initialized with the real OpenSpec CLI, then exercises one adapter method
 * and asserts the typed parser consumed the real output without error.
 */

const OPENSPEC_BIN = path.resolve(
    path.dirname(require.resolve("@fission-ai/openspec")),
    "..",
    "bin",
    "openspec.js",
);
const OPENSPEC_VERSION = "1.7.0";

/** Skip the suite when the dependency is unavailable instead of failing. */
const hasBinary = (() => {
    try {
        execFileSync("node", [OPENSPEC_BIN, "--version", "--no-color"], { encoding: "utf8" });
        return true;
    } catch {
        return false;
    }
})();

const itReal = hasBinary ? it : it.skip;

async function scratchRepo(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "specops-adapter-compat-"));
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    execFileSync("node", [OPENSPEC_BIN, "init", "--tools", "opencode", "--no-color"], {
        cwd: dir,
        stdio: "ignore",
    });
    execFileSync(
        "node",
        [
            OPENSPEC_BIN,
            "new",
            "change",
            "compat",
            "--schema",
            "spec-driven",
            "--goal",
            "compat",
            "--json",
            "--no-color",
        ],
        { cwd: dir, stdio: "ignore" },
    );
    return dir;
}

describe("OpenSpecAdapter compatibility against installed @fission-ai/openspec@1.7.0", () => {
    it("the installed dependency version satisfies the supported range", () => {
        const stdout = execFileSync("node", [OPENSPEC_BIN, "--version", "--no-color"], {
            encoding: "utf8",
        });
        expect(parseOpenSpecVersion(stdout)).toBe(OPENSPEC_VERSION);
    });

    itReal("version() returns the supported version through the adapter", async () => {
        const dir = await scratchRepo();
        try {
            const adapter = new OpenSpecAdapter({ directory: dir });
            expect(await adapter.version()).toBe(OPENSPEC_VERSION);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    itReal("schemas() parses the real schema list including spec-driven", async () => {
        const dir = await scratchRepo();
        try {
            const adapter = new OpenSpecAdapter({ directory: dir });
            const schemas = await adapter.schemas();
            expect(schemas.length).toBeGreaterThan(0);
            const specDriven = schemas.find(schema => schema.name === "spec-driven");
            expect(specDriven).toBeDefined();
            expect(specDriven?.artifacts).toContain("proposal");
            expect(specDriven?.artifacts).toContain("tasks");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    itReal("status() parses the real change status for a fresh change", async () => {
        const dir = await scratchRepo();
        try {
            const adapter = new OpenSpecAdapter({ directory: dir });
            const status = await adapter.status("compat");
            expect(status.changeName).toBe("compat");
            expect(status.schemaName).toBe("spec-driven");
            expect(status.isComplete).toBe(false);
            const ids = status.artifacts.map(artifact => artifact.id);
            expect(ids).toEqual(["proposal", "specs", "design", "tasks"]);
            expect(status.artifactPaths.proposal.resolvedOutputPath).toContain("proposal.md");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    itReal("assertStandardSchema() confirms spec-driven for the fresh change", async () => {
        const dir = await scratchRepo();
        try {
            const adapter = new OpenSpecAdapter({ directory: dir });
            expect(await adapter.assertStandardSchema("compat")).toBe("spec-driven");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    itReal("instructions() parses real proposal instructions", async () => {
        const dir = await scratchRepo();
        try {
            const adapter = new OpenSpecAdapter({ directory: dir });
            const instructions = await adapter.instructions("proposal", "compat");
            expect(instructions.artifactId).toBe("proposal");
            expect(instructions.schemaName).toBe("spec-driven");
            expect(instructions.outputPath).toBe("proposal.md");
            expect(instructions.resolvedOutputPath).toContain("proposal.md");
            expect(instructions.instruction.length).toBeGreaterThan(0);
            expect(Array.isArray(instructions.dependencies)).toBe(true);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    itReal(
        "validate() parses real invalid validation output for an incomplete change",
        async () => {
            const dir = await scratchRepo();
            try {
                const adapter = new OpenSpecAdapter({ directory: dir });
                const result = await adapter.validate("compat", true);
                // A fresh change with no artifacts is invalid; issues must be surfaced, not thrown.
                expect(result.valid).toBe(false);
                expect(Array.isArray(result.issues)).toBe(true);
                expect(result.issues.length).toBeGreaterThan(0);
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        },
    );

    itReal("archive() parses the real archive result for a force-archived change", async () => {
        const dir = await scratchRepo();
        try {
            const adapter = new OpenSpecAdapter({ directory: dir });
            const result = await adapter.archive("compat");
            expect(result.success).toBe(true);
            expect(result.code).toBe(0);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("each adapter parser accepts the real recorded output shapes", () => {
        // Guard the parser contract against shape drift without a live CLI.
        expect(parseOpenSpecVersion("1.7.0")).toBe(OPENSPEC_VERSION);
        expect(parseOpenSpecVersion("v1.7.0")).toBe(OPENSPEC_VERSION);

        const schemas = parseOpenSpecSchemas(
            JSON.stringify([
                {
                    name: "spec-driven",
                    description: "Default OpenSpec workflow",
                    artifacts: ["proposal", "specs", "design", "tasks"],
                    source: "package",
                },
            ]),
        );
        expect(schemas[0].artifacts).toEqual(["proposal", "specs", "design", "tasks"]);

        const status = parseOpenSpecStatus(
            JSON.stringify({
                changeName: "compat",
                schemaName: "spec-driven",
                changeRoot: "/p/openspec/changes/compat",
                isComplete: false,
                artifacts: [
                    { id: "proposal", outputPath: "proposal.md", status: "ready", requires: [] },
                ],
                artifactPaths: {
                    proposal: {
                        outputPath: "proposal.md",
                        resolvedOutputPath: "/p/openspec/changes/compat/proposal.md",
                        existingOutputPaths: [],
                    },
                },
            }),
        );
        expect(status.artifacts[0].status).toBe("ready");

        const instructions = parseOpenSpecInstructions(
            JSON.stringify({
                artifactId: "proposal",
                schemaName: "spec-driven",
                outputPath: "proposal.md",
                resolvedOutputPath: "/p/proposal.md",
                description: "desc",
                instruction: "instr",
                template: "",
                dependencies: [],
                unlocks: [],
                changeDir: "/p",
                changeName: "compat",
                planningHome: {},
                root: {},
                existingOutputPaths: [],
            }),
        );
        expect(instructions.instruction).toBe("instr");

        const validation = parseOpenSpecValidation(
            JSON.stringify({
                items: [
                    {
                        id: "compat",
                        type: "change",
                        valid: false,
                        issues: [{ message: "no deltas" }],
                    },
                ],
            }),
        );
        expect(validation.valid).toBe(false);
        expect(validation.issues).toHaveLength(1);

        const archive = parseOpenSpecArchive(
            JSON.stringify({ archive: { change: "compat" } }),
            "",
            0,
        );
        expect(archive.success).toBe(true);
    });
});

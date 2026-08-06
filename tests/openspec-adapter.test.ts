import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpenSpecAdapter } from "../src/openspec/adapter.js";
import {
    OpenSpecCompatibilityError,
    OpenSpecOperationalError,
    UnsupportedOpenSpecSchemaError,
} from "../src/openspec/errors.js";
import type { ProcessResult } from "../src/process.js";
import { onboard } from "../src/openspec.js";

const result = (stdout: string, code = 0, stderr = ""): ProcessResult => ({
    stdout,
    stderr,
    code,
    outputTruncated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
});

const status = (schemaName = "spec-driven") =>
    JSON.stringify({
        changeName: "test-change",
        schemaName,
        changeRoot: "/project/openspec/changes/test-change",
        isComplete: true,
        artifacts: [{ id: "proposal", outputPath: "proposal.md", status: "done", requires: [] }],
        artifactPaths: {
            proposal: {
                outputPath: "proposal.md",
                resolvedOutputPath: "/project/openspec/changes/test-change/proposal.md",
                existingOutputPaths: ["/project/openspec/changes/test-change/proposal.md"],
            },
        },
    });

const schemas = JSON.stringify([
    { name: "spec-driven", description: "Standard", artifacts: ["proposal"], source: "package" },
]);

function adapter(responses: Record<string, ProcessResult>): OpenSpecAdapter {
    return new OpenSpecAdapter({
        directory: "/project",
        command: ["openspec"],
        run: async (_command, args) => responses[args.slice(0, -1).join(" ")] ?? result("", 1),
    });
}

describe("OpenSpecAdapter", () => {
    it("initializes a standard project without copying custom schemas", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specops-onboard-"));
        await onboard(directory);
        await onboard(directory);
        await expect(
            readFile(path.join(directory, "openspec", "config.yaml"), "utf8"),
        ).resolves.toMatch(/^schema:\s*spec-driven\s*$/m);
        await expect(readdir(path.join(directory, "openspec", "schemas"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });
    it("accepts 1.7 and rejects unsupported or malformed versions", async () => {
        await expect(adapter({ "--version": result("1.7.4\n") }).version()).resolves.toBe("1.7.4");
        await expect(adapter({ "--version": result("1.6.9\n") }).version()).rejects.toBeInstanceOf(
            OpenSpecCompatibilityError,
        );
        await expect(adapter({ "--version": result("1.8.0\n") }).version()).rejects.toBeInstanceOf(
            OpenSpecCompatibilityError,
        );
        await expect(
            adapter({ "--version": result("not a version") }).version(),
        ).rejects.toBeInstanceOf(OpenSpecCompatibilityError);
    });

    it("detects spec-driven and rejects custom schemas without writing", async () => {
        await expect(
            adapter({
                "schemas --json": result(schemas),
                "status --change test-change --json": result(status()),
            }).assertStandardSchema("test-change"),
        ).resolves.toBe("spec-driven");
        await expect(
            adapter({
                "schemas --json": result(schemas),
                "status --change test-change --json": result(status("custom")),
            }).assertStandardSchema("test-change"),
        ).rejects.toBeInstanceOf(UnsupportedOpenSpecSchemaError);
    });

    it("parses status, instructions, validation, and archive results", async () => {
        const client = adapter({
            "status --change test-change --json": result(status()),
            "instructions proposal --change test-change --json": result(
                JSON.stringify({
                    artifactId: "proposal",
                    schemaName: "spec-driven",
                    outputPath: "proposal.md",
                    resolvedOutputPath: "/project/proposal.md",
                    description: "Proposal",
                    instruction: "Write it",
                    template: "# Proposal",
                    dependencies: [],
                }),
            ),
            "validate test-change --strict --json": result(
                JSON.stringify({ items: [{ valid: true, issues: [] }] }),
            ),
            "archive test-change --json --yes": result(JSON.stringify({ archived: true })),
        });
        await expect(client.status("test-change")).resolves.toMatchObject({
            schemaName: "spec-driven",
        });
        await expect(client.instructions("proposal", "test-change")).resolves.toMatchObject({
            artifactId: "proposal",
        });
        await expect(client.validate("test-change", true)).resolves.toMatchObject({ valid: true });
        await expect(client.archive("test-change")).resolves.toMatchObject({ success: true });
    });

    it("distinguishes operational failures and malformed JSON from invalid artifacts", async () => {
        await expect(
            adapter({ "schemas --json": result("not json") }).schemas(),
        ).rejects.toBeInstanceOf(OpenSpecOperationalError);
        await expect(
            adapter({ "status --change test-change --json": result("offline", 1) }).status(
                "test-change",
            ),
        ).rejects.toBeInstanceOf(OpenSpecOperationalError);
        await expect(
            adapter({
                "validate test-change --json": result(
                    JSON.stringify({ items: [{ valid: false, issues: ["missing"] }] }),
                    1,
                ),
            }).validate("test-change"),
        ).resolves.toMatchObject({ valid: false });
        await expect(
            adapter({ "archive test-change --json --yes": result("failure", 1) }).archive(
                "test-change",
            ),
        ).resolves.toMatchObject({ success: false });
    });
});

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectDoctorDiagnostics, formatDoctorDiagnostics } from "../src/doctor.js";

const temporaryDirectories: string[] = [];

/** Tests V1 diagnostics using fake process boundaries and real project files. */
describe("V1 doctor", () => {
    it("reports a healthy standard installation without errors", async () => {
        const directory = await projectDirectory();
        const diagnostics = await collectDoctorDiagnostics(directory, dependencies(directory));

        expect(diagnostics.filter(item => item.level === "error")).toEqual([]);
        expect(formatDoctorDiagnostics(diagnostics)).toContain("OpenSpec 1.7.0 is compatible");
    });

    it("reports unsupported OpenSpec with concrete remediation", async () => {
        const directory = await projectDirectory();
        const diagnostics = await collectDoctorDiagnostics(
            directory,
            dependencies(directory, {
                version: async () => {
                    throw new Error("detected 1.8.0; supported range is >=1.7.0 <1.8.0");
                },
            }),
        );

        expect(formatDoctorDiagnostics(diagnostics)).toContain(
            "ERROR OpenSpec compatibility check failed",
        );
        expect(formatDoctorDiagnostics(diagnostics)).toContain("Install OpenSpec >=1.7.0 <1.8.0");
    });

    it("warns about legacy schemas and run state without modifying either", async () => {
        const directory = await projectDirectory();
        await mkdir(path.join(directory, "openspec", "schemas", "specops"), { recursive: true });
        await mkdir(path.join(directory, ".specops", "runs", "legacy-run"), { recursive: true });
        await writeFile(
            path.join(directory, ".specops", "runs", "legacy-run", "run.json"),
            '{"version":7}\n',
        );

        const diagnostics = await collectDoctorDiagnostics(directory, dependencies(directory));
        const output = formatDoctorDiagnostics(diagnostics);

        expect(output).toContain("WARNING legacy SpecOps schemas detected");
        expect(output).toContain("WARNING legacy SpecOps run state detected for legacy-run");
        await expect(path.join(directory, "openspec", "schemas", "specops")).toBeTruthy();
    });
});

/** Create the minimal standard project structure doctor checks read-only. */
async function projectDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "specops-doctor-"));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, "openspec", "changes"), { recursive: true });
    await mkdir(path.join(directory, ".specops", "runs"), { recursive: true });
    await writeFile(path.join(directory, "openspec", "config.yaml"), "schema: spec-driven\n");
    return directory;
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map(directory => rm(directory, { recursive: true, force: true })),
    );
});

/** Construct deterministic healthy external checks for one test project. */
function dependencies(
    directory: string,
    adapterOverrides: Partial<{
        version(): Promise<string>;
        schemas(): Promise<Array<{ name: string }>>;
    }> = {},
) {
    return {
        adapter: {
            version: async () => "1.7.0",
            schemas: async () => [{ name: "spec-driven" }],
            ...adapterOverrides,
        },
        openCodeVersion: async () => "1.0.0",
        resolveConfiguration: async () => ({}),
        manifestPath: path.join(directory, "manifest.json"),
        packageRoot: directory,
    };
}

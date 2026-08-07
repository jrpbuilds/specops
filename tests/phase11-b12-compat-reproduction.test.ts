import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * B-12 reproduction (task 12.4.3): prove the `test:openspec:compat` npm
 * script only invokes the OpenSpec CLI and does not exercise the
 * `OpenSpecAdapter` TypeScript class against installed OpenSpec 1.7.0 JSON
 * behaviour. The repair in `tests/openspec-adapter-compat.test.ts` drives the
 * real adapter against the installed package; this test freezes the defect
 * so the CLI-only gate cannot be mistaken for adapter coverage.
 */
describe("B-12 reproduction — CLI-only openspec compat gate", () => {
    it("the test:openspec:compat script only invokes the OpenSpec CLI", async () => {
        const packageJson = JSON.parse(
            await readFile(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"),
        ) as { scripts: Record<string, string> };

        const script = packageJson.scripts["test:openspec:compat"];
        expect(script).toBeTruthy();

        // The defect: the script shells out to `npx @fission-ai/openspec`
        // (schemas / validate). It never imports or constructs the
        // OpenSpecAdapter TypeScript class.
        expect(script).toMatch(/npx .*@fission-ai\/openspec@1\.7\.0/);
        expect(script).not.toMatch(/OpenSpecAdapter/);

        // The secondary CLI gate is retained by the repair; the adapter
        // coverage lives in a dedicated test file.
        const adapterCompat = await readFile(
            path.resolve(import.meta.dirname, "openspec-adapter-compat.test.ts"),
            "utf8",
        );
        expect(adapterCompat).toContain("OpenSpecAdapter");
        expect(adapterCompat).toContain("1.7.0");
    });
});

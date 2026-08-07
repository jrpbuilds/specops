import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Verifies that package metadata exports no old orchestration-only surface. */
describe("V1 package surface", () => {
    it("does not ship the obsolete review fixer script", async () => {
        const packageJson = JSON.parse(
            await readFile(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"),
        ) as { scripts: Record<string, string>; exports: Record<string, unknown> };

        expect(packageJson.scripts).not.toHaveProperty("eval:review-fixer");
        expect(Object.keys(packageJson.exports).sort()).toEqual([".", "./tui"]);
    });
});

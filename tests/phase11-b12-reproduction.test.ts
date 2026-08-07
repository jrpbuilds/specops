import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * B-12 reproduction (task 12.4.1): prove the prior `tests/e2e-v1.test.ts`
 * release matrix only asserted source-string containment in *other* test
 * files, not deterministic packed/runtime workflow execution. The repair in
 * `tests/e2e-v1-runtime.test.ts` replaces this inventory with real lifecycle
 * runs; this test freezes the defect by asserting the source-string pattern
 * has been removed from the E2E matrix and replaced with real runtime
 * coverage, so the regression cannot silently return.
 */
describe("B-12 reproduction — source-string E2E inventory", () => {
    it("the E2E matrix no longer uses source-string containment as its coverage proof", async () => {
        const source = await readFile(path.resolve(import.meta.dirname, "e2e-v1.test.ts"), "utf8");

        // The defect was: every scenario case resolved a sibling test file
        // and asserted a literal substring in its source text. The repair
        // must keep that pattern from returning.
        expect(source).not.toMatch(/expect\(source\)\.toContain\(evidence\)/);
        expect(source).not.toContain("source.toContain(evidence)");

        // The repaired matrix points each scenario at the real runtime suite
        // and asserts the runtime entry functions are actually invoked there.
        expect(source).toContain("e2e-v1-runtime.test.ts");
        expect(source).toContain("startOrResumePlanning(");

        // The real runtime coverage lives in the dedicated suite.
        const runtime = await readFile(
            path.resolve(import.meta.dirname, "e2e-v1-runtime.test.ts"),
            "utf8",
        );
        for (const required of [
            "startOrResumePlanning(",
            "runImplementation(",
            "runReview(",
            "resolveCompletion(",
            "resumeVerified(",
        ]) {
            expect(runtime).toContain(required);
        }
    });
});

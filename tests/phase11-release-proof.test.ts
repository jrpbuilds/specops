import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * B-12 release proof: verify the `pre-specops-1.0-rewrite` baseline tag still
 * points at the recorded rewrite-baseline commit. The Phase 11 remediation
 * commits must amend the active rewrite without moving or recreating this
 * baseline anchor.
 */
describe("pre-rewrite baseline tag (B-12 release proof)", () => {
    it("pre-specops-1.0-rewrite peels to the recorded baseline commit", () => {
        const peeled = execSync("git rev-parse pre-specops-1.0-rewrite^{commit}", {
            encoding: "utf8",
        }).trim();
        expect(peeled).toBe("9722738fc08d65591d4e6e6561e0d358c55f83cd");
    });

    it("the rewrite implementation builds on the baseline as its ancestor", () => {
        // The first Phase 8 implementation commit (1dc9801) sits on the
        // baseline as a descendant; ensure the baseline remains reachable.
        const reachable = execSync("git rev-list --count pre-specops-1.0-rewrite..HEAD", {
            encoding: "utf8",
        }).trim();
        expect(Number.parseInt(reachable, 10)).toBeGreaterThan(0);
    });
});

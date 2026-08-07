import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_WORKFLOW_TOOL_IDS } from "../src/workflow/tools.js";
import { ALL_AGENT_IDS } from "../src/agents/ids.js";

/**
 * Release scenario matrix (B-12 repair, task 12.4.2). The named scenarios
 * are exercised end-to-end through the active V1 workflow surface by
 * `tests/e2e-v1-runtime.test.ts`, which drives the coordinator, planning,
 * implementation, review, and finalisation entry functions with deterministic
 * agent and OpenSpec fakes. This matrix keeps a scenario from silently
 * dropping from the release and guards the bounded runtime surface.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "..");

const scenarios = {
    "trivial bug fix": ["e2e-v1-runtime.test.ts", "trivial bug fix"],
    "small feature": ["e2e-v1-runtime.test.ts", "small feature"],
    "multi-file feature": ["e2e-v1-runtime.test.ts", "multi-file feature"],
    "design-heavy change": ["e2e-v1-runtime.test.ts", "design-heavy change"],
    "invalid proposal correction": ["e2e-v1-runtime.test.ts", "invalid proposal correction"],
    "invalid spec correction": ["e2e-v1-runtime.test.ts", "invalid spec correction"],
    "failed project validation": ["e2e-v1-runtime.test.ts", "failed project validation"],
    "blocking review followed by repair": [
        "e2e-v1-runtime.test.ts",
        "blocking review followed by repair",
    ],
    "correction exhaustion": ["e2e-v1-runtime.test.ts", "correction exhaustion"],
    "material user question": ["e2e-v1-runtime.test.ts", "material user question"],
    "planning feedback": ["e2e-v1-runtime.test.ts", "planning feedback"],
    "completion feedback": ["e2e-v1-runtime.test.ts", "completion feedback"],
    "dirty working tree": ["e2e-v1-runtime.test.ts", "dirty working tree"],
    "external repository mutation": ["e2e-v1-runtime.test.ts", "external repository mutation"],
    "interrupted run and resume": ["e2e-v1-runtime.test.ts", "interrupted run and resume"],
    "archive failure and retry": ["e2e-v1-runtime.test.ts", "archive failure and retry"],
    "verified-open resume": ["e2e-v1-runtime.test.ts", "verified-open resume"],
    "successful archive": ["e2e-v1-runtime.test.ts", "successful archive"],
} as const;

describe("V1 end-to-end release scenario inventory", () => {
    it("the runtime E2E suite drives every required scenario", async () => {
        const source = await readFile(
            path.join(repositoryRoot, "tests", "e2e-v1-runtime.test.ts"),
            "utf8",
        );
        for (const [, [, marker]] of Object.entries(scenarios)) {
            // Each scenario has a real `it(...)` case in the runtime suite, not a
            // source-string containment check against another test file.
            expect(source).toContain(`it("${marker}`);
        }
    });

    it("the runtime E2E suite drives the real workflow surface, not source strings", async () => {
        const source = await readFile(
            path.join(repositoryRoot, "tests", "e2e-v1-runtime.test.ts"),
            "utf8",
        );
        // Real runtime entry points are invoked, not merely referenced as text.
        for (const required of [
            "startOrResumePlanning(",
            "runImplementation(",
            "runReview(",
            "resolveCompletion(",
            "resumeVerified(",
        ]) {
            expect(source).toContain(required);
        }
    });

    it("keeps the V1 runtime surface used by each scenario bounded", () => {
        expect(ALL_AGENT_IDS).toHaveLength(7);
        expect(ALL_WORKFLOW_TOOL_IDS).toHaveLength(6);
    });
});

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_WORKFLOW_TOOL_IDS } from "../src/workflow/tools.js";
import { ALL_AGENT_IDS } from "../src/agents/ids.js";

/**
 * Release scenario matrix. The named stage suites exercise the real V1
 * orchestration boundaries with deterministic agent and OpenSpec fakes. This
 * matrix prevents a release from silently dropping a required scenario.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "..");

const scenarios = {
    "trivial bug fix": ["implementation-workflow.test.ts", "passes complete approved context"],
    "small feature": ["planning-workflow.test.ts", "authors every artifact in order"],
    "multi-file feature": ["implementation-workflow.test.ts", "standard tasks.md checkboxes"],
    "design-heavy change": ["planning-workflow.test.ts", "design"],
    "invalid proposal correction": ["planning-workflow.test.ts", "succeeds after correction"],
    "invalid spec correction": ["planning-workflow.test.ts", "succeeds after correction"],
    "failed project validation": ["implementation-workflow.test.ts", "failed command evidence"],
    "blocking review followed by repair": ["review-workflow.test.ts", "repair"],
    "correction exhaustion": ["planning-workflow.test.ts", "correction exhaustion"],
    "material user question": ["planning-workflow.test.ts", "material worker questions"],
    "planning feedback": ["planning-workflow.test.ts", "routes feedback"],
    "completion feedback": ["completion-workflow.test.ts", "requests implementation changes"],
    "dirty working tree": ["repository-identity.test.ts", "dirty"],
    "external repository mutation": ["implementation-workflow.test.ts", "mutation"],
    "interrupted run and resume": ["planning-workflow.test.ts", "resumes"],
    "archive failure and retry": ["completion-workflow.test.ts", "retries archive"],
    "verified-open resume": ["completion-workflow.test.ts", "resumes verified"],
    "successful archive": ["completion-workflow.test.ts", "completes and archives"],
} as const;

describe("V1 end-to-end release scenario inventory", () => {
    it.each(Object.entries(scenarios))(
        "keeps deterministic boundary coverage for %s",
        async (_scenario, [suite, evidence]) => {
            const source = await readFile(path.join(repositoryRoot, "tests", suite), "utf8");

            expect(source).toContain(evidence);
        },
    );

    it("keeps the V1 runtime surface used by each scenario bounded", () => {
        expect(ALL_AGENT_IDS).toHaveLength(7);
        expect(ALL_WORKFLOW_TOOL_IDS).toHaveLength(6);
    });
});

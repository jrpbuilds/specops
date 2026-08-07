import { describe, expect, it } from "vitest";
import { formatV1Status, type V1StatusSnapshot } from "../src/status.js";
import type { RunStage, RunStatus } from "../src/state/schema.js";

const identity = "a".repeat(64);
const statuses: RunStatus[] = [
    "active",
    "awaiting-user",
    "verified",
    "completed",
    "blocked",
    "failed",
    "cancelled",
];
const stages: RunStage[] = [
    "exploration",
    "proposal",
    "specs",
    "design",
    "tasks",
    "implementation",
    "validation",
    "review",
    "repair",
    "archive",
];

/** Tests that every persisted V1 state remains legible through status output. */
describe("V1 run status output", () => {
    it.each(statuses)("renders the %s run state", status => {
        const output = formatV1Status(snapshot({ status }));

        expect(output).toContain(`Status: ${status}`);
        expect(output).toContain("Goal: test status output");
        expect(output).toContain("OpenSpec artifacts: proposal: done");
    });

    it.each(stages)("renders the %s stage", stage => {
        expect(formatV1Status(snapshot({ stage }))).toContain(`Stage: ${stage}`);
    });

    it("includes all required evidence, checkpoint, and failure fields", () => {
        const output = formatV1Status(
            snapshot({
                status: "failed",
                stage: "archive",
                checkpoint: "archive retry available through /specops",
                reason: "OpenSpec archive failed",
                correctionAttempts: { proposal: 2 },
                validation: [{ commandId: "typecheck", result: "stale", timedOut: false }],
                review: { verdict: "pass", currentIdentity: identity },
                repairAttempts: 2,
            }),
        );

        expect(output).toContain("Correction attempts: proposal: 2");
        expect(output).toContain("Validation: typecheck: stale");
        expect(output).toContain("Review verdict: pass");
        expect(output).toContain("Repair attempts: 2");
        expect(output).toContain("Checkpoint: archive retry available through /specops");
        expect(output).toContain("Reason: OpenSpec archive failed");
    });
});

/** Build a complete bounded status model with deliberate test defaults. */
function snapshot(overrides: Partial<V1StatusSnapshot> = {}): V1StatusSnapshot {
    return {
        goal: "test status output",
        change: "status-change",
        status: "active",
        stage: "exploration",
        openSpec: {
            schemaName: "spec-driven",
            complete: false,
            artifacts: [{ id: "proposal", status: "done" }],
        },
        correctionAttempts: {},
        identities: { baseline: identity, current: identity, validated: null, reviewed: null },
        validation: [],
        review: { verdict: undefined, currentIdentity: undefined },
        repairAttempts: 0,
        checkpoint: "no user checkpoint pending",
        reason: null,
        ...overrides,
    };
}

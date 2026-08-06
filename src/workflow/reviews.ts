import { createHash } from "node:crypto";
import type {
    AssuranceFinding,
    DismissedReviewFinding,
    RepairMode,
    ReviewLedger,
    ReviewSubmission,
    RunState,
    SustainedReviewFinding,
} from "../types.js";
import { parseEvidenceRef } from "../worker_output.js";
import { JUDGMENT_VERDICTS, REPAIR_MODES, SEVERITIES } from "./contracts.js";

const FINDING_KEYS = new Set(["severity", "mode", "summary", "evidence", "acceptanceCriteria"]);
const LEDGER_FINDING_KEYS = new Set([...FINDING_KEYS, "sourceFindingIds"]);
const DISMISSED_KEYS = new Set(["sourceFindingIds", "reason"]);

/** Strict parsed judgment carrying the shared assurance-finding contract. */
export type Judgment = {
    verdict: "PASS" | "FAIL";
    summary: string;
    findings: AssuranceFinding[];
};

/** Parse a strict judgment; the engine handles empty-finding failures. */
export function parseJudgment(output: string): Judgment {
    const value = parseObject(output, "judgment");
    assertAllowedKeys(value, new Set(["verdict", "summary", "findings"]), "judgment");
    if (!JUDGMENT_VERDICTS.has(String(value.verdict))) {
        throw new Error(
            `judgment verdict must be "PASS" or "FAIL", got ${JSON.stringify(value.verdict)}`,
        );
    }
    if (typeof value.summary !== "string" || !value.summary.trim()) {
        throw new Error("judgment summary must be a non-empty string");
    }
    const findings = parseFindings(value.findings, "judgment");
    return { verdict: value.verdict as Judgment["verdict"], summary: value.summary, findings };
}

/** Parse the strict finding response returned by an independent reviewer. */
export function parseReviewSubmission(output: string): AssuranceFinding[] {
    const value = parseObject(output, "review submission");
    assertExactKeys(value, new Set(["findings"]), "review submission");
    return parseFindings(value.findings, "review submission");
}

/** Parse a Lean bundled ledger before controller-assigned source ids are available. */
export function parseLeanReviewLedger(output: string): AssuranceFinding[] {
    const value = parseObject(output, "review ledger");
    assertExactKeys(value, new Set(["findings"]), "review ledger");
    return parseFindings(value.findings, "review ledger");
}

/** Parse a refuter ledger and require complete, non-overlapping source coverage. */
export function parseReviewLedger(
    output: string,
    sourceFindingIds: readonly string[],
): ReviewLedger {
    const value = parseObject(output, "review ledger");
    assertExactKeys(value, new Set(["findings", "dismissed"]), "review ledger");
    if (!Array.isArray(value.findings) || !Array.isArray(value.dismissed)) {
        throw new Error("review ledger must include findings and dismissed arrays");
    }

    const findings: SustainedReviewFinding[] = value.findings.map(raw => {
        const item = parseRecord(raw, "review ledger finding");
        assertFindingKeys(item, LEDGER_FINDING_KEYS, "review ledger finding", true);
        const [finding] = parseFindings(
            [
                {
                    severity: item.severity,
                    mode: item.mode,
                    summary: item.summary,
                    evidence: item.evidence,
                    acceptanceCriteria: item.acceptanceCriteria,
                },
            ],
            "review ledger",
        );
        const sources = parseSourceIds(item.sourceFindingIds, "review ledger finding");
        return {
            ...finding,
            id: stableId("ledger", [...sources].sort(), finding.mode ?? "", finding.summary),
            sourceFindingIds: sources,
        };
    });

    const dismissed: DismissedReviewFinding[] = value.dismissed.map(raw => {
        const item = parseRecord(raw, "dismissed review finding");
        assertExactKeys(item, DISMISSED_KEYS, "dismissed review finding");
        if (typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 2_000) {
            throw new Error("dismissed review finding reason must be a bounded non-empty string");
        }
        return {
            sourceFindingIds: parseSourceIds(item.sourceFindingIds, "dismissed review finding"),
            reason: item.reason,
        };
    });

    const semanticFindings = findings.map(finding =>
        stableId(
            finding.severity,
            finding.mode ?? "",
            finding.summary.trim().toLowerCase(),
            finding.evidence,
            finding.acceptanceCriteria,
        ),
    );
    if (semanticFindings.length !== new Set(semanticFindings).size) {
        throw new Error("review ledger must deduplicate semantically identical findings");
    }

    const covered = [
        ...findings.flatMap(item => item.sourceFindingIds),
        ...dismissed.flatMap(item => item.sourceFindingIds),
    ];
    const expected = [...sourceFindingIds].sort();
    if (
        covered.length !== new Set(covered).size ||
        [...covered].sort().join("|") !== expected.join("|")
    ) {
        throw new Error("review ledger must cover every current source finding exactly once");
    }
    return { findings, dismissed };
}

/** Convert accepted findings into an immutable, dispatch-bound submission. */
export function createReviewSubmission(
    state: RunState,
    dispatch: RunState["dispatches"][number],
    findings: AssuranceFinding[],
): ReviewSubmission {
    return {
        id: stableId("submission", dispatch.id, dispatch.inputHash),
        dispatchId: dispatch.id,
        capability: dispatch.capability,
        inputHash: dispatch.inputHash,
        implementationDiffHash: state.implementationDiffHash,
        policyHash: state.requirements.policyHash,
        findings: findings.map((finding, index) => ({
            ...finding,
            id: stableId("source", dispatch.id, index, finding.summary),
        })),
        at: new Date().toISOString(),
    };
}

/** Build a final Lean ledger from its controller-normalized source submission. */
export function leanLedgerFromSubmission(submission: ReviewSubmission): ReviewLedger {
    return {
        findings: submission.findings.map(finding => ({
            ...finding,
            id: stableId("ledger", finding.id),
            sourceFindingIds: [finding.id],
        })),
        dismissed: [],
    };
}

/** Return submissions that were produced for the current implementation and policy. */
export function currentReviewSubmissions(state: RunState): ReviewSubmission[] {
    return state.reviewSubmissions.filter(
        submission =>
            submission.implementationDiffHash === state.implementationDiffHash &&
            submission.policyHash === state.requirements.policyHash &&
            state.dispatches.some(
                dispatch =>
                    dispatch.id === submission.dispatchId &&
                    dispatch.status === "completed" &&
                    dispatch.inputHash === submission.inputHash,
            ),
    );
}

/** Map a repair mode to its deterministic owning target. */
export function repairTargetForMode(mode: RepairMode): "planning" | "design" | "implementation" {
    if (mode === "spec-mismatch") return "planning";
    if (mode === "design-revision") return "design";
    return "implementation";
}

/** Return a stable SHA-256 id for controller-owned review records. */
export function stableId(...parts: unknown[]): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function parseFindings(value: unknown, label: string): AssuranceFinding[] {
    if (!Array.isArray(value)) throw new Error(`${label} findings must be an array`);
    if (value.length > 20) throw new Error(`${label} findings exceed the maximum of 20`);
    return value.map(raw => {
        const item = parseRecord(raw, `${label} finding`);
        assertFindingKeys(item, FINDING_KEYS, `${label} finding`, false);
        if (!SEVERITIES.has(String(item.severity))) {
            throw new Error(
                `${label} finding severity must be one of BLOCKER, HIGH, MEDIUM, LOW (uppercase)`,
            );
        }
        if (item.mode !== undefined && !REPAIR_MODES.has(String(item.mode))) {
            throw new Error(
                `${label} finding mode must be one of implementation-defect, spec-mismatch, test-deficiency, review-finding, design-revision`,
            );
        }
        if (
            typeof item.summary !== "string" ||
            !item.summary.trim() ||
            item.summary.length > 2_000
        ) {
            throw new Error(
                `${label} finding summary must be a non-empty string within 2000 characters`,
            );
        }
        if (!Array.isArray(item.evidence) || item.evidence.length > 20) {
            throw new Error(`${label} finding evidence must be a bounded array`);
        }
        if (
            !Array.isArray(item.acceptanceCriteria) ||
            item.acceptanceCriteria.length > 10 ||
            item.acceptanceCriteria.some(
                criterion =>
                    typeof criterion !== "string" || !criterion.trim() || criterion.length > 500,
            )
        ) {
            throw new Error(`${label} finding acceptanceCriteria must be a bounded string array`);
        }
        return {
            severity: item.severity as AssuranceFinding["severity"],
            mode: item.mode as RepairMode | undefined,
            summary: item.summary,
            evidence: item.evidence.map(parseEvidenceRef),
            acceptanceCriteria: item.acceptanceCriteria as string[],
        };
    });
}

function parseSourceIds(value: unknown, label: string): string[] {
    if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some(item => typeof item !== "string" || !item.trim()) ||
        value.length !== new Set(value).size
    ) {
        throw new Error(`${label} sourceFindingIds must be a non-empty unique string array`);
    }
    return value as string[];
}

function parseObject(output: string, label: string): Record<string, unknown> {
    let value: unknown;
    try {
        value = JSON.parse(output);
    } catch {
        throw new Error(`${label} must be valid JSON`);
    }
    return parseRecord(value, label);
}

function parseRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function assertExactKeys(
    value: Record<string, unknown>,
    expected: ReadonlySet<string>,
    label: string,
): void {
    if (
        Object.keys(value).length !== expected.size ||
        Object.keys(value).some(key => !expected.has(key))
    ) {
        throw new Error(`${label} contains unknown or missing fields`);
    }
}

function assertAllowedKeys(
    value: Record<string, unknown>,
    allowed: ReadonlySet<string>,
    label: string,
): void {
    if (Object.keys(value).some(key => !allowed.has(key))) {
        throw new Error(`${label} contains unknown fields`);
    }
}

function assertFindingKeys(
    value: Record<string, unknown>,
    allowed: ReadonlySet<string>,
    label: string,
    ledger: boolean,
): void {
    const required = [
        "severity",
        "summary",
        "evidence",
        "acceptanceCriteria",
        ...(ledger ? ["sourceFindingIds"] : []),
    ];
    if (
        Object.keys(value).some(key => !allowed.has(key)) ||
        required.some(key => !(key in value))
    ) {
        throw new Error(`${label} contains unknown or missing fields`);
    }
}

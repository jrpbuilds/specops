/**
 * Generated artifact wire-format contracts consumed by scheduler dispatch prompts.
 *
 * Retained legacy contract constants. They remain until the legacy scheduler
 * is deleted in Phase 9.
 */

/** Planning-bundle contract shared by full and standard tiers (proposal + specs). */
export const PLANNING_BUNDLE_CONTRACT =
    'Return a JSON object with top-level keys "proposal" and "specs"\n(and "tasks" when requested). Do not wrap the JSON in markdown fences.\n\n- "proposal": a markdown string following the proposal.md template\n  (sections: # Proposal, ## Why, ## Outcomes, ## Non-Goals, ## Capabilities, ### New Capabilities, ### Modified Capabilities, ## Impact, ## Rollback).\n- "specs": a JSON object (NOT an array) mapping spec directory names to spec markdown bodies.\n  Each key must match /^[a-z0-9][a-z0-9-]*$/ (lowercase alphanumeric and hyphens) and becomes specs/<name>/spec.md.\n  Each value must follow the spec.md template (## Purpose, ### Requirement: Example behavior, #### Scenario: Successful behavior, ## ADDED Requirements, ## MODIFIED Requirements, ## REMOVED Requirements).\n  Each value must contain at least one delta section (## ADDED Requirements, ## MODIFIED Requirements, ## REMOVED Requirements), at least one\n  "### Requirement:" block, and every requirement must have at least one "#### Scenario:"\n  with both "- **WHEN**" and "- **THEN**" clauses.\n- Specs are normative requirements, NOT a file-operation plan. Do not emit\n  "DELETE <path>" / "CREATE <path>" prose as spec content.';

/** Additional tasks-member contract appended for standard-tier planning bundles. */
export const STANDARD_BUNDLE_TASKS_CONTRACT =
    '- "tasks": a markdown string following the tasks.md template\n  (sections: # Tasks, ## 1. Tests and Foundations, ## 2. Implementation, ## 3. Verification).';

/** Shared evidence-backed finding response used by independent reviewers. */
export const ASSURANCE_FINDINGS_CONTRACT =
    'Return a JSON object {"findings": [{ "severity": string, "mode"?: string, "summary": string, "evidence": array, "acceptanceCriteria": string[] }]}.\nEach finding must have exactly this shape: { "severity": string, "mode"?: string, "summary": string, "evidence": array, "acceptanceCriteria": string[] }.\n- "severity": one of BLOCKER, HIGH, MEDIUM, LOW (uppercase).\n- "mode": optional; one of implementation-defect, spec-mismatch, test-deficiency, review-finding, design-revision.\n- "summary": a non-empty string.\n- "evidence": zero or more typed SpecOps evidence references.\n- "acceptanceCriteria": observable non-empty strings.\nDo not wrap the JSON in markdown fences.';

/** Independent-judgment contract (correctness and compliance). */
export const JUDGMENT_CONTRACT =
    'Return a JSON object with exactly these keys: {"verdict", "summary", "findings"}.\n- "verdict": PASS | FAIL.\n- "summary": a non-empty string.\n- "findings": an array (may be empty only for PASS).\nEach finding must have exactly this shape: { "severity": string, "mode"?: string, "summary": string, "evidence": array, "acceptanceCriteria": string[] }.\n- "severity": one of BLOCKER, HIGH, MEDIUM, LOW (uppercase).\n- "mode": optional; one of implementation-defect, spec-mismatch, test-deficiency, review-finding, design-revision.\n- "summary": a non-empty string.\n- "evidence": zero or more typed SpecOps evidence references.\n- "acceptanceCriteria": observable non-empty strings.\nDo not wrap the JSON in markdown fences.';

/** Refuter review-ledger contract with uppercase severity and mode enums. */
export const REVIEW_LEDGER_CONTRACT =
    'Return a JSON object with exactly "findings" and "dismissed" arrays.\nEach sustained finding is { "severity": string, "mode"?: string, "summary": string, "evidence": array, "acceptanceCriteria": string[], "sourceFindingIds": string[] }.\nEach finding must have exactly this shape: { "severity": string, "mode"?: string, "summary": string, "evidence": array, "acceptanceCriteria": string[] }.\n- "severity": one of BLOCKER, HIGH, MEDIUM, LOW (uppercase).\n- "mode": optional; one of implementation-defect, spec-mismatch, test-deficiency, review-finding, design-revision.\n- "summary": a non-empty string.\n- "evidence": zero or more typed SpecOps evidence references.\n- "acceptanceCriteria": observable non-empty strings.\nEach dismissed entry is { "sourceFindingIds": string[], "reason": string }.\nCover every supplied source finding exactly once across findings and dismissed.\nDeduplicate findings. Do not wrap the JSON in markdown fences.';

/**
 * Canonical constants and validators for SpecOps artifact wire-format contracts.
 *
 * This module is the single source of truth for enum value sets and content
 * validation patterns consumed by parsers, the generated prompt-contracts
 * module, and the generate-contracts script. It intentionally avoids importing
 * from config, engine, or frontier modules to keep the dependency tree acyclic
 * and let the generator import compiled dist output without circular refs.
 */

/**
 * Regex for valid planning-bundle spec names.
 *
 * Each name becomes a `specs/<name>/spec.md` directory, so it is restricted to
 * lowercase alphanumeric characters and hyphens.
 */
export const SPEC_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/

/** Valid review severity strings in uppercase, used by the refuter and config parser. */
export const SEVERITIES: ReadonlySet<string> = new Set(["BLOCKER", "HIGH", "MEDIUM", "LOW"])

/** Valid repair mode strings, used by frontier, review-ledger, and repair dispatch logic. */
export const REPAIR_MODES: ReadonlySet<string> = new Set([
    "implementation-defect",
    "spec-mismatch",
    "test-deficiency",
    "review-finding",
    "design-revision",
])

/** Valid judgment verdict strings. */
export const JUDGMENT_VERDICTS: ReadonlySet<string> = new Set(["PASS", "FAIL"])

/**
 * Accepted spec delta-section verbs (ADDED, MODIFIED, REMOVED).
 *
 * Each verb produces a `## <verb> Requirements` heading. This is the single
 * source of truth for both {@link SPEC_SECTION_RE} and the generated prompt
 * contract strings so the parser and the worker instructions cannot drift.
 */
const SPEC_DELTA_SECTIONS = ["ADDED", "MODIFIED", "REMOVED"] as const

/**
 * Fully-qualified delta-section heading strings derived from
 * {@link SPEC_DELTA_SECTIONS}. Consumed by the generate-contracts script.
 */
export const SPEC_DELTA_SECTION_HEADERS: readonly string[] = SPEC_DELTA_SECTIONS.map(
    section => `## ${section} Requirements`,
)

/**
 * Regex matching a normative spec delta-section heading.
 *
 * Derived from {@link SPEC_DELTA_SECTIONS} so accepted headings stay in sync
 * with the generated prompt contract. At least one of these sections must be
 * present in a valid spec.md body.
 */
const SPEC_SECTION_RE = new RegExp(`^## (${SPEC_DELTA_SECTIONS.join("|")}) Requirements$`, "m")

/** Regex matching a WHEN clause within a scenario body. */
const WHEN_RE = /^- \*\*WHEN\*\*/m

/** Regex matching a THEN clause within a scenario body. */
const THEN_RE = /^- \*\*THEN\*\*/m

/**
 * Validate that a spec content body follows the normative spec template.
 *
 * Checks:
 * - At least one delta section heading (`## ADDED/MODIFIED/REMOVED Requirements`).
 * - At least one `### Requirement:` heading.
 * - Every Requirement has at least one `#### Scenario:` heading.
 * - Every Scenario includes both a `- **WHEN**` and a `- **THEN**` clause.
 *
 * @param content - The spec markdown body.
 * @param specName - The spec name used in error messages.
 * @returns An error message, or `null` when the content is valid.
 */
export function validateSpecContent(content: string, specName: string): string | null {
    if (!SPEC_SECTION_RE.test(content)) {
        return `spec "${specName}" must contain a "## ADDED/MODIFIED/REMOVED Requirements" section`
    }

    const requirementBlocks = content.split(/^### Requirement:/m)
    if (requirementBlocks.length <= 1) {
        return `spec "${specName}" must contain at least one "### Requirement:" heading`
    }

    for (let i = 1; i < requirementBlocks.length; i++) {
        const block = requirementBlocks[i]
        const reqName = block.trim().split("\n")[0]?.trim() || "<unnamed>"

        const scenarioBlocks = block.split(/^#### Scenario:/m)
        if (scenarioBlocks.length <= 1) {
            return `spec "${specName}" requirement "${reqName}" must have at least one "#### Scenario:" heading`
        }

        for (let j = 1; j < scenarioBlocks.length; j++) {
            const scenario = scenarioBlocks[j]
            if (!WHEN_RE.test(scenario)) {
                return `spec "${specName}" scenario in requirement "${reqName}" is missing "- **WHEN**" clause`
            }
            if (!THEN_RE.test(scenario)) {
                return `spec "${specName}" scenario in requirement "${reqName}" is missing "- **THEN**" clause`
            }
        }
    }

    return null
}

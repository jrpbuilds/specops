/**
 * Generate src/workflow/contracts.generated.ts from the canonical workflow
 * contract constants and the bundled OpenSpec templates.
 *
 * The generated module exports self-contained contract strings consumed by
 * scheduler dispatch prompts. Keeping these strings generated (rather than
 * hand-written) guarantees that the prompts, parsers, and templates cannot
 * silently drift: the contract strings always reflect the current enum sets
 * and template structure.
 *
 * Usage:
 *   node scripts/generate-contracts.mjs            Write the generated file.
 *   node scripts/generate-contracts.mjs --check      Compare without writing;
 *     exits non-zero when the checked-in file has drifted.
 */
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { format } from "prettier"

import {
    JUDGMENT_VERDICTS,
    REPAIR_MODES,
    SEVERITIES,
    SPEC_DELTA_SECTION_HEADERS,
    SPEC_NAME_REGEX,
} from "../dist/workflow/contracts.js"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const checkOnly = process.argv.includes("--check")
const destination = path.join(repositoryRoot, "src", "workflow", "contracts.generated.ts")

/**
 * Extract markdown section headers from a template file.
 * @param {string} relative - Path relative to the repository root.
 * @returns {Promise<string[]>} Lines starting with `#`, trimmed, in order.
 */
async function headers(relative) {
    const text = await readFile(path.join(repositoryRoot, relative), "utf8")
    return text
        .split("\n")
        .filter(line => line.startsWith("#"))
        .map(line => line.trim())
}

/**
 * Read a JSON template and return its top-level keys for shape documentation.
 * @param {string} relative - Path relative to the repository root.
 * @returns {Promise<string[]>} Top-level JSON keys.
 */
async function jsonKeys(relative) {
    const text = await readFile(path.join(repositoryRoot, relative), "utf8")
    return Object.keys(JSON.parse(text))
}

const proposalHeaders = await headers("schemas/specops/templates/proposal.md")
const specHeaders = await headers("schemas/specops/templates/spec.md")
const tasksHeaders = await headers("schemas/specops/templates/tasks.md")
const judgmentKeys = await jsonKeys("schemas/specops/templates/judgment-correctness.json")

// Delta sections accepted by the spec validator, derived from the canonical
// SPEC_DELTA_SECTION_HEADERS so the parser and prompt contract cannot drift.
const specDeltaSections = SPEC_DELTA_SECTION_HEADERS.join(", ")
// Filter out the delta-section headers from the template's full header list so
// the contract only cites the non-delta template structure (e.g. ## Purpose).
const specNonDeltaHeaders = specHeaders.filter(h => !h.includes("Requirements")).join(", ")

const severitiesList = [...SEVERITIES].join(", ")
const repairModesList = [...REPAIR_MODES].join(", ")
const verdictsList = [...JUDGMENT_VERDICTS].join(" | ")

// Build the planning-bundle contract string shared by full and standard tiers.
const planningBundleContract = [
    `Return a JSON object with top-level keys "proposal" and "specs"`,
    `(and "tasks" when requested). Do not wrap the JSON in markdown fences.`,
    ``,
    `- "proposal": a markdown string following the proposal.md template`,
    `  (sections: ${proposalHeaders.join(", ")}).`,
    `- "specs": a JSON object (NOT an array) mapping spec directory names to spec markdown bodies.`,
    `  Each key must match ${SPEC_NAME_REGEX} (lowercase alphanumeric and hyphens) and becomes specs/<name>/spec.md.`,
    `  Each value must follow the spec.md template (${specNonDeltaHeaders ? specNonDeltaHeaders + ", " : ""}${specDeltaSections}).`,
    `  Each value must contain at least one delta section (${specDeltaSections}), at least one`,
    `  "### Requirement:" block, and every requirement must have at least one "#### Scenario:"`,
    `  with both "- **WHEN**" and "- **THEN**" clauses.`,
    `- Specs are normative requirements, NOT a file-operation plan. Do not emit`,
    `  "DELETE <path>" / "CREATE <path>" prose as spec content.`,
].join("\n")

// Standard-tier adds a tasks member following the tasks.md template.
const standardBundleTasksContract = [
    `- "tasks": a markdown string following the tasks.md template`,
    `  (sections: ${tasksHeaders.join(", ")}).`,
].join("\n")

const assuranceFindingShape =
    `{ "severity": string, "mode"?: string, "summary": string, ` +
    `"evidence": array, "acceptanceCriteria": string[] }`
const assuranceRules = [
    `Each finding must have exactly this shape: ${assuranceFindingShape}.`,
    `- "severity": one of ${severitiesList} (uppercase).`,
    `- "mode": optional; one of ${repairModesList}.`,
    `- "summary": a non-empty string.`,
    `- "evidence": zero or more typed SpecOps evidence references.`,
    `- "acceptanceCriteria": observable non-empty strings.`,
].join("\n")

const assuranceFindingsContract = [
    `Return a JSON object {"findings": [${assuranceFindingShape}]}.`,
    assuranceRules,
    `Do not wrap the JSON in markdown fences.`,
].join("\n")

// Judgment contract: the exact JSON shape from the bundled template.
const judgmentContract = [
    `Return a JSON object with exactly these keys: {${judgmentKeys.map(k => `"${k}"`).join(", ")}}.`,
    `- "verdict": ${verdictsList}.`,
    `- "summary": a non-empty string.`,
    `- "findings": an array (may be empty only for PASS).`,
    assuranceRules,
    `Do not wrap the JSON in markdown fences.`,
].join("\n")

// Review-ledger contract: sustained findings plus explicit dismissed-source coverage.
const reviewLedgerContract = [
    `Return a JSON object with exactly "findings" and "dismissed" arrays.`,
    `Each sustained finding is ${assuranceFindingShape.slice(0, -2)}, "sourceFindingIds": string[] }.`,
    assuranceRules,
    `Each dismissed entry is { "sourceFindingIds": string[], "reason": string }.`,
    `Cover every supplied source finding exactly once across findings and dismissed.`,
    `Deduplicate findings. Do not wrap the JSON in markdown fences.`,
].join("\n")

const generated = [
    `/**`,
    ` * Generated artifact wire-format contracts consumed by scheduler dispatch prompts.`,
    ` *`,
    ` * This file is generated by scripts/generate-contracts.mjs from the canonical`,
    ` * constants in src/workflow/contracts.ts and the bundled OpenSpec templates.`,
    ` * Do not hand-edit; run \`npm run generate\` after an intentional contract change.`,
    ` * \`npm run generated:check\` rejects drift.`,
    ` */`,
    ``,
    `/** Planning-bundle contract shared by full and standard tiers (proposal + specs). */`,
    `export const PLANNING_BUNDLE_CONTRACT = ${JSON.stringify(planningBundleContract)}`,
    ``,
    `/** Additional tasks-member contract appended for standard-tier planning bundles. */`,
    `export const STANDARD_BUNDLE_TASKS_CONTRACT = ${JSON.stringify(standardBundleTasksContract)}`,
    ``,
    `/** Shared evidence-backed finding response used by independent reviewers. */`,
    `export const ASSURANCE_FINDINGS_CONTRACT = ${JSON.stringify(assuranceFindingsContract)}`,
    ``,
    `/** Independent-judgment contract (correctness and compliance). */`,
    `export const JUDGMENT_CONTRACT = ${JSON.stringify(judgmentContract)}`,
    ``,
    `/** Refuter review-ledger contract with uppercase severity and mode enums. */`,
    `export const REVIEW_LEDGER_CONTRACT = ${JSON.stringify(reviewLedgerContract)}`,
    ``,
].join("\n")

// Match the project's .prettierrc.json so the generated output is identical to
// `prettier --write` on the checked-in file.
const formatted = await format(generated, {
    parser: "typescript",
    arrowParens: "avoid",
    printWidth: 100,
    semi: false,
    singleQuote: false,
    tabWidth: 4,
    useTabs: false,
    trailingComma: "all",
})

if (checkOnly) {
    const existing = await readFile(destination, "utf8")
    if (existing !== formatted) {
        throw new Error("src/workflow/contracts.generated.ts has drifted; run npm run generate")
    }
} else {
    await writeFile(destination, formatted)
}

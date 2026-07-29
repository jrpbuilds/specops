/**
 * Assessment parsing: validate and materialise the strict assessor output
 * that seeds a final run.
 */
import type { Assessment, ConfidenceLevel, RiskFacet, TouchedSurface } from "../types.js"

/** The complete set of valid {@link RiskFacet} values for validation. */
const FACETS = new Set<RiskFacet>([
    "security",
    "data",
    "public-contract",
    "concurrency",
    "resilience",
    "performance",
    "infrastructure",
    "migration",
    "usability",
    "maintainability",
])
/** The complete set of valid {@link TouchedSurface} values for validation. */
const SURFACES = new Set<TouchedSurface>([
    "api",
    "auth",
    "database",
    "filesystem",
    "network",
    "queue",
    "cli",
    "ui",
    "configuration",
    "build",
    "deployment",
])
/** The complete set of valid {@link ConfidenceLevel} values for validation. */
const CONFIDENCE = new Set<ConfidenceLevel>(["low", "medium", "high"])
/** The complete set of valid `changeKind` values for validation. */
const CHANGE_KINDS = new Set<Assessment["changeKind"]>([
    "documentation",
    "configuration",
    "test",
    "bugfix",
    "refactor",
    "feature",
    "migration",
    "infrastructure",
])

/**
 * Parse the strict assessor output that seeds a final run.
 *
 * Strips a fenced ```json code block if present, validates every required
 * field against its known enum or shape, and returns a fully materialised
 * {@link Assessment} with de-duplicated facet/surface arrays.
 *
 * @param output - Raw assessor prose possibly containing a fenced JSON payload.
 * @returns The validated assessment.
 * @throws {Error} If the output is not valid JSON or any field fails validation.
 */
export function parseAssessment(output: string): Assessment {
    let parsed: unknown
    try {
        parsed = JSON.parse(output.trim().replace(/^```json\s*|```$/g, ""))
    } catch {
        throw new Error("assessment did not return valid JSON")
    }

    const assessment = asObject(parsed, "assessment")
    const uncertainty = asObject(assessment.uncertainty, "assessment.uncertainty")
    if (!CHANGE_KINDS.has(assessment.changeKind as Assessment["changeKind"])) {
        throw new Error("invalid assessment.changeKind")
    }
    if (!isOneOf(assessment.publicContract, ["none", "compatible", "breaking"])) {
        throw new Error("invalid assessment.publicContract")
    }
    if (!isOneOf(assessment.suggestedTier, ["lean", "standard", "full"])) {
        throw new Error("invalid assessment.suggestedTier")
    }

    const riskFacets = stringArray(assessment.riskFacets, "riskFacets") as RiskFacet[]
    if (riskFacets.some(facet => !FACETS.has(facet))) {
        throw new Error("invalid assessment.riskFacets")
    }
    const touchedSurfaces = stringArray(
        assessment.touchedSurfaces,
        "touchedSurfaces",
    ) as TouchedSurface[]
    if (touchedSurfaces.some(surface => !SURFACES.has(surface))) {
        throw new Error("invalid assessment.touchedSurfaces")
    }

    for (const key of [
        "requirements",
        "repository",
        "design",
        "implementation",
        "verification",
    ] as const) {
        if (!CONFIDENCE.has(uncertainty[key] as ConfidenceLevel)) {
            throw new Error(`invalid assessment.uncertainty.${key}`)
        }
    }

    return {
        changeKind: assessment.changeKind as Assessment["changeKind"],
        expectedFiles: positiveInteger(assessment.expectedFiles, "expectedFiles"),
        expectedModules: positiveInteger(assessment.expectedModules, "expectedModules"),
        restoresExistingBehavior: boolean(
            assessment.restoresExistingBehavior,
            "restoresExistingBehavior",
        ),
        changesRequirements: boolean(assessment.changesRequirements, "changesRequirements"),
        publicContract: assessment.publicContract,
        riskFacets: [...new Set(riskFacets)],
        touchedSurfaces: [...new Set(touchedSurfaces)],
        uncertainty: uncertainty as Assessment["uncertainty"],
        suggestedTier: assessment.suggestedTier,
        inspectedPaths: stringArray(assessment.inspectedPaths, "inspectedPaths"),
        unresolvedQuestions: stringArray(assessment.unresolvedQuestions, "unresolvedQuestions"),
        likelyValidations: parseLikelyValidations(assessment.likelyValidations),
        facts: stringArray(assessment.facts, "facts"),
        inferences: stringArray(assessment.inferences, "inferences"),
    }
}

/**
 * Parse and validate the `likelyValidations` array from assessor output.
 *
 * Each entry must have a non-empty `executable` string, an array of string
 * `args`, and a non-empty `purpose`. An optional `cwd` must be a relative path
 * with no `..` segments to keep the workflow shell-free and sandbox-anchored.
 *
 * @param value - The raw value of `assessment.likelyValidations`.
 * @returns The validated list of likely validations.
 * @throws {Error} If the value is not an array or any entry is malformed.
 */
function parseLikelyValidations(value: unknown): Assessment["likelyValidations"] {
    if (!Array.isArray(value)) {
        throw new Error("invalid assessment.likelyValidations")
    }
    return value.map((entry, index) => {
        const validation = asObject(entry, `assessment.likelyValidations.${index}`)
        if (
            typeof validation.executable !== "string" ||
            !validation.executable ||
            !Array.isArray(validation.args) ||
            validation.args.some(argument => typeof argument !== "string") ||
            typeof validation.purpose !== "string" ||
            !validation.purpose
        ) {
            throw new Error(`invalid assessment.likelyValidations.${index}`)
        }
        if (
            validation.cwd !== undefined &&
            (typeof validation.cwd !== "string" ||
                validation.cwd.startsWith("/") ||
                validation.cwd.split(/[\\/]/).includes(".."))
        ) {
            throw new Error(`invalid assessment.likelyValidations.${index}.cwd`)
        }
        return {
            executable: validation.executable,
            args: validation.args as string[],
            cwd: validation.cwd as string | undefined,
            purpose: validation.purpose,
        }
    })
}

/**
 * Coerce an unknown value into a plain object record.
 *
 * @param value - The value to check.
 * @param name - Field name used in the thrown error for diagnostics.
 * @returns The value as a `Record<string, unknown>`.
 * @throws {Error} If the value is `null`, not an object, or an array.
 */
function asObject(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${name} must be an object`)
    }
    return value as Record<string, unknown>
}

/**
 * Validate that a value is a non-empty array of non-blank strings.
 *
 * @param value - The value to check.
 * @param field - Field name used in the thrown error for diagnostics.
 * @returns The value as a `string[]`.
 * @throws {Error} If the value is not an array or contains non-string/blank items.
 */
function stringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
        throw new Error(`invalid assessment.${field}`)
    }
    return value as string[]
}

/**
 * Validate that a value is a boolean.
 *
 * @param value - The value to check.
 * @param field - Field name used in the thrown error for diagnostics.
 * @returns The value as a `boolean`.
 * @throws {Error} If the value is not a boolean.
 */
function boolean(value: unknown, field: string): boolean {
    if (typeof value !== "boolean") {
        throw new Error(`invalid assessment.${field}`)
    }
    return value
}

/**
 * Validate that a value is a positive integer (>= 1).
 *
 * @param value - The value to check.
 * @param field - Field name used in the thrown error for diagnostics.
 * @returns The value as a `number`.
 * @throws {Error} If the value is not an integer or is less than 1.
 */
function positiveInteger(value: unknown, field: string): number {
    if (!Number.isInteger(value) || Number(value) < 1) {
        throw new Error(`invalid assessment.${field}`)
    }
    return Number(value)
}

/**
 * Type guard: is `value` one of the given string choices?
 *
 * @typeParam T - The string-literal union of valid choices.
 * @param value - The value to test.
 * @param choices - The allowed string literals.
 * @returns `true` when `value` is a string present in `choices`.
 */
function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
    return typeof value === "string" && choices.includes(value as T)
}

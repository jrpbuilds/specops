/** The required top-level sections of a reviewer-owned Markdown artifact. */
export const REVIEW_SECTIONS = [
    "Verdict",
    "Reviewed state",
    "Validation",
    "Blocking findings",
    "Non-blocking observations",
    "Conclusion",
] as const

/** A required top-level section name in a reviewer-owned Markdown artifact. */
export type ReviewSection = (typeof REVIEW_SECTIONS)[number]

/** The only verdict values accepted from the independent reviewer. */
export const REVIEW_VERDICTS = ["pass", "changes-required"] as const

/** A verdict that can advance the coarse review workflow. */
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

/** Return the canonical review artifact shape for reviewer prompts and tests. */
export function reviewTemplate(repositoryIdentity: string): string {
    return [
        "## Verdict",
        "pass",
        "",
        "## Reviewed state",
        `Repository identity: ${repositoryIdentity}`,
        "",
        "## Validation",
        "Describe the required validation evidence inspected.",
        "",
        "## Blocking findings",
        "None.",
        "",
        "## Non-blocking observations",
        "None.",
        "",
        "## Conclusion",
        "Summarize the independent review.",
        "",
    ].join("\n")
}

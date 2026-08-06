import {
    REVIEW_SECTIONS,
    REVIEW_VERDICTS,
    type ReviewSection,
    type ReviewVerdict,
} from "./format.js"

/** The small, deterministic subset of a reviewer-owned Markdown artifact. */
export type ParsedReview = {
    verdict: ReviewVerdict | undefined
    reviewedRepositoryState: string | undefined
    blockingFindingIds: string[]
    sections: readonly ReviewSection[]
}

/** Parse only workflow-gating fields from the fixed review Markdown format. */
export function parseReview(markdown: string): ParsedReview {
    const sections = presentSections(markdown)
    const verdictBody = sectionBody(markdown, "Verdict")
    const stateBody = sectionBody(markdown, "Reviewed state")
    const findingsBody = sectionBody(markdown, "Blocking findings")
    const verdict = parseVerdict(verdictBody)
    return {
        verdict,
        reviewedRepositoryState: stateBody?.match(/\b[a-f0-9]{64}\b/i)?.[0]?.toLowerCase(),
        blockingFindingIds: findingsBody ? parseBlockingFindingIds(findingsBody) : [],
        sections,
    }
}

/** Return the required sections present as exact level-two Markdown headings. */
function presentSections(markdown: string): ReviewSection[] {
    const headings = new Set(
        [...markdown.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map(match => match[1].trim()),
    )
    return REVIEW_SECTIONS.filter(section => headings.has(section))
}

/** Return a single level-two section body without interpreting its prose. */
function sectionBody(markdown: string, section: ReviewSection): string | undefined {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const heading = new RegExp(`^##[ \\t]+${escaped}[ \\t]*(?:\\r?\\n|$)`, "m")
    const match = heading.exec(markdown)
    if (!match) return undefined
    const remainder = markdown.slice(match.index + match[0].length)
    const nextHeading = remainder.search(/^##[ \t]+/m)
    return nextHeading === -1 ? remainder : remainder.slice(0, nextHeading)
}

/** Return a verdict only when the section contains exactly one supported token. */
function parseVerdict(body: string | undefined): ReviewVerdict | undefined {
    const token = body?.trim().replaceAll("`", "")
    return REVIEW_VERDICTS.includes(token as ReviewVerdict) ? (token as ReviewVerdict) : undefined
}

/** Extract only explicit stable IDs from Markdown list items in the blocking section. */
function parseBlockingFindingIds(body: string): string[] {
    return [
        ...body.matchAll(/^\s*-\s+(?:ID:\s*)?`?([A-Za-z][A-Za-z0-9._-]{0,127})`?\s*(?::|-)/gm),
    ].map(match => match[1])
}

/**
 * Unified worker-output parsing.
 *
 * Worker output is a single text blob that may contain two control markers:
 * `<!-- specops-escalation: ... -->` and `<!-- specops-question: ... -->`.
 * This module parses the output once, validates the markers, strips them from
 * the prose, and rejects combinations that are not allowed by policy.
 */
import { createHash } from "node:crypto"
import type { SpecOpsConfig } from "./config.js"
import type {
    ArtifactId,
    CapabilityId,
    EscalationClaim,
    QuestionImpact,
    WorkerQuestion,
    WorkerQuestionOption,
} from "./types.js"

/**
 * Result of parsing a worker output blob.
 *
 * `prose` is the original text with all control markers removed. Either or
 * both of `escalation` and `question` may be present when valid; malformed or
 * forbidden combinations throw during parse.
 */
export type ParsedWorkerOutput = {
    prose: string
    escalation?: EscalationClaim
    question?: WorkerQuestion
}

/** Marker metadata used during a single combined scan. */
type MarkerMatch = {
    kind: "escalation" | "question"
    start: number
    end: number
    payload: string
}

/** Allowed top-level keys in a question marker payload. */
const QUESTION_KEYS = new Set(["prompt", "options", "allowOther", "impact"])

/** Allowed top-level keys in an escalation marker payload (validated elsewhere). */
const ESCALATION_KEYS = new Set([
    "category",
    "confidence",
    "summary",
    "evidence",
    "boundaryCrossed",
    "whyCurrentRequirementsAreInsufficient",
    "requestedPatch",
])

/** Marker regexes. Each regex captures the inner JSON for one marker kind. */
const MARKER_RE = {
    escalation: /<!--\s*specops-escalation:\s*([\s\S]*?)\s*-->/gi,
    question: /<!--\s*specops-question:\s*([\s\S]*?)\s*-->/gi,
} as const

/**
 * Parse worker output once into structured control metadata and cleaned prose.
 *
 * Validation rules:
 * - At most one escalation marker and at most one question marker.
 * - A worker output must not contain both an escalation and a question marker.
 * - Marker JSON must parse and be an object.
 * - Question payload bounds: 2–5 options, non-empty prompt/id/label, configured
 *   max lengths, option IDs unique case-insensitively, `allowOther` boolean,
 *   `impact` one of the four allowed values, and no unknown fields.
 * - Markers that appear inside fenced code blocks or quoted blocks are ignored,
 *   preventing documentation examples from accidentally triggering control flow.
 * - Total marker payload size is bounded by `questions.maxMarkerBytes`.
 *
 * @param output - Raw worker output text.
 * @param config - Configuration carrying marker bounds.
 * @param phase - Artifact the worker was producing; used for impact validation.
 * @param capability - Capability that produced the output.
 * @returns Parsed and validated worker output.
 * @throws {Error} If markers are malformed, out-of-bounds, or forbidden.
 */
export function parseWorkerOutput(
    output: string,
    config: Pick<SpecOpsConfig, "questions">,
    phase: ArtifactId,
    capability: CapabilityId,
): ParsedWorkerOutput {
    // Normalise line endings before scanning.
    const normalised = output.replace(/\r\n/g, "\n")
    const markers = collectMarkers(normalised)
    const prose = stripMarkers(normalised, markers)

    const escalationMarkers = markers.filter(m => m.kind === "escalation")
    const questionMarkers = markers.filter(m => m.kind === "question")

    if (escalationMarkers.length > 1) {
        throw new Error("SpecOps worker output contains multiple escalation markers")
    }
    if (questionMarkers.length > 1) {
        throw new Error("SpecOps worker output contains multiple question markers")
    }
    if (escalationMarkers.length && questionMarkers.length) {
        throw new Error(
            "SpecOps worker output contains both an escalation and a question marker; choose one",
        )
    }

    const markerPayloadSize = markers.reduce((sum, m) => sum + Buffer.byteLength(m.payload), 0)
    if (markerPayloadSize > config.questions.maxMarkerBytes) {
        throw new Error("SpecOps worker control marker exceeds maximum size")
    }

    const escalation = escalationMarkers[0]
        ? parseEscalationPayload(escalationMarkers[0].payload)
        : undefined
    const question = questionMarkers[0]
        ? parseQuestionPayload(questionMarkers[0].payload, config.questions, phase, capability)
        : undefined

    return { prose: prose.trim(), escalation, question }
}

/**
 * Compute a stable hash for binding a question to authoritative inputs.
 *
 * The binding hash intentionally excludes incidental run-state mutations such
 * as `pendingQuestion`, timestamps, or pause status. It binds the question to
 * the requirement policy hash, relevant artifact hashes, prior answer hashes,
 * the originating dispatch input hash, and the implementation diff hash when
 * relevant.
 *
 * @param inputs - Authoritative inputs to bind.
 * @returns A lowercase hex SHA-256 digest.
 */
export function questionBindingHash(inputs: {
    policyHash: string
    artifactHashes: Record<string, string>
    answerHashes: Record<string, string>
    dispatchInputHash: string
    implementationDiffHash?: string
}): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                policyHash: inputs.policyHash,
                artifactHashes: sortRecord(inputs.artifactHashes),
                answerHashes: sortRecord(inputs.answerHashes),
                dispatchInputHash: inputs.dispatchInputHash,
                implementationDiffHash: inputs.implementationDiffHash ?? "",
            }),
        )
        .digest("hex")
}

/**
 * Collect all control markers from the output, ignoring markers that appear
 * inside fenced code blocks or quoted paragraphs.
 *
 * @param output - Raw worker output.
 * @returns Array of validated marker matches with positions.
 */
function collectMarkers(output: string): MarkerMatch[] {
    const markers: MarkerMatch[] = []
    for (const [kind, regex] of Object.entries(MARKER_RE) as Array<
        ["escalation" | "question", RegExp]
    >) {
        let match: RegExpExecArray | null
        // Reset regex because we may scan twice conceptually, but we only call once per kind.
        regex.lastIndex = 0
        while ((match = regex.exec(output)) !== null) {
            if (insidePassiveBlock(output, match.index, match[0].length)) {
                continue
            }
            if (isInlineMarker(output, match.index, match.index + match[0].length)) {
                throw new Error(
                    `SpecOps ${kind} marker must appear alone on its own line, ` +
                        "not mixed with other content",
                )
            }
            markers.push({
                kind,
                start: match.index,
                end: match.index + match[0].length,
                payload: match[1],
            })
        }
    }
    return markers.sort((a, b) => a.start - b.start)
}

/**
 * Determine whether a span sits inside a fenced code block or quoted block.
 *
 * A simple line-by-line scan is sufficient because worker output is bounded
 * and control markers must be intentionally placed outside passive content.
 *
 * @param output - Full worker output.
 * @param start - Start index of the marker.
 * @param length - Length of the marker.
 * @returns `true` when the marker is inside a code fence or blockquote.
 */
function insidePassiveBlock(output: string, start: number, length: number): boolean {
    const before = output.slice(0, start)
    const lines = before.split("\n")
    let inCodeFence = false
    let inQuoteBlock = false
    for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
            inCodeFence = !inCodeFence
        }
        if (!inCodeFence && trimmed.startsWith(">")) {
            inQuoteBlock = true
        } else if (!inCodeFence && trimmed && !trimmed.startsWith(">")) {
            inQuoteBlock = false
        }
    }
    if (inCodeFence) {
        return true
    }
    if (inQuoteBlock) {
        // Check that the marker's own lines are also quote-prefixed.
        const markerLines = output.slice(start, start + length).split("\n")
        return markerLines.every(line => line.trim().startsWith(">") || line.trim() === "")
    }
    return false
}

/**
 * Determine whether a marker is inline with other text on its line.
 *
 * A valid control marker must be the only non-whitespace content on its
 * line. Inline markers (e.g. inside explanatory prose) are rejected to
 * prevent accidental control flow from quoted examples.
 *
 * @param output - Full worker output.
 * @param start - Start index of the marker.
 * @param end - End index of the marker.
 * @returns `true` when the marker is mixed with other text on the same line.
 */
function isInlineMarker(output: string, start: number, end: number): boolean {
    const lineStart = output.lastIndexOf("\n", start) + 1
    const lineEnd = output.indexOf("\n", end)
    const effectiveLineEnd = lineEnd === -1 ? output.length : lineEnd
    const before = output.slice(lineStart, start).trim()
    const after = output.slice(end, effectiveLineEnd).trim()
    return before.length > 0 || after.length > 0
}

/**
 * Return the output text with all control markers removed.
 *
 * Collapses any whitespace hole left by a marker to a single newline so the
 * prose remains readable.
 *
 * @param output - Raw worker output.
 * @param markers - Markers to strip.
 * @returns Cleaned prose.
 */
function stripMarkers(output: string, markers: MarkerMatch[]): string {
    let result = output
    for (let index = markers.length - 1; index >= 0; index--) {
        const marker = markers[index]
        result = result.slice(0, marker.start) + "\n" + result.slice(marker.end)
    }
    return result.replace(/\n{3,}/g, "\n\n")
}

/**
 * Parse and lightly validate an escalation payload.
 *
 * Full structural validation is performed by the existing escalation policy.
 * This function only ensures the payload is valid JSON, an object, and uses
 * only the known top-level keys.
 *
 * @param payload - Inner JSON text of the escalation marker.
 * @returns The parsed escalation claim.
 * @throws {Error} If JSON is invalid or contains unknown fields.
 */
function parseEscalationPayload(payload: string): EscalationClaim {
    const value = parseObject(payload, "escalation claim")
    assertKeys(value, ESCALATION_KEYS, "escalation claim")
    return value as EscalationClaim
}

/**
 * Parse and strictly validate a question marker payload.
 *
 * Enforces option count, field bounds, uniqueness, unknown-field rejection,
 * and impact validity for the originating phase/capability.
 *
 * @param payload - Inner JSON text of the question marker.
 * @param limits - Question configuration limits.
 * @param phase - Artifact the worker was producing.
 * @param capability - Capability that produced the output.
 * @returns The parsed and validated worker question.
 * @throws {Error} If any validation rule is violated.
 */
function parseQuestionPayload(
    payload: string,
    limits: SpecOpsConfig["questions"],
    phase: ArtifactId,
    capability: CapabilityId,
): WorkerQuestion {
    const value = parseObject(payload, "question marker")
    assertKeys(value, QUESTION_KEYS, "question marker")

    if (typeof value.prompt !== "string" || !value.prompt.trim()) {
        throw new Error("SpecOps question marker must have a non-empty prompt")
    }
    if (value.prompt.length > limits.maxPromptLength) {
        throw new Error("SpecOps question prompt exceeds maximum length")
    }

    if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 5) {
        throw new Error("SpecOps question marker must contain 2 to 5 options")
    }

    const options: WorkerQuestionOption[] = []
    const seenIds = new Set<string>()
    for (const option of value.options) {
        if (!option || typeof option !== "object" || Array.isArray(option)) {
            throw new Error("SpecOps question option must be an object")
        }
        const parsed = option as Record<string, unknown>
        for (const key of Object.keys(parsed)) {
            if (key !== "id" && key !== "label") {
                throw new Error(`SpecOps question option contains unknown field: ${key}`)
            }
        }
        if (typeof parsed.id !== "string" || !parsed.id.trim()) {
            throw new Error("SpecOps question option id must be a non-empty string")
        }
        if (parsed.id.length > limits.maxOptionIdLength) {
            throw new Error("SpecOps question option id exceeds maximum length")
        }
        if (typeof parsed.label !== "string" || !parsed.label.trim()) {
            throw new Error("SpecOps question option label must be a non-empty string")
        }
        if (parsed.label.length > limits.maxOptionLabelLength) {
            throw new Error("SpecOps question option label exceeds maximum length")
        }
        const normalId = parsed.id.trim().toLowerCase()
        if (seenIds.has(normalId)) {
            throw new Error("SpecOps question option ids must be unique")
        }
        seenIds.add(normalId)
        options.push({ id: parsed.id, label: parsed.label })
    }

    let allowOther: boolean | undefined
    if (value.allowOther !== undefined) {
        if (typeof value.allowOther !== "boolean") {
            throw new Error("SpecOps question allowOther must be a boolean")
        }
        allowOther = value.allowOther
    }

    let impact: QuestionImpact | undefined
    if (value.impact !== undefined) {
        if (!isValidImpact(String(value.impact))) {
            throw new Error(
                "SpecOps question impact must be requirements, design, implementation, or validation",
            )
        }
        impact = String(value.impact) as QuestionImpact
        if (!isImpactAllowed(impact, phase, capability)) {
            throw new Error(
                `SpecOps question impact '${impact}' is not valid for phase '${phase}' / capability '${capability}'`,
            )
        }
    }

    return { prompt: value.prompt, options, allowOther, impact }
}

/**
 * Parse a JSON object from a string.
 *
 * @param payload - The raw JSON text.
 * @param label - Human-readable label for error messages.
 * @returns The parsed object.
 * @throws {Error} If parsing fails or the value is not an object.
 */
function parseObject(payload: string, label: string): Record<string, unknown> {
    let value: unknown
    try {
        value = JSON.parse(payload)
    } catch {
        throw new Error(`SpecOps ${label} is not valid JSON`)
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`SpecOps ${label} must be a JSON object`)
    }
    return value as Record<string, unknown>
}

/**
 * Reject unknown keys on a parsed object.
 *
 * @param value - Parsed object.
 * @param allowed - Allowed key names.
 * @param label - Human-readable label for error messages.
 * @throws {Error} If any unknown key is present.
 */
function assertKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new Error(`SpecOps ${label} contains unknown field: ${key}`)
        }
    }
}

/**
 * Return whether a string is a valid {@link QuestionImpact} value.
 *
 * @param value - Value to test.
 * @returns `true` when the value is a known impact.
 */
function isValidImpact(value: string): value is QuestionImpact {
    return (
        value === "requirements" ||
        value === "design" ||
        value === "implementation" ||
        value === "validation"
    )
}

/**
 * Return whether an impact is valid for the originating phase/capability.
 *
 * The worker may only suggest impacts that the originating dispatch can
 * plausibly affect. This prevents, for example, an exploration dispatch from
 * claiming an implementation impact.
 *
 * @param impact - Resolved impact.
 * @param phase - Artifact the worker was producing.
 * @param capability - Capability that produced the output.
 * @returns `true` when the impact is allowed for the phase/capability.
 */
function isImpactAllowed(
    impact: QuestionImpact,
    phase: ArtifactId,
    _capability: CapabilityId,
): boolean {
    switch (phase) {
        case "exploration":
        case "routing":
            return impact === "requirements"
        case "proposal":
        case "specs":
            return impact === "requirements" || impact === "design"
        case "design":
            return impact === "design" || impact === "requirements"
        case "tasks":
            return impact === "design" || impact === "implementation" || impact === "requirements"
        case "implementation":
            return impact === "implementation" || impact === "validation"
        case "verification":
            return impact === "validation" || impact === "implementation"
        case "correctness-judgment":
        case "compliance-judgment":
        case "review-ledger":
            return impact === "validation" || impact === "implementation"
        default:
            return impact === "requirements"
    }
}

/**
 * Sort a record's entries by key for stable hashing.
 *
 * @param record - Record to sort.
 * @returns A new record with entries sorted by key.
 */
function sortRecord(record: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

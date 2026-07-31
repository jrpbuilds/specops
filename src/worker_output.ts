/**
 * Unified worker-output parsing.
 *
 * Worker output is a single text blob that may contain three control markers:
 * `<!-- specops-escalation: ... -->`, `<!-- specops-question: ... -->`, and
 * `<!-- specops-frontier: ... -->`.
 * This module parses the output once, validates the markers, strips them from
 * the prose, and rejects combinations that are not allowed by policy.
 */
import { createHash } from "node:crypto"
import type { SpecOpsConfig } from "./config.js"
import type {
    ArtifactId,
    CapabilityId,
    EscalationClaim,
    EvidenceRef,
    FrontierRequest,
    QuestionImpact,
    WorkerQuestion,
    WorkerQuestionOption,
} from "./types.js"

/**
 * Result of parsing a worker output blob.
 *
 * `prose` is the original text with all control markers removed. Either or
 * both of `escalation` and `questions` may be present when valid; malformed or
 * forbidden combinations throw during parse.
 */
export type ParsedWorkerOutput = {
    prose: string
    escalation?: EscalationClaim
    /** One or more parsed worker questions (absent when no question markers). */
    questions?: WorkerQuestion[]
    frontier?: FrontierRequest
}

/** Marker metadata used during a single combined scan. */
type MarkerMatch = {
    kind: "escalation" | "question" | "frontier"
    start: number
    end: number
    payload: string
}

/** Allowed top-level keys in a question marker payload. */
const QUESTION_KEYS = new Set(["prompt", "options", "allowOther", "impact"])

/** Allowed top-level keys in a strictly validated escalation marker payload. */
const ESCALATION_KEYS = new Set([
    "category",
    "confidence",
    "summary",
    "evidence",
    "boundaryCrossed",
    "whyCurrentRequirementsAreInsufficient",
    "requestedPatch",
])

/** Allowed fields in the additive patch carried by an escalation marker. */
const ESCALATION_PATCH_KEYS = new Set([
    "raiseScopeTier",
    "addCapabilities",
    "addReviewFacets",
    "addValidations",
    "invalidate",
])

/** Closed escalation taxonomies used to reject invented controller inputs. */
const ESCALATION_CATEGORIES = new Set([
    "scope-overflow",
    "requirements-changed",
    "architecture-discovery",
    "risk-discovery",
    "validation-gap",
    "verification-uncertainty",
    "blocked",
])
const CONFIDENCE_LEVELS = new Set(["low", "medium", "high"])
const SCOPE_TIERS = new Set(["lean", "standard", "full"])
const RISK_FACETS = new Set([
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
const CAPABILITIES = new Set([
    "assessment",
    "exploration",
    "planning",
    "design",
    "implementation",
    "verification",
    "repair",
    "general-risk",
    ...RISK_FACETS,
    "correctness-judgment",
    "compliance-judgment",
    "refutation",
    "frontier",
])
const ARTIFACTS = new Set([
    "routing",
    "exploration",
    "proposal",
    "specs",
    "design",
    "tasks",
    "implementation",
    "verification",
    "correctness-judgment",
    "compliance-judgment",
    "review-ledger",
    "receipt",
])

/** Allowed top-level keys in a frontier escalation marker. */
const FRONTIER_KEYS = new Set([
    "tier",
    "task",
    "whyNormalPathIsInsufficient",
    "impact",
    "evidence",
    "attempts",
])

/** Marker regexes. Each regex captures the inner JSON for one marker kind. */
const MARKER_RE = {
    escalation: /<!--\s*specops-escalation:\s*([\s\S]*?)\s*-->/gi,
    question: /<!--\s*specops-question:\s*([\s\S]*?)\s*-->/gi,
    frontier: /<!--\s*specops-frontier:\s*([\s\S]*?)\s*-->/gi,
} as const

/**
 * Parse worker output once into structured control metadata and cleaned prose.
 *
 * Validation rules:
 * - At most one escalation marker and at most one frontier marker.
 * - Up to `questions.maxQuestionsPerMarker` question markers may be present;
 *   each is parsed and validated independently.
 * - A worker output must not contain both an escalation and a question marker.
 * - Marker JSON must parse and be an object.
 * - Question payload bounds: 2–5 options, non-empty prompt/id/label, configured
 *   max lengths, option IDs unique case-insensitively, `allowOther` boolean,
 *   `impact` one of the four allowed values, at most one option with
 *   `recommended: true`, and no unknown fields.
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
    const frontierMarkers = markers.filter(m => m.kind === "frontier")

    if (escalationMarkers.length > 1) {
        throw new Error("SpecOps worker output contains multiple escalation markers")
    }
    if (questionMarkers.length > config.questions.maxQuestionsPerMarker) {
        throw new Error(
            `SpecOps worker output contains more than ${config.questions.maxQuestionsPerMarker} question markers`,
        )
    }
    if (frontierMarkers.length > 1) {
        throw new Error("SpecOps worker output contains multiple frontier markers")
    }
    if (escalationMarkers.length && questionMarkers.length && !frontierMarkers.length) {
        throw new Error(
            "SpecOps worker output contains both an escalation and a question marker; choose one",
        )
    }
    if (
        Number(escalationMarkers.length > 0) +
            Number(questionMarkers.length > 0) +
            Number(frontierMarkers.length > 0) >
        1
    ) {
        throw new Error("SpecOps worker output contains incompatible control markers; choose one")
    }

    const markerPayloadSize = markers.reduce((sum, m) => sum + Buffer.byteLength(m.payload), 0)
    if (markerPayloadSize > config.questions.maxMarkerBytes) {
        throw new Error("SpecOps worker control marker exceeds maximum size")
    }

    const escalation = escalationMarkers[0]
        ? parseEscalationPayload(escalationMarkers[0].payload)
        : undefined
    const questions = questionMarkers.length
        ? questionMarkers.map(marker =>
              parseQuestionPayload(marker.payload, config.questions, phase, capability),
          )
        : undefined
    const frontier = frontierMarkers[0]
        ? parseFrontierPayload(frontierMarkers[0].payload, phase, capability)
        : undefined

    return { prose: prose.trim(), escalation, questions, frontier }
}

/**
 * Compute a stable hash for binding a question to authoritative inputs.
 *
 * The binding hash intentionally excludes incidental run-state mutations such
 * as `pendingQuestions`, timestamps, or pause status. It binds the question to
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
        ["escalation" | "question" | "frontier", RegExp]
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
 * Parse a strict, evidence-backed frontier escalation request.
 *
 * @param payload - Inner JSON marker payload.
 * @param phase - Artifact phase that raised the request.
 * @param capability - Capability executing the phase.
 * @returns A validated frontier request.
 */
function parseFrontierPayload(
    payload: string,
    phase: ArtifactId,
    capability: CapabilityId,
): FrontierRequest {
    const value = parseObject(payload, "frontier marker")
    assertKeys(value, FRONTIER_KEYS, "frontier marker")
    if (value.tier !== "low" && value.tier !== "high") {
        throw new Error("SpecOps frontier tier must be low or high")
    }
    if (typeof value.task !== "string" || !value.task.trim() || value.task.length > 1_000) {
        throw new Error("SpecOps frontier task must be a bounded non-empty string")
    }
    if (
        typeof value.whyNormalPathIsInsufficient !== "string" ||
        !value.whyNormalPathIsInsufficient.trim() ||
        value.whyNormalPathIsInsufficient.length > 2_000
    ) {
        throw new Error("SpecOps frontier request must explain why normal routing is insufficient")
    }
    if (!isValidImpact(String(value.impact))) {
        throw new Error("SpecOps frontier impact is invalid")
    }
    const impact = String(value.impact) as QuestionImpact
    if (!isImpactAllowed(impact, phase, capability)) {
        throw new Error(`SpecOps frontier impact '${impact}' is not valid for phase '${phase}'`)
    }
    if (
        !Array.isArray(value.evidence) ||
        value.evidence.length === 0 ||
        value.evidence.length > 20
    ) {
        throw new Error("SpecOps frontier request must contain 1 to 20 evidence references")
    }
    const evidence = value.evidence.map(parseEvidenceRef)
    if (
        !Array.isArray(value.attempts) ||
        value.attempts.length === 0 ||
        value.attempts.length > 5 ||
        value.attempts.some(
            attempt => typeof attempt !== "string" || !attempt.trim() || attempt.length > 1_000,
        )
    ) {
        throw new Error("SpecOps frontier request must contain 1 to 5 bounded attempts")
    }
    return {
        tier: value.tier,
        task: value.task,
        whyNormalPathIsInsufficient: value.whyNormalPathIsInsufficient,
        impact,
        evidence,
        attempts: value.attempts as string[],
    }
}

/**
 * Validate the discriminated evidence shapes accepted by control markers.
 *
 * @param value - Raw evidence value.
 * @returns A structurally valid evidence reference.
 */
export function parseEvidenceRef(value: unknown): EvidenceRef {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("SpecOps evidence must be an object")
    }
    const item = value as Record<string, unknown>
    const kind = item.kind
    const nonEmpty = (field: string): boolean =>
        typeof item[field] === "string" && Boolean((item[field] as string).trim())
    switch (kind) {
        case "changed-path":
        case "repository-path":
            if (Object.keys(item).length !== 2 || !nonEmpty("path")) break
            return item as EvidenceRef
        case "symbol":
            if (Object.keys(item).length !== 3 || !nonEmpty("path") || !nonEmpty("symbol")) break
            return item as EvidenceRef
        case "command":
            if (
                Object.keys(item).length !== 3 ||
                !nonEmpty("commandId") ||
                !Number.isInteger(item.exitCode)
            )
                break
            return item as EvidenceRef
        case "test-failure":
            if (Object.keys(item).length !== 3 || !nonEmpty("commandId") || !nonEmpty("test")) break
            return item as EvidenceRef
        case "dependency":
            if (
                Object.keys(item).length !== 3 ||
                !nonEmpty("package") ||
                !["added", "updated", "removed"].includes(String(item.change))
            )
                break
            return item as EvidenceRef
        case "contract":
            if (Object.keys(item).length !== 3 || !nonEmpty("path") || !nonEmpty("surface")) break
            return item as EvidenceRef
        case "unresolved-unknown":
            if (
                Object.keys(item).length !== 3 ||
                !nonEmpty("question") ||
                !Array.isArray(item.inspectionsPerformed) ||
                item.inspectionsPerformed.length === 0 ||
                item.inspectionsPerformed.some(entry => typeof entry !== "string" || !entry.trim())
            )
                break
            return item as EvidenceRef
    }
    throw new Error("SpecOps evidence contains an invalid reference")
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
 * Parse and strictly validate an escalation payload.
 *
 * The parser closes every enum and nested patch shape before model-controlled
 * data reaches escalation policy. Semantic admission, narrowing, and budgets
 * remain controller policy concerns.
 *
 * @param payload - Inner JSON text of the escalation marker.
 * @returns The parsed escalation claim.
 * @throws {Error} If any claim, evidence, patch, or validation field is malformed.
 */
function parseEscalationPayload(payload: string): EscalationClaim {
    const value = parseObject(payload, "escalation claim")
    assertKeys(value, ESCALATION_KEYS, "escalation claim")
    if (!ESCALATION_CATEGORIES.has(String(value.category))) {
        throw new Error("SpecOps escalation claim category is invalid")
    }
    if (!CONFIDENCE_LEVELS.has(String(value.confidence))) {
        throw new Error("SpecOps escalation claim confidence is invalid")
    }
    for (const field of ["summary", "boundaryCrossed", "whyCurrentRequirementsAreInsufficient"]) {
        if (typeof value[field] !== "string" || !value[field].trim()) {
            throw new Error(`SpecOps escalation claim ${field} must be a non-empty string`)
        }
    }
    if (!Array.isArray(value.evidence)) {
        throw new Error("SpecOps escalation claim evidence must be an array")
    }
    const evidence = value.evidence.map(parseEvidenceRef)
    const requestedPatch = parseEscalationPatch(value.requestedPatch)
    return {
        category: value.category as EscalationClaim["category"],
        confidence: value.confidence as EscalationClaim["confidence"],
        summary: value.summary as string,
        evidence,
        boundaryCrossed: value.boundaryCrossed as string,
        whyCurrentRequirementsAreInsufficient:
            value.whyCurrentRequirementsAreInsufficient as string,
        requestedPatch,
    }
}

/**
 * Validate the bounded additive patch inside an escalation claim.
 *
 * @param value - Raw `requestedPatch` marker value.
 * @returns A structurally valid escalation patch.
 * @throws {Error} If a field is unknown, mistyped, or outside its closed taxonomy.
 */
function parseEscalationPatch(value: unknown): EscalationClaim["requestedPatch"] {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("SpecOps escalation requestedPatch must be an object")
    }
    const patch = value as Record<string, unknown>
    assertKeys(patch, ESCALATION_PATCH_KEYS, "escalation requestedPatch")
    if (patch.raiseScopeTier !== undefined && !SCOPE_TIERS.has(String(patch.raiseScopeTier))) {
        throw new Error("SpecOps escalation raiseScopeTier is invalid")
    }
    const addCapabilities = optionalEnumArray(
        patch.addCapabilities,
        CAPABILITIES,
        "addCapabilities",
    )
    const addReviewFacets = optionalEnumArray(patch.addReviewFacets, RISK_FACETS, "addReviewFacets")
    const invalidate = optionalEnumArray(patch.invalidate, ARTIFACTS, "invalidate")
    const addValidations =
        patch.addValidations === undefined
            ? undefined
            : parseEscalationValidations(patch.addValidations)
    return {
        raiseScopeTier: patch.raiseScopeTier as
            EscalationClaim["requestedPatch"]["raiseScopeTier"] | undefined,
        addCapabilities: addCapabilities as
            EscalationClaim["requestedPatch"]["addCapabilities"] | undefined,
        addReviewFacets: addReviewFacets as
            EscalationClaim["requestedPatch"]["addReviewFacets"] | undefined,
        addValidations,
        invalidate: invalidate as EscalationClaim["requestedPatch"]["invalidate"] | undefined,
    }
}

/**
 * Validate an optional array against a closed string taxonomy.
 *
 * @param value - Raw optional array value.
 * @param allowed - Accepted string values.
 * @param label - Patch field name used in diagnostics.
 * @returns The validated array, or `undefined` when omitted.
 */
function optionalEnumArray(
    value: unknown,
    allowed: Set<string>,
    label: string,
): string[] | undefined {
    if (value === undefined) return undefined
    if (
        !Array.isArray(value) ||
        value.some(item => typeof item !== "string" || !allowed.has(item))
    ) {
        throw new Error(`SpecOps escalation ${label} must contain only supported values`)
    }
    return [...new Set(value)]
}

/**
 * Validate command, traceability, and OpenSpec validation requirements.
 *
 * @param value - Raw `addValidations` patch value.
 * @returns Structurally valid workflow validation requirements.
 */
function parseEscalationValidations(
    value: unknown,
): NonNullable<EscalationClaim["requestedPatch"]["addValidations"]> {
    if (!Array.isArray(value)) {
        throw new Error("SpecOps escalation addValidations must be an array")
    }
    return value.map(raw => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error("SpecOps escalation validation must be an object")
        }
        const item = raw as Record<string, unknown>
        if (typeof item.id !== "string" || !item.id.trim()) {
            throw new Error("SpecOps escalation validation id must be a non-empty string")
        }
        if (item.kind === "openspec-strict" || item.kind === "traceability") {
            assertKeys(item, new Set(["id", "kind"]), "escalation validation")
            return { id: item.id, kind: item.kind }
        }
        if (item.kind !== "command") {
            throw new Error("SpecOps escalation validation kind is invalid")
        }
        assertKeys(
            item,
            new Set(["id", "kind", "executable", "args", "cwd", "purpose", "requirements"]),
            "escalation validation",
        )
        if (
            typeof item.executable !== "string" ||
            !item.executable.trim() ||
            !Array.isArray(item.args) ||
            item.args.some(argument => typeof argument !== "string") ||
            (item.cwd !== undefined && typeof item.cwd !== "string") ||
            typeof item.purpose !== "string" ||
            !item.purpose.trim() ||
            !Array.isArray(item.requirements) ||
            item.requirements.some(
                requirement => typeof requirement !== "string" || !requirement.trim(),
            )
        ) {
            throw new Error("SpecOps escalation command validation is invalid")
        }
        return {
            id: item.id,
            kind: "command" as const,
            executable: item.executable,
            args: item.args as string[],
            cwd: item.cwd as string | undefined,
            purpose: item.purpose,
            requirements: item.requirements as string[],
        }
    })
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
    let recommendedCount = 0
    for (const option of value.options) {
        if (!option || typeof option !== "object" || Array.isArray(option)) {
            throw new Error("SpecOps question option must be an object")
        }
        const parsed = option as Record<string, unknown>
        for (const key of Object.keys(parsed)) {
            if (key === "impact") {
                throw new Error(
                    "SpecOps question option contains misplaced field: impact belongs at the question marker root",
                )
            }
            if (key !== "id" && key !== "label" && key !== "recommended") {
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
        let recommended: boolean | undefined
        if (parsed.recommended !== undefined) {
            if (typeof parsed.recommended !== "boolean") {
                throw new Error("SpecOps question option recommended must be a boolean")
            }
            if (parsed.recommended) {
                recommendedCount += 1
                if (recommendedCount > 1) {
                    throw new Error(
                        "SpecOps question marker may have at most one recommended option",
                    )
                }
                recommended = true
            }
        }
        options.push({ id: parsed.id, label: parsed.label, recommended })
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

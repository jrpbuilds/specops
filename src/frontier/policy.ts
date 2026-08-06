import { createHash, randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import path from "node:path"
import type {
    ArtifactId,
    CommandEvidence,
    DispatchRecord,
    EvidenceRef,
    FrontierEpisode,
    FrontierRequest,
    FrontierResponse,
    FrontierTier,
    PendingFrontier,
    RepairMode,
    RunState,
} from "../types.js"
import { parseEvidenceRef } from "../worker_output.js"
// The legacy frontier parser uses the canonical repair-mode set from contracts.
import { REPAIR_MODES } from "../workflow/contracts.js"

/** Result of applying frontier admission policy to a worker request. */
type FrontierQueueDecision =
    | { disposition: "queued"; pending: PendingFrontier }
    | { disposition: "continue" }
    | { disposition: "blocked"; reason: string }

/**
 * Validate repository-addressable evidence before it can spend frontier budget.
 *
 * Command and test evidence must resolve to a persisted command record.
 *
 * @param directory - Repository root.
 * @param evidence - Worker-supplied evidence references.
 * @param commands - Persisted command evidence available to the run.
 * @returns `true` when every repository path stays within the root and exists.
 */
export async function verifyFrontierEvidence(
    directory: string,
    evidence: EvidenceRef[],
    commands: CommandEvidence[] = [],
): Promise<boolean> {
    for (const item of evidence) {
        if (item.kind === "command") {
            if (
                !commands.some(
                    command => command.id === item.commandId && command.exitCode === item.exitCode,
                )
            ) {
                return false
            }
            continue
        }
        if (item.kind === "test-failure") {
            if (
                !commands.some(command => command.id === item.commandId && command.exitCode !== 0)
            ) {
                return false
            }
            continue
        }
        if (
            item.kind !== "changed-path" &&
            item.kind !== "repository-path" &&
            item.kind !== "symbol" &&
            item.kind !== "contract"
        ) {
            continue
        }
        const target = path.resolve(directory, item.path)
        if (target !== directory && !target.startsWith(`${directory}${path.sep}`)) return false
        try {
            await stat(target)
        } catch {
            return false
        }
    }
    return true
}

/**
 * Queue a worker-requested frontier episode when policy and budgets allow it.
 *
 * @param state - Mutable run state.
 * @param dispatch - Originating completed dispatch.
 * @param phase - Originating artifact phase.
 * @param request - Validated request marker.
 * @returns A deterministic admission decision.
 */
export function queueWorkerFrontier(
    state: RunState,
    dispatch: DispatchRecord,
    phase: ArtifactId,
    request: FrontierRequest,
): FrontierQueueDecision {
    if (state.frontierPolicy!.mode !== "adaptive") return { disposition: "continue" }
    const fingerprint = requestFingerprint(request, phase, dispatch.capability)
    const prior = state.frontierHistory?.find(item => item.fingerprint === fingerprint)
    const retryAfterAdvice =
        prior?.status === "advised" &&
        prior.selectedTier === "low" &&
        prior.dispatches === 1 &&
        canDispatch(state, "high")
    if (!prior && !canStartEpisode(state)) {
        return {
            disposition: "blocked",
            reason: "Frontier escalation budget exhausted for an unresolved worker blocker.",
        }
    }
    if (prior && !retryAfterAdvice) {
        return {
            disposition: "blocked",
            reason: "The worker remains blocked after the permitted frontier assistance.",
        }
    }

    const selectedTier = retryAfterAdvice ? "high" : selectTier(state, request.tier, request)
    const episodeId = retryAfterAdvice ? prior.id : randomUUID()
    const pending: PendingFrontier = {
        episodeId,
        request,
        trigger: retryAfterAdvice ? "repeated-blocker" : "worker-request",
        fingerprint,
        phase,
        capability: dispatch.capability,
        purpose: dispatch.purpose,
        action: dispatch.action,
        originalDispatchId: dispatch.id,
        selectedTier,
    }
    state.pendingFrontier = pending
    if (!retryAfterAdvice) {
        state.frontierUsage!.escalations += 1
        state.frontierHistory!.push({
            id: episodeId,
            trigger: "worker-request",
            fingerprint,
            phase,
            capability: dispatch.capability,
            requestedTier: request.tier,
            selectedTier,
            dispatches: 0,
            status: "pending",
            requestHash: hashJson(request),
            at: new Date().toISOString(),
        })
    } else {
        prior.status = "promoted"
        prior.selectedTier = "high"
        prior.trigger = "repeated-blocker"
    }
    return { disposition: "queued", pending }
}

/**
 * Queue deterministic adjudication of a standard review blocker.
 *
 * @param state - Mutable run state.
 * @param dispatch - Review dispatch that produced the blocker.
 * @param phase - Review artifact phase.
 * @param mode - Existing repair classification.
 * @param summary - Blocking finding summary.
 * @returns Whether frontier adjudication was queued.
 */
export function queueReviewFrontier(
    state: RunState,
    dispatch: DispatchRecord,
    phase: ArtifactId,
    mode: RepairMode,
    summary: string,
): boolean {
    if (state.frontierPolicy!.mode !== "adaptive") return false
    const normalisedSummary = summary.trim().toLowerCase().replace(/\s+/g, " ")
    const fingerprint = createHash("sha256")
        .update(
            JSON.stringify({
                phase,
                capability: dispatch.capability,
                mode,
                summary: normalisedSummary,
            }),
        )
        .digest("hex")
    const prior = state.frontierHistory?.find(item => item.fingerprint === fingerprint)
    const selectedTier: FrontierTier =
        prior?.status === "upheld" && canDispatch(state, "high") ? "high" : "low"
    if (!prior && !canStartEpisode(state)) return false
    if (prior && selectedTier === "low") return false

    const request: FrontierRequest = {
        tier: selectedTier,
        task: `Adjudicate this blocking review finding: ${summary}`,
        whyNormalPathIsInsufficient:
            "A standard review produced a completion blocker that requires independent adjudication.",
        impact:
            mode === "spec-mismatch" || mode === "design-revision" ? "design" : "implementation",
        evidence: [
            {
                kind: "unresolved-unknown",
                question: summary,
                inspectionsPerformed: ["standard review"],
            },
        ],
        attempts: [summary],
    }
    const episodeId = prior?.id ?? randomUUID()
    state.pendingFrontier = {
        episodeId,
        request,
        trigger: prior ? "repeated-blocker" : "review-blocker",
        fingerprint,
        phase,
        capability: dispatch.capability,
        purpose: dispatch.purpose,
        action: dispatch.action,
        originalDispatchId: dispatch.id,
        selectedTier,
        reviewFailure: { mode, summary },
    }
    if (!prior) {
        state.frontierUsage!.escalations += 1
        state.frontierHistory!.push({
            id: episodeId,
            trigger: "review-blocker",
            fingerprint,
            phase,
            capability: dispatch.capability,
            requestedTier: selectedTier,
            selectedTier,
            dispatches: 0,
            status: "pending",
            requestHash: hashJson(request),
            at: new Date().toISOString(),
        })
    } else {
        prior.status = "promoted"
        prior.selectedTier = "high"
        prior.trigger = "repeated-blocker"
    }
    return true
}

/** Return whether the current pending request may issue its selected tier. */
export function canIssuePendingFrontier(state: RunState): boolean {
    return Boolean(state.pendingFrontier && canDispatch(state, state.pendingFrontier.selectedTier))
}

/** Record one issued frontier dispatch against episode and run budgets. */
export function recordFrontierDispatch(state: RunState): void {
    const pending = state.pendingFrontier
    if (!pending) return
    state.frontierUsage!.dispatches += 1
    if (pending.selectedTier === "high") state.frontierUsage!.highDispatches += 1
    const episode = state.frontierHistory!.find(item => item.id === pending.episodeId)
    if (episode) episode.dispatches += 1
}

/**
 * Parse and strictly validate frontier JSON output.
 *
 * @param output - Raw frontier response.
 * @returns Validated structured response.
 */
export function parseFrontierResponse(output: string): FrontierResponse {
    let value: unknown
    try {
        value = JSON.parse(output)
    } catch {
        throw new Error("frontier response is not valid JSON")
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("frontier response must be an object")
    }
    const item = value as Record<string, unknown>
    const allowed = new Set(["disposition", "summary", "instruction", "repairMode", "evidence"])
    if (Object.keys(item).some(key => !allowed.has(key))) {
        throw new Error("frontier response contains an unknown field")
    }
    if (
        ![
            "ADVISE",
            "UPHOLD_BLOCKER",
            "DISMISS_BLOCKER",
            "INSUFFICIENT_EVIDENCE",
            "PROMOTE",
        ].includes(String(item.disposition)) ||
        typeof item.summary !== "string" ||
        !item.summary.trim() ||
        !Array.isArray(item.evidence)
    ) {
        throw new Error("frontier response has an invalid disposition, summary, or evidence")
    }
    if (item.summary.length > 2_000 || item.evidence.length > 20) {
        throw new Error("frontier response exceeds bounded summary or evidence limits")
    }
    const evidence = item.evidence.map(parseEvidenceRef)
    if (
        item.instruction !== undefined &&
        (typeof item.instruction !== "string" || item.instruction.length > 4_000)
    ) {
        throw new Error("frontier response instruction must be a bounded string")
    }
    if (item.repairMode !== undefined && !REPAIR_MODES.has(item.repairMode as RepairMode)) {
        throw new Error("frontier response repairMode is invalid")
    }
    if (
        (item.disposition === "ADVISE" || item.disposition === "INSUFFICIENT_EVIDENCE") &&
        !(item.instruction as string | undefined)?.trim()
    ) {
        throw new Error("frontier advice requires an instruction")
    }
    if (
        (item.disposition === "UPHOLD_BLOCKER" || item.disposition === "DISMISS_BLOCKER") &&
        item.evidence.length === 0
    ) {
        throw new Error("frontier blocker adjudication requires evidence")
    }
    if (
        (item.disposition === "UPHOLD_BLOCKER" || item.disposition === "DISMISS_BLOCKER") &&
        !evidence.some(reference =>
            [
                "changed-path",
                "repository-path",
                "symbol",
                "command",
                "test-failure",
                "contract",
            ].includes(reference.kind),
        )
    ) {
        throw new Error("frontier blocker adjudication requires verifiable evidence")
    }
    if (
        item.disposition === "UPHOLD_BLOCKER" &&
        (!(item.instruction as string | undefined)?.trim() || !item.repairMode)
    ) {
        throw new Error("upheld frontier blocker requires repairMode and instruction")
    }
    return { ...item, evidence } as FrontierResponse
}

/** Update the compact episode with a completed response. */
export function completeFrontierEpisode(
    state: RunState,
    response: FrontierResponse,
    output: string,
): FrontierEpisode {
    const pending = state.pendingFrontier
    const episode = state.frontierHistory?.find(item => item.id === pending?.episodeId)
    if (!pending || !episode) throw new Error("frontier response has no pending episode")
    episode.responseHash = createHash("sha256").update(output).digest("hex")
    episode.status =
        response.disposition === "ADVISE"
            ? "advised"
            : response.disposition === "PROMOTE"
              ? "promoted"
              : response.disposition === "UPHOLD_BLOCKER"
                ? "upheld"
                : response.disposition === "DISMISS_BLOCKER"
                  ? "dismissed"
                  : "insufficient"
    return episode
}

/** Return whether a low-tier response may promote the current episode. */
export function canPromotePending(state: RunState): boolean {
    return Boolean(state.pendingFrontier?.selectedTier === "low" && canDispatch(state, "high"))
}

function canStartEpisode(state: RunState): boolean {
    return (
        state.frontierPolicy!.mode === "adaptive" &&
        state.frontierUsage!.escalations < state.frontierPolicy!.maxEscalationsPerRun &&
        canDispatch(state, "low")
    )
}

function canDispatch(state: RunState, tier: FrontierTier): boolean {
    return (
        state.frontierUsage!.dispatches < state.frontierPolicy!.maxDispatchesPerRun &&
        (tier === "low" ||
            state.frontierUsage!.highDispatches < state.frontierPolicy!.maxHighDispatchesPerRun)
    )
}

function selectTier(
    state: RunState,
    requested: FrontierTier,
    request: FrontierRequest,
): FrontierTier {
    if (requested === "low") return "low"
    const critical =
        state.riskFacets.some(facet =>
            ["security", "data", "migration", "public-contract"].includes(facet),
        ) ||
        state.assessment.publicContract === "breaking" ||
        state.assessment.changeKind === "migration" ||
        request.evidence.some(item => item.kind === "contract") ||
        (state.scopeTier === "full" &&
            (state.confidence.requirements === "low" || state.confidence.design === "low"))
    return critical && canDispatch(state, "high") ? "high" : "low"
}

function requestFingerprint(
    request: FrontierRequest,
    phase: ArtifactId,
    capability: RunState["requirements"]["requiredCapabilities"][number],
): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                phase,
                capability,
                task: request.task.trim().toLowerCase(),
                impact: request.impact,
            }),
        )
        .digest("hex")
}

function hashJson(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

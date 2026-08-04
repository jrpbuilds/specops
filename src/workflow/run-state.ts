import { collectDiff } from "../git.js"
import { applyEscalation, decideEscalation } from "../escalation/policy.js"
import { scopeForActualDiff } from "../routing/policy.js"
import { hash, invalidate } from "../artifacts/lifecycle.js"
import { redactSensitiveText } from "../security/redact.js"
import type { SpecOpsConfig } from "../config.js"
import type { BlockReason, EscalationClaim, RunState, WorkflowOutcome } from "../types.js"

/**
 * Assign the machine-readable terminal or paused outcome representation.
 *
 * @param state - The run state (mutated in place).
 * @param status - The terminal status to assign.
 * @param category - The machine-readable outcome category.
 * @param message - The human-readable outcome message.
 * @param blockReason - Optional detailed reason for a blocked outcome.
 */
export function setOutcome(
    state: RunState,
    status: "blocked" | "failed" | "cancelled",
    category: WorkflowOutcome["category"],
    message: string,
    blockReason?: BlockReason,
): void {
    state.status = status
    state.pauseReason = undefined
    state.resumable = undefined
    if (blockReason) {
        state.blockReason = blockReason
    }
    if (status !== "cancelled") {
        state.outcome = {
            category,
            message: redactSensitiveText(message),
            at: new Date().toISOString(),
        }
    } else {
        state.outcome = {
            category,
            message: redactSensitiveText(message),
            at: new Date().toISOString(),
        }
    }
}

/**
 * Return whether a status allows active worker dispatch.
 *
 * @param status - The run status.
 * @returns `true` for `running` and `paused` (resumable); `false` for terminal.
 */
export function isActive(status: RunState["status"]): boolean {
    return status === "running" || status === "paused"
}

/**
 * Rebind a valid implementation artifact to the current repository diff.
 *
 * Any change observed outside implementation/repair completion invalidates the
 * implementation and all downstream assurance rather than silently reviewing
 * or finalizing a different worktree.
 */
export async function refreshImplementationBinding(
    directory: string,
    state: RunState,
    maxDiffBytes: number,
): Promise<boolean> {
    if (state.status !== "running" || state.artifacts.implementation?.validity !== "valid") {
        return false
    }
    // Repository diff collection requires a real git commit baseline; skip
    // the refresh for synthetic test baselines where no git context exists.
    if (!/^[0-9a-f]{40}$/i.test(state.baseline)) return false
    const current = hash(await collectDiff(directory, maxDiffBytes))
    const previous = state.implementationDiffHash
    state.implementationDiffHash = current
    if (previous === undefined || previous === current) return false
    invalidate(state, ["implementation"], "implementation diff changed outside writer completion")
    return true
}

/**
 * Apply an escalation claim to the run state.
 *
 * @param state - The current run state (mutated in place).
 * @param claim - The parsed escalation claim, if any.
 */
export function applyClaim(
    state: RunState,
    claim: EscalationClaim | undefined,
    config: Pick<SpecOpsConfig, "routing">,
): void {
    if (!claim) {
        return
    }

    const decision = decideEscalation(state, claim, config)
    state.decisions.push(decision)
    if (decision.disposition === "accepted" || decision.disposition === "narrowed") {
        applyEscalation(state, decision.appliedPatch)
        const invalidationRoots = decision.appliedPatch.invalidate ?? []
        if (invalidationRoots.length) {
            invalidate(
                state,
                [...new Set(invalidationRoots)],
                `accepted escalation: ${claim.summary}`,
            )
        }
    } else if (decision.reason.toLowerCase().includes("budget")) {
        setOutcome(
            state,
            "blocked",
            "policy-blocked",
            `Escalation could not proceed safely: ${decision.reason}`,
            "budget-exhausted",
        )
    }
}

/**
 * Upgrade a run when the actual implementation diff exceeds its current size floor.
 *
 * Files are counted directly. Modules are unique top-level directories, with
 * repository-root files grouped under `"."`. Full thresholds take precedence
 * over the Standard overflow threshold.
 *
 * @param state - Mutable run state.
 * @param paths - Changed non-OpenSpec repository paths.
 * @param config - Workflow thresholds and routing floors.
 */
export function applyActualDiffFloor(
    state: RunState,
    paths: string[],
    config: Pick<SpecOpsConfig, "workflow" | "routing">,
): void {
    if (state.scopeTier === "full" || paths.length === 0) return
    const modules = new Set(
        paths.map(changedPath => {
            const segments = changedPath.split("/").filter(Boolean)
            return segments.length > 1 ? segments[0] : "."
        }),
    ).size
    const target = scopeForActualDiff(state.scopeTier, paths, config.workflow.scopeThresholds)
    if (target === state.scopeTier) return

    applyClaim(
        state,
        {
            category: "scope-overflow",
            confidence: "high",
            summary: `Actual diff spans ${paths.length} files across ${modules} modules.`,
            evidence: paths.map(changedPath => ({ kind: "changed-path", path: changedPath })),
            boundaryCrossed: `${state.scopeTier} implementation size floor`,
            whyCurrentRequirementsAreInsufficient:
                "The actual implementation is larger than the routed workflow permits.",
            requestedPatch: {
                raiseScopeTier: target,
            },
        },
        config,
    )
}

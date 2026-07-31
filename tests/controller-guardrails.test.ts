import { describe, expect, it } from "vitest"
import { AGENT_IDS, ALL_AGENT_IDS, CONTROLLER_AGENT_IDS } from "../src/capabilities/ids.js"
import { AGENT_REGISTRY } from "../src/capabilities/registry.js"
import { promptText } from "../src/prompts.generated.js"

/**
 * Regression tests for the controller anti-drift guardrails. These assert that
 * both controller prompts contain the hard first-action, no-self-work, and
 * no-simulation phrases, and that the registry enforces the closed permission set
 * on controllers while leaving repository tools enabled for workers.
 */

describe("controller guardrails", () => {
    it.each(CONTROLLER_AGENT_IDS)(
        "%s prompt starts with the assessor first-action guardrail",
        id => {
            const text = promptText(id)
            const guardrailIndex = text.indexOf("FIRST action")
            expect(guardrailIndex).toBeGreaterThan(-1)
            expect(text.indexOf("specops-assessor")).toBeGreaterThan(-1)
            // The first-action guardrail should appear early in the prompt.
            expect(guardrailIndex).toBeLessThan(text.length / 3)
        },
    )

    it.each(CONTROLLER_AGENT_IDS)("%s prompt forbids doing worker work itself", id => {
        const text = promptText(id)
        expect(text).toContain("Never do")
        expect(text).toContain("specops_next_action")
        expect(text).toContain("specops_complete_action")
    })

    it.each(CONTROLLER_AGENT_IDS)("%s prompt forbids collapsing or simulating dispatches", id => {
        expect(promptText(id)).toContain("collapse, simulate")
    })

    it.each(CONTROLLER_AGENT_IDS)(
        "%s prompt instructs controller on completeAction failure",
        id => {
            const text = promptText(id)
            // Controllers must not retry a failed dispatchId; they must call
            // next_action to obtain a fresh dispatch for the same capability.
            expect(text).toContain("FAILURE HANDLING")
            expect(text).toContain("do NOT retry the same dispatchId")
            expect(text).toMatch(/[Cc]all specops_next_action again/)
        },
    )

    it.each(CONTROLLER_AGENT_IDS)("%s is denied exploration and editing tools", id => {
        const permission = AGENT_REGISTRY[id].permission
        expect(permission.bash).toBe("deny")
        expect(permission.edit).toBe("deny")
        expect(permission.read).toBe("deny")
        expect(permission.glob).toBe("deny")
        expect(permission.grep).toBe("deny")
        expect(permission.todowrite).toBe("deny")
    })

    it.each(CONTROLLER_AGENT_IDS)(
        "%s is allowed only dispatch and checkpoint tooling via permission",
        id => {
            const permission = AGENT_REGISTRY[id].permission
            expect(permission.task).toBe("allow")
            if (id === AGENT_IDS.controller.interactive) {
                expect(permission.question).toBe("allow")
            } else {
                expect(permission.question).toBe("deny")
            }
        },
    )

    it("interactive controller prompt instructs passing questionTools verbatim", () => {
        const text = promptText(AGENT_IDS.controller.interactive)
        expect(text).toContain("questionTools")
        expect(text).toContain("questions` array parameter")
        expect(text).toContain("specops_answer_questions")
    })

    it("interactive controller prompt forbids silently advancing without the question tool", () => {
        const text = promptText(AGENT_IDS.controller.interactive)
        // Both ask-question and checkpoint handlers must include an explicit
        // fallback for when the native question tool is unavailable: block on
        // a plain-text user reply instead of silently resuming.
        expect(text).toContain("QUESTION TOOL UNAVAILABLE FALLBACK")
        expect(text).toContain("do NOT silently advance")
        expect(text).toContain("do NOT silently call resumeCheckpoint")
        expect(text).toContain("wait for the user's reply")
        expect(text).toContain("Never silently advance a checkpoint")
    })

    it("non-controller agents retain repository read access", () => {
        for (const id of ALL_AGENT_IDS) {
            if (CONTROLLER_AGENT_IDS.includes(id as (typeof CONTROLLER_AGENT_IDS)[number])) {
                continue
            }
            const read = AGENT_REGISTRY[id].permission.read
            expect(read, id).not.toBe("deny")
        }
    })
})

/**
 * Agents whose prompts are allowed to teach the question/frontier marker
 * syntax. Must match the set in `prompts.generated.ts`.
 */
const QUESTION_ELIGIBLE_IDS: ReadonlySet<string> = new Set<string>([
    AGENT_IDS.core.assessor,
    AGENT_IDS.core.explorer,
    AGENT_IDS.core.planner,
    AGENT_IDS.core.designer,
    AGENT_IDS.core.implementer,
    AGENT_IDS.core.verifier,
    AGENT_IDS.core.repairer,
    AGENT_IDS.review.risk,
])

describe("control-marker policy exposure", () => {
    /**
     * Regression for a run failure where the infrastructure specialist echoed
     * the literal `<!-- specops-question: ... -->` marker in explanatory prose
     * and the validator rejected it as an inline marker. Specialists, judges,
     * refuter, and frontier workers must never receive the marker syntax in
     * their prompt, so they have nothing to echo back.
     */
    it.each(
        ALL_AGENT_IDS.filter(
            id =>
                !QUESTION_ELIGIBLE_IDS.has(id) &&
                !CONTROLLER_AGENT_IDS.includes(id as (typeof CONTROLLER_AGENT_IDS)[number]),
        ),
    )("%s prompt does not teach the question/frontier marker syntax", id => {
        const text = promptText(id as (typeof ALL_AGENT_IDS)[number])
        expect(text).not.toContain("specops-question:")
        expect(text).not.toContain("specops-frontier:")
        expect(text).not.toContain("QUESTION_POLICY")
        expect(text).not.toContain("You may emit exactly one")
    })

    it.each([...QUESTION_ELIGIBLE_IDS])(
        "%s prompt teaches the question marker policy so genuine blockers surface",
        id => {
            const text = promptText(id as (typeof ALL_AGENT_IDS)[number])
            expect(text).toContain("specops-question:")
            expect(text).toContain("You may emit one or more")
        },
    )
})

/**
 * Regression for the assessment-schema documentation gap: the assessor prompt
 * must inline the full canonical Assessment schema so the agent can emit a
 * conforming payload on the first try instead of being rejected by
 * parseAssessment and costing round-trips.
 */
describe("assessor prompt documents the assessment schema", () => {
    const text = promptText(AGENT_IDS.core.assessor)

    it("inlines every changeKind enum value", () => {
        for (const value of [
            "documentation",
            "configuration",
            "test",
            "bugfix",
            "refactor",
            "feature",
            "migration",
            "infrastructure",
        ]) {
            expect(text).toContain(value)
        }
    })

    it("inlines every publicContract and suggestedTier enum value", () => {
        expect(text).toContain('"none"')
        expect(text).toContain('"compatible"')
        expect(text).toContain('"breaking"')
        expect(text).toContain('"lean"')
        expect(text).toContain('"standard"')
        expect(text).toContain('"full"')
    })

    it("inlines every RiskFacet enum value", () => {
        for (const value of [
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
        ]) {
            expect(text).toContain(value)
        }
    })

    it("inlines every TouchedSurface enum value", () => {
        for (const value of [
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
            "documentation",
        ]) {
            expect(text).toContain(value)
        }
    })

    it("inlines every uncertainty confidence level and key", () => {
        // Assert the exact schema substring rather than bare words: "low" and
        // "high" also appear in the appended QUESTION_POLICY/FRONTIER_POLICY
        // ("low-risk", "high tier"), so bare-word assertions would pass even if
        // the schema block were missing.
        expect(text).toContain('"low" | "medium" | "high"')
        for (const key of [
            "requirements",
            "repository",
            "design",
            "implementation",
            "verification",
        ]) {
            expect(text).toContain(key)
        }
    })

    it("documents the expectedFiles/expectedModules numeric shape and likelyValidations cwd rule", () => {
        expect(text).toContain('"expectedFiles": number')
        expect(text).toContain('"expectedModules": number')
        expect(text).toContain("NOT an array or object")
        expect(text).toContain("must not start with")
        expect(text).toContain('must not contain ".."')
        expect(text).toContain('"executable"')
        expect(text).toContain('"args"')
        expect(text).toContain('"purpose"')
    })
})

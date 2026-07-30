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

    it.each(CONTROLLER_AGENT_IDS)("%s is denied exploration and editing tools", id => {
        const permission = AGENT_REGISTRY[id].permission
        expect(permission.bash).toBe("deny")
        expect(permission.edit).toBe("deny")
        expect(permission.read).toBe("deny")
        expect(permission.glob).toBe("deny")
        expect(permission.grep).toBe("deny")
        expect(permission.todowrite).toBe("deny")
    })

    it.each(CONTROLLER_AGENT_IDS)("%s is allowed only dispatch and checkpoint tooling", id => {
        const tools = AGENT_REGISTRY[id].tools
        expect(tools.task).toBe(true)
        if (id === AGENT_IDS.controller.interactive) {
            expect(tools.question).toBe(true)
        } else {
            expect(tools.question).toBe(false)
        }
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

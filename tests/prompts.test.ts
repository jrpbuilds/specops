import { describe, expect, it } from "vitest"
import { ALL_AGENT_IDS } from "../src/agents/ids.js"
import { loadPrompt, promptPath } from "../src/prompts/loader.js"
import { renderPrompt } from "../src/prompts/renderer.js"

describe("packaged Markdown prompts", () => {
    it("resolves one non-empty Markdown file for every final role", () => {
        expect(ALL_AGENT_IDS).toHaveLength(7)
        for (const id of ALL_AGENT_IDS) {
            expect(promptPath(id)).toMatch(/prompts\/[^/]+\.md$/)
            expect(loadPrompt(id)).toContain("# ")
        }
    })

    it("renders required trusted and untrusted values with explicit boundaries", () => {
        expect(
            renderPrompt("Instruction: {{instruction}}\n{{untrusted:goal}}", {
                trusted: { instruction: "Use evidence." },
                untrusted: { goal: "Change the parser." },
            }),
        ).toBe(
            "Instruction: Use evidence.\n<untrusted-goal>\nChange the parser.\n</untrusted-goal>",
        )
    })

    it("rejects missing values and unresolved placeholder values", () => {
        expect(() => renderPrompt("{{missing}}", {})).toThrow("missing prompt value")
        expect(() => renderPrompt("{{value}}", { trusted: { value: "{{unresolved}}" } })).toThrow(
            "unresolved placeholders",
        )
    })
})

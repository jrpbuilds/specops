import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

const repositoryRoot = path.resolve(import.meta.dirname, "..")

describe("SpecOps 1.0 architecture guardrails", () => {
    it("declares support for OpenSpec >=1.7.0 <1.8.0", async () => {
        const specification = await readFile(
            path.join(repositoryRoot, "docs", "specops-1.0-technical-spec.md"),
            "utf8",
        )

        expect(specification).toContain("OpenSpec >=1.7.0 <1.8.0")
    })

    it("tracks the standard OpenSpec project", () => {
        expect(() =>
            execFileSync("git", ["ls-files", "--error-unmatch", "openspec/config.yaml"], {
                cwd: repositoryRoot,
                encoding: "utf8",
            }),
        ).not.toThrow()
    })

    // Phase 2 replaces the 24-agent capability registry.
    it.skip("registers exactly the seven V1 agents", async () => {
        const agentIdsModule = "../src/agents/ids.js"
        const { ALL_AGENT_IDS } = await import(agentIdsModule)

        expect(ALL_AGENT_IDS).toEqual([
            "specops-coordinator",
            "specops-explorer",
            "specops-planner",
            "specops-designer",
            "specops-implementer",
            "specops-reviewer",
            "specops-frontier",
        ])
    })

    // Phase 8 replaces the command surface.
    it.skip("exposes exactly the five V1 public commands", async () => {
        const { COMMANDS } = await import("../src/commands.js")

        expect(Object.keys(COMMANDS).sort()).toEqual([
            "specops",
            "specops-cancel",
            "specops-doctor",
            "specops-onboard",
            "specops-status",
        ])
    })

    // Phase 8 removes automatic mode from public commands.
    it.skip("does not expose /specops-auto", async () => {
        const { COMMANDS } = await import("../src/commands.js")

        expect(COMMANDS).not.toHaveProperty("specops-auto")
    })

    // Phase 1 removes all bundled SpecOps schemas.
    it.skip("does not bundle specops schemas", async () => {
        const schemaRoot = path.join(repositoryRoot, "schemas")
        const schemas = existsSync(schemaRoot) ? await readdir(schemaRoot) : []

        expect(schemas.filter(schema => schema.startsWith("specops"))).toEqual([])
    })

    // Phase 8 replaces the deterministic dispatch protocol.
    it.skip("does not retain old protocol tool IDs", async () => {
        const protocol = await readFile(path.join(repositoryRoot, "src", "protocol.ts"), "utf8")

        for (const tool of [
            "specops_start_run",
            "specops_next_action",
            "specops_complete_action",
            "specops_recover_dispatch",
            "specops_answer_question",
            "specops_resume_checkpoint",
            "specops_archive_run",
            "specops_openspec",
        ]) {
            expect(protocol).not.toContain(tool)
        }
    })

    // Phase 2 moves generated prompts to Markdown files.
    it.skip("ships the seven V1 prompt files", async () => {
        const prompts = await readdir(path.join(repositoryRoot, "prompts"))

        expect(prompts.sort()).toEqual([
            "coordinator.md",
            "designer.md",
            "explorer.md",
            "frontier.md",
            "implementer.md",
            "planner.md",
            "reviewer.md",
        ])
    })

    // Phase 8 reduces the protocol to the V1 tool catalogue.
    it.skip("registers exactly the six V1 workflow tools", async () => {
        const { ALL_TOOL_IDS } = await import("../src/protocol.js")

        expect([...ALL_TOOL_IDS].sort()).toEqual([
            "specops_cancel",
            "specops_finalize",
            "specops_get_status",
            "specops_reconcile_stage",
            "specops_run_validation",
            "specops_start_or_resume",
        ])
    })
})

import { describe, expect, it } from "vitest"
import { ActiveAgentSessions, createPermissionAskHook } from "../src/agents/permission-hook.js"
import { AGENT_IDS, ALL_AGENT_IDS } from "../src/agents/ids.js"
import { AGENT_PERMISSIONS, ownsEditPath } from "../src/agents/permissions.js"
import { AGENT_REGISTRY } from "../src/agents/registry.js"

describe("SpecOps V1 agent catalogue", () => {
    it("registers exactly the seven final roles", () => {
        expect(ALL_AGENT_IDS).toEqual([
            "specops-coordinator",
            "specops-explorer",
            "specops-planner",
            "specops-designer",
            "specops-implementer",
            "specops-reviewer",
            "specops-frontier",
        ])
        expect(Object.keys(AGENT_REGISTRY).sort()).toEqual([...ALL_AGENT_IDS].sort())
    })

    it("enforces coordinator-only dispatch and question permissions", () => {
        for (const id of ALL_AGENT_IDS) {
            expect(AGENT_PERMISSIONS[id].task).toBe(id === AGENT_IDS.coordinator ? "allow" : "deny")
            expect(AGENT_PERMISSIONS[id].question).toBe(
                id === AGENT_IDS.coordinator ? "allow" : "deny",
            )
        }
    })

    it("enforces native edit policy and path-scoped artifact ownership", () => {
        expect(AGENT_PERMISSIONS[AGENT_IDS.implementer].edit).toBe("allow")
        expect(AGENT_PERMISSIONS[AGENT_IDS.coordinator].edit).toBe("deny")
        expect(AGENT_PERMISSIONS[AGENT_IDS.frontier].edit).toBe("deny")
        for (const id of [
            AGENT_IDS.explorer,
            AGENT_IDS.planner,
            AGENT_IDS.designer,
            AGENT_IDS.reviewer,
        ]) {
            expect(AGENT_PERMISSIONS[id].edit).toBe("ask")
        }
        expect(
            ownsEditPath(AGENT_IDS.planner, "openspec/changes/example-change/proposal.md", {
                change: "example-change",
                stage: "proposal",
            }),
        ).toBe(true)
        expect(
            ownsEditPath(AGENT_IDS.planner, "src/index.ts", {
                change: "example-change",
                stage: "proposal",
            }),
        ).toBe(false)
        expect(
            ownsEditPath(
                AGENT_IDS.planner,
                "openspec/changes/example-change/specs/agent-catalogue/spec.md",
                { change: "example-change", stage: "specs" },
            ),
        ).toBe(true)
    })

    it("allows only active owned edit requests through the native hook", async () => {
        const sessions = new ActiveAgentSessions()
        sessions.set("planner-session", AGENT_IDS.planner)
        const hook = createPermissionAskHook(sessions, () => ({ change: "example-change" }))
        const owned = { status: "ask" as const }
        await hook(
            {
                type: "edit",
                sessionID: "planner-session",
                pattern: "openspec/changes/example-change/proposal.md",
            } as never,
            owned,
        )
        expect(owned.status).toBe("allow")

        const outside = { status: "ask" as const }
        await hook(
            { type: "edit", sessionID: "planner-session", pattern: "src/index.ts" } as never,
            outside,
        )
        expect(outside.status).toBe("deny")
    })
})

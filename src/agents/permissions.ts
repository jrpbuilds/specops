import path from "node:path"
import { AGENT_IDS, type AgentId } from "./ids.js"

/** Native OpenCode permissions owned by a SpecOps agent policy. */
export type AgentPermission = {
    bash: "allow" | "deny"
    edit: "allow" | "ask" | "deny"
    read?: "allow" | "deny"
    glob?: "allow" | "deny"
    grep?: "allow" | "deny"
    todowrite?: "allow" | "deny"
    task?: "allow" | "deny"
    question?: "allow" | "deny"
}

/** Per-agent permissions implementing the SpecOps 1.0 permission table. */
export const AGENT_PERMISSIONS: Record<AgentId, AgentPermission> = {
    [AGENT_IDS.coordinator]: {
        bash: "deny",
        edit: "deny",
        read: "deny",
        glob: "deny",
        grep: "deny",
        todowrite: "deny",
        task: "allow",
        question: "allow",
    },
    [AGENT_IDS.explorer]: { bash: "deny", edit: "ask", task: "deny", question: "deny" },
    [AGENT_IDS.planner]: { bash: "deny", edit: "ask", task: "deny", question: "deny" },
    [AGENT_IDS.designer]: { bash: "deny", edit: "ask", task: "deny", question: "deny" },
    [AGENT_IDS.implementer]: { bash: "allow", edit: "allow", task: "deny", question: "deny" },
    [AGENT_IDS.reviewer]: { bash: "deny", edit: "ask", task: "deny", question: "deny" },
    [AGENT_IDS.frontier]: { bash: "deny", edit: "deny", task: "deny", question: "deny" },
}

/** Context required to resolve a path-scoped artifact writer's ownership. */
export type OwnedPathContext = {
    change?: string
    stage?: string
}

/** Return the repository-relative paths a path-scoped writer may edit. */
export function ownedPathPatterns(
    agent: AgentId,
    context: OwnedPathContext = {},
): readonly string[] {
    const change = validChangeName(context.change) ? context.change : "*"
    const openSpecChange = `openspec/changes/${change}`
    const run = `.specops/runs/${change}`

    switch (agent) {
        case AGENT_IDS.explorer:
            return [`${run}/exploration.md`]
        case AGENT_IDS.planner:
            return [
                `${openSpecChange}/proposal.md`,
                `${openSpecChange}/specs/**`,
                `${openSpecChange}/tasks.md`,
            ]
        case AGENT_IDS.designer:
            return [`${openSpecChange}/design.md`]
        case AGENT_IDS.reviewer:
            return [`${run}/review.md`]
        default:
            return []
    }
}

/** Return whether an edit request stays entirely within the agent's owned paths. */
export function ownsEditPath(
    agent: AgentId,
    requestedPattern: string,
    context: OwnedPathContext = {},
): boolean {
    if (AGENT_PERMISSIONS[agent].edit === "allow") return true
    if (AGENT_PERMISSIONS[agent].edit !== "ask") return false

    const requested = normalizePattern(requestedPattern)
    if (!requested) return false
    return ownedPathPatterns(agent, context).some(pattern => patternMatches(pattern, requested))
}

/** Normalize a repository-relative permission pattern and reject traversal. */
function normalizePattern(pattern: string): string | undefined {
    const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "")
    if (!normalized || path.posix.isAbsolute(normalized)) return undefined
    if (normalized.split("/").includes("..")) return undefined
    return normalized
}

/** Match the deliberately small path-pattern vocabulary accepted by this hook. */
function patternMatches(owned: string, requested: string): boolean {
    if (requested.includes("*")) return false
    const expression = owned
        .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
        .replaceAll("**", "\u0000")
        .replaceAll("*", "[^/]+")
        .replaceAll("\u0000", ".+")
    return new RegExp(`^${expression}$`).test(requested)
}

/** Restrict change-name interpolation in permission patterns. */
function validChangeName(change: string | undefined): change is string {
    return Boolean(change && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(change))
}

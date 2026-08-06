import { loadPrompt } from "../prompts/loader.js"
import { AGENT_IDS, ALL_AGENT_IDS, type AgentId } from "./ids.js"
import { AGENT_PERMISSIONS, type AgentPermission } from "./permissions.js"

/** Immutable policy for one final SpecOps 1.0 agent. */
export type AgentPolicy = {
    id: AgentId
    role: keyof typeof AGENT_IDS
    mode: "primary" | "subagent"
    maxSteps: number
    permission: AgentPermission
}

/** Final seven-agent catalogue. Workflow policies are not manifest-configurable. */
export const AGENT_REGISTRY: Record<AgentId, AgentPolicy> = {
    [AGENT_IDS.coordinator]: policy(AGENT_IDS.coordinator, "coordinator", "primary", 96),
    [AGENT_IDS.explorer]: policy(AGENT_IDS.explorer, "explorer", "subagent", 48),
    [AGENT_IDS.planner]: policy(AGENT_IDS.planner, "planner", "subagent", 64),
    [AGENT_IDS.designer]: policy(AGENT_IDS.designer, "designer", "subagent", 64),
    [AGENT_IDS.implementer]: policy(AGENT_IDS.implementer, "implementer", "subagent", 96),
    [AGENT_IDS.reviewer]: policy(AGENT_IDS.reviewer, "reviewer", "subagent", 64),
    [AGENT_IDS.frontier]: policy(AGENT_IDS.frontier, "frontier", "subagent", 48),
}

/** Return the packaged Markdown prompt for a registered agent. */
export function agentPrompt(id: AgentId): string {
    return loadPrompt(id)
}

/** Construct one immutable policy and prove its corresponding prompt exists. */
function policy(
    id: AgentId,
    role: keyof typeof AGENT_IDS,
    mode: AgentPolicy["mode"],
    maxSteps: number,
): AgentPolicy {
    loadPrompt(id)
    return { id, role, mode, maxSteps, permission: AGENT_PERMISSIONS[id] }
}

if (Object.keys(AGENT_REGISTRY).length !== ALL_AGENT_IDS.length) {
    throw new Error("SpecOps agent registry does not match the final catalogue")
}

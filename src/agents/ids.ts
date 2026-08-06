/** Canonical identifiers for the seven SpecOps 1.0 agents. */
export const AGENT_IDS = {
    coordinator: "specops-coordinator",
    explorer: "specops-explorer",
    planner: "specops-planner",
    designer: "specops-designer",
    implementer: "specops-implementer",
    reviewer: "specops-reviewer",
    frontier: "specops-frontier",
} as const

/** Union of the final SpecOps 1.0 agent identifiers. */
export type AgentId = (typeof AGENT_IDS)[keyof typeof AGENT_IDS]

/** Ordered, exact final SpecOps 1.0 agent catalogue. */
export const ALL_AGENT_IDS = Object.values(AGENT_IDS) as readonly AgentId[]

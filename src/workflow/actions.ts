import type { CapabilityId, DispatchPurpose } from "../types.js"
import type { AgentId } from "../capabilities/ids.js"

/**
 * A deterministic action selected by the scheduler for a single agent dispatch.
 *
 * Every action carries the capability it exercises, the purpose (consultation,
 * independent-review, judgment, repair, or workflow), the resolved agent, and
 * the prompt given to that agent.
 */
export type WorkflowAction = {
    id: string
    capability: CapabilityId
    agent: AgentId
    purpose: DispatchPurpose
    independent: boolean
    mode?: string
    artifact?: string
    prompt: string
}

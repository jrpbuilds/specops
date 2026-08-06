import type { Hooks } from "@opencode-ai/plugin";
import { type AgentId } from "./ids.js";
import { ownsEditPath, type OwnedPathContext } from "./permissions.js";

type PermissionRequest = {
    type?: string;
    pattern?: string | readonly string[];
    sessionID?: string;
};

/** Track the active agent for each OpenCode session. */
export class ActiveAgentSessions {
    private readonly agents = new Map<string, AgentId>();

    /** Bind an OpenCode session to the agent whose message is being handled. */
    set(sessionID: string, agent: AgentId): void {
        this.agents.set(sessionID, agent);
    }

    /** Look up the active agent for a permission request. */
    get(sessionID: string | undefined): AgentId | undefined {
        return sessionID ? this.agents.get(sessionID) : undefined;
    }
}

/**
 * Create the native OpenCode edit-permission hook for artifact writers.
 *
 * A missing agent, missing pattern, unknown request type, or path outside the
 * role's ownership is denied. Implementer edits are already native `allow` and
 * therefore do not normally reach this hook.
 */
export function createPermissionAskHook(
    sessions: ActiveAgentSessions,
    contextForSession: (sessionID: string | undefined) => OwnedPathContext = () => ({}),
): NonNullable<Hooks["permission.ask"]> {
    return async (input, output) => {
        const request = input as PermissionRequest;
        if (request.type !== "edit") return;
        const agent = sessions.get(request.sessionID);
        const patterns = request.pattern
            ? typeof request.pattern === "string"
                ? [request.pattern]
                : [...request.pattern]
            : [];
        output.status =
            agent &&
            patterns.length > 0 &&
            patterns.every(pattern =>
                ownsEditPath(agent, pattern, contextForSession(request.sessionID)),
            )
                ? "allow"
                : "deny";
    };
}

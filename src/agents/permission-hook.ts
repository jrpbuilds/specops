import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import { type AgentId } from "./ids.js";
import { ownsEditPath, type OwnedPathContext } from "./permissions.js";
import { readV1Run } from "../state/store.js";

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
 * Resolve the trusted active change and stage for a directory from persisted
 * run state. Returns an empty context — which denies path-scoped edits rather
 * than wildcarding — when no single non-terminal run exists. This is the
 * B-05 mitigation: path-scoped writers never fall back to the '*' wildcard.
 */
export async function resolveOwnedPathContext(directory: string): Promise<OwnedPathContext> {
    const runsDir = path.join(directory, ".specops", "runs");
    const names = await readdir(runsDir).catch(() => []);
    const active: OwnedPathContext[] = [];
    for (const name of names) {
        try {
            const state = await readV1Run(directory, name);
            if (
                state.status === "active" ||
                state.status === "awaiting-user" ||
                state.status === "verified"
            ) {
                active.push({ change: state.change, stage: state.stage });
            }
        } catch {
            // Skip unreadable or corrupt run directories; corruption is rejected.
        }
    }
    if (active.length !== 1) return {};
    return active[0];
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
    contextForSession: (
        sessionID: string | undefined,
    ) => OwnedPathContext | Promise<OwnedPathContext> = () => ({}),
): NonNullable<Hooks["permission.ask"]> {
    return async (input, output) => {
        const request = input as PermissionRequest;
        if (request.type !== "edit") return;
        const agent = sessions.get(request.sessionID);
        const context = await contextForSession(request.sessionID);
        const patterns = request.pattern
            ? typeof request.pattern === "string"
                ? [request.pattern]
                : [...request.pattern]
            : [];
        output.status =
            agent &&
            patterns.length > 0 &&
            patterns.every(pattern => ownsEditPath(agent, pattern, context))
                ? "allow"
                : "deny";
    };
}

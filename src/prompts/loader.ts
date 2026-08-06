import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { AGENT_IDS, type AgentId } from "../agents/ids.js"

const PROMPT_FILES: Record<AgentId, string> = {
    [AGENT_IDS.coordinator]: "coordinator.md",
    [AGENT_IDS.explorer]: "explorer.md",
    [AGENT_IDS.planner]: "planner.md",
    [AGENT_IDS.designer]: "designer.md",
    [AGENT_IDS.implementer]: "implementer.md",
    [AGENT_IDS.reviewer]: "reviewer.md",
    [AGENT_IDS.frontier]: "frontier.md",
}

/** Resolve the package-relative prompt directory in source and packed installs. */
export function promptDirectory(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts")
}

/** Resolve an agent prompt without accepting caller-controlled file paths. */
export function promptPath(id: AgentId): string {
    return path.join(promptDirectory(), PROMPT_FILES[id])
}

/** Load a packaged Markdown prompt and fail loudly when the asset is missing. */
export function loadPrompt(id: AgentId): string {
    const prompt = readFileSync(promptPath(id), "utf8")
    if (!prompt.trim()) throw new Error(`SpecOps prompt is empty: ${PROMPT_FILES[id]}`)
    return prompt
}

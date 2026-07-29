import { promptText } from "./prompts.js"

/**
 * Built-in default agent manifest.
 *
 * This is the source of truth shipped with the npm package. On first load, the
 * plugin writes a copy to `~/.config/opencode/specops-manifest.json` so users
 * can customize agent models and permissions without losing their edits on
 * plugin updates. The on-disk file always wins over this default when present.
 */

/**
 * Per-agent tool permissions. `false` removes a tool from the agent's reach;
 * `true` (or omitted) keeps it. Matches the OpenCode agent `tools` field.
 */
export type AgentTools = {
  question?: boolean
  todowrite?: boolean
  task?: boolean
}

/**
 * Per-agent filesystem and shell permissions. Each value is `"allow"`,
 * `"deny"`, or `"ask"`. Matches the OpenCode agent `permission` field.
 */
export type AgentPermission = {
  bash: "allow" | "deny" | "ask"
  edit: "allow" | "deny" | "ask"
  task: "allow" | "deny" | "ask"
}

/**
 * One agent entry in the manifest. The `model` is a `provider/model` string.
 * `steps` bounds the agent's tool-call budget. `tools` and `permission`
 * enforce least-privilege per role. Additional fields are passed through to
 * OpenCode as provider/model options, such as `reasoningEffort`.
 */
export type AgentDefinition = {
  model: string
  steps: number
  tools: AgentTools
  permission: AgentPermission
  [option: string]: unknown
}

/** The manifest shape persisted to `~/.config/opencode/specops-manifest.json`. */
export type SpecOpsManifest = {
  agents: Record<string, AgentDefinition>
}

/**
 * Convert a manifest entry into an OpenCode subagent definition.
 * Provider/model options are deliberately preserved rather than whitelisted;
 * OpenCode supports additional provider-specific options such as
 * `reasoningEffort`.
 */
export function manifestAgentConfig(agentId: string, definition: AgentDefinition): AgentDefinition & {
 mode: "subagent"
 prompt: string
} {
  const { maxSteps: _deprecatedMaxSteps, ...config } = definition
  return {
    ...config,
    mode: "subagent" as const,
    prompt: promptText(agentId),
  }
}

/**
 * The default manifest shipped with the plugin. 19 least-privilege agents:
 * the assessor, planning stages, implementation and verification engineers,
 * the archivist, onboarding analyst, two adversarial judges, the remediation
 * engineer, four review specialists, and the review refuter.
 */
export const DEFAULT_MANIFEST: SpecOpsManifest = {
  agents: {
    "sdd-assess": {
      model: "opencode/deepseek-v4-flash-free",
      steps: 32,
      tools: { question: false, todowrite: false },
      permission: { bash: "deny", edit: "deny", task: "deny" },
    },
    "sdd-init": {
      model: "opencode/deepseek-v4-flash-free",
      steps: 32,
      tools: { question: false, todowrite: false },
      permission: { bash: "deny", edit: "deny", task: "deny" },
    },
    "sdd-explore": {
      model: "opencode/ling-3.0-flash-free",
      steps: 32,
      tools: { question: false, todowrite: false },
      permission: { bash: "deny", edit: "deny", task: "deny" },
    },
    "sdd-propose": {
      model: "opencode/nemotron-3-ultra-free",
      steps: 32,
      tools: { question: false, todowrite: false },
      permission: { bash: "deny", edit: "deny", task: "deny" },
    },
    "sdd-spec": {
      model: "opencode/nemotron-3-ultra-free",
      steps: 32,
      tools: { question: false, todowrite: false },
      permission: { bash: "deny", edit: "deny", task: "deny" },
    },
    "sdd-design": {
      model: "opencode/nemotron-3-ultra-free",
      steps: 32,
      tools: { question: false, todowrite: false },
      permission: { bash: "deny", edit: "deny", task: "deny" },
    },
    "sdd-tasks": {
      model: "opencode/laguna-s-2.1-free",
      steps: 32,
      tools: { question: false, todowrite: false },
      permission: { bash: "deny", edit: "deny", task: "deny" },
    },
    "sdd-apply": {
      model: "opencode/north-mini-code-free",
      steps: 96,
      tools: { question: false, todowrite: false },
      permission: { bash: "allow", edit: "allow", task: "deny" },
    },
    "sdd-verify": {
      model: "opencode/mimo-v2.5-free",
      steps: 64,
      tools: { question: false, todowrite: false },
      permission: { bash: "allow", edit: "deny", task: "deny" },
    },
    "sdd-archive": {
      model: "opencode/deepseek-v4-flash-free",
      steps: 32,
      tools: { question: false, todowrite: false },
      permission: { bash: "deny", edit: "deny", task: "deny" },
    },
    "sdd-onboard": {
      model: "opencode/deepseek-v4-flash-free",
      steps: 32,
      tools: { question: false, todowrite: false },
      permission: { bash: "deny", edit: "deny", task: "deny" },
    },
    "jd-judge-a": {
      model: "opencode/nemotron-3-ultra-free",
      steps: 32,
      tools: { question: false, todowrite: false },
      permission: { bash: "deny", edit: "deny", task: "deny" },
    },
    "jd-judge-b": {
      model: "opencode/mimo-v2.5-free",
      steps: 32,
      tools: { question: false, todowrite: false },
      permission: { bash: "deny", edit: "deny", task: "deny" },
    },
    "jd-fix-agent": {
      model: "opencode/north-mini-code-free",
      steps: 64,
      tools: { question: false, todowrite: false },
      permission: { bash: "allow", edit: "allow", task: "deny" },
    },
    "review-risk": {
      model: "opencode/mimo-v2.5-free",
      steps: 32,
      tools: { question: false, todowrite: false },
      permission: { bash: "deny", edit: "deny", task: "deny" },
    },
    "review-readability": {
      model: "opencode/laguna-s-2.1-free",
      steps: 32,
      tools: { question: false, todowrite: false },
      permission: { bash: "deny", edit: "deny", task: "deny" },
    },
    "review-reliability": {
      model: "opencode/mimo-v2.5-free",
      steps: 32,
      tools: { question: false, todowrite: false },
      permission: { bash: "deny", edit: "deny", task: "deny" },
    },
    "review-resilience": {
      model: "opencode/ling-3.0-flash-free",
      steps: 32,
      tools: { question: false, todowrite: false },
      permission: { bash: "deny", edit: "deny", task: "deny" },
    },
    "review-refuter": {
      model: "opencode/nemotron-3-ultra-free",
      steps: 32,
      tools: { question: false, todowrite: false },
      permission: { bash: "deny", edit: "deny", task: "deny" },
    },
  },
}

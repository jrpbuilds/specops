import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { format } from "prettier"
import { ALL_AGENT_IDS, CONTROLLER_AGENT_IDS } from "../dist/capabilities/ids.js"
import { AGENT_REGISTRY } from "../dist/capabilities/registry.js"
import { COMMANDS } from "../dist/commands.js"
import { ALL_TOOL_IDS } from "../dist/protocol.js"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const checkOnly = process.argv.includes("--check")

await emit("docs/agents.md", agentDocumentation())
await emit("docs/commands.md", commandDocumentation())

async function emit(relative, content) {
    const destination = path.join(repositoryRoot, relative)
    const formatted = await format(`${content.trim()}\n`, {
        parser: "markdown",
        printWidth: 100,
        proseWrap: "preserve",
    })
    if (checkOnly) {
        const existing = await readFile(destination, "utf8")
        if (existing !== formatted) {
            throw new Error(`${relative} has drifted; run npm run generate`)
        }
        return
    }
    await writeFile(destination, formatted)
}

function agentDocumentation() {
    const rows = ALL_AGENT_IDS.map(id => {
        const agent = AGENT_REGISTRY[id]
        const authority =
            agent.permission.edit === "allow"
                ? "Code mutation"
                : agent.permission.bash === "allow"
                  ? "Command execution"
                  : agent.permission.read === "deny"
                    ? "Scheduler only"
                    : "Read-only reasoning"
        const modelCell = agent.model.trim() ? `\`${agent.model}\`` : "*Default*"
        return `| \`${id}\` | ${agent.mode} | ${agent.role} | ${authority} | ${modelCell} |`
    }).join("\n")

    return `# Agent catalogue

This file is generated from the typed capability registry. Run \`npm run generate\`
after an intentional catalogue change; \`npm run generated:check\` rejects drift.

The ${CONTROLLER_AGENT_IDS.length} controllers are primary agents. All capability
workers are subagents and have recursive task dispatch disabled. Model and provider
options are user-tunable through the materialised manifest; mode, prompts, tools,
and permissions remain registry-controlled.

A *Default* model means the agent inherits OpenCode's configured global default
model until the user selects a provider/model mapping.

| Agent ID | Mode | Distinct role | Maximum authority | Default model |
| --- | --- | --- | --- | --- |
${rows}

Consultation and independent-review dispatches use the same specialist identity
but different recorded purposes. A consultation therefore cannot satisfy the
independent post-implementation review gate.
`
}

function commandDocumentation() {
    const rows = Object.entries(COMMANDS)
        .map(([name, command]) => {
            const tool = ALL_TOOL_IDS.find(id => command.template.includes(id))
            const target = command.agent
                ? `primary agent \`${command.agent}\``
                : `protocol tool \`${tool}\``
            return `| \`/${name}\` | ${command.description ?? ""} | ${target} |`
        })
        .join("\n")

    return `# Commands

Public commands are registered by the plugin config hook. This table is generated
from the runtime command catalogue so controller and adapter targets cannot drift.

| Command | Purpose | Runtime target |
| --- | --- | --- |
${rows}

Interactive and automatic execution both use the deterministic scheduler.
Non-interactive automation uses OpenCode's supported
\`opencode run --command specops-auto --dir <project> <goal>\` adapter, which
resolves the same automatic controller as the command palette. Any future focused
command must enter through a protocol tool or registered controller; it must not
dispatch workers or mutate run state directly.
`
}

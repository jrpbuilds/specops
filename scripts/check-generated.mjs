import { AGENT_IDS, ALL_AGENT_IDS } from "../dist/capabilities/ids.js"
import {
    AGENT_REGISTRY,
    SCHEDULER_CAPABILITIES,
    agentForCapability,
} from "../dist/capabilities/registry.js"
import { COMMANDS } from "../dist/commands.js"
import { DEFAULT_MANIFEST, validateManifest } from "../dist/manifest.js"
import { promptText } from "../dist/prompts.generated.js"
import { spawnSync } from "node:child_process"

// Verify the generated contract strings match the canonical constants and
// templates before checking the rest of the generated surface.
const contracts = spawnSync(process.execPath, ["scripts/generate-contracts.mjs", "--check"], {
    cwd: process.cwd(),
    encoding: "utf8",
})
if (contracts.status !== 0) {
    throw new Error(contracts.stderr || contracts.stdout)
}

const expected = [...ALL_AGENT_IDS].sort()
const registryIDs = Object.keys(AGENT_REGISTRY).sort()
const manifestIDs = Object.keys(validateManifest(DEFAULT_MANIFEST).agents).sort()

assertEqual(registryIDs, expected, "agent registry")
assertEqual(manifestIDs, expected, "generated manifest")
for (const id of ALL_AGENT_IDS) {
    if (!promptText(id).trim()) {
        throw new Error(`generated prompt is empty for ${id}`)
    }
}
for (const capability of SCHEDULER_CAPABILITIES) {
    const id = agentForCapability(capability)
    if (!AGENT_REGISTRY[id]) {
        throw new Error(`capability ${capability} resolves missing agent ${String(id)}`)
    }
}
if (COMMANDS.specops?.agent !== AGENT_IDS.controller.interactive) {
    throw new Error("interactive command/controller drift")
}
if (COMMANDS["specops-auto"]?.agent !== AGENT_IDS.controller.automatic) {
    throw new Error("automatic command/controller drift")
}
assertEqual(
    Object.keys(COMMANDS).sort(),
    [
        "specops",
        "specops-archive",
        "specops-auto",
        "specops-doctor",
        "specops-onboard",
        "specops-status",
    ].sort(),
    "public command catalogue",
)

const documentation = spawnSync(process.execPath, ["scripts/generate-docs.mjs", "--check"], {
    cwd: process.cwd(),
    encoding: "utf8",
})
if (documentation.status !== 0) {
    throw new Error(documentation.stderr || documentation.stdout)
}

function assertEqual(actual, expectedValues, name) {
    if (JSON.stringify(actual) !== JSON.stringify(expectedValues)) {
        throw new Error(`${name} does not match the canonical agent IDs`)
    }
}

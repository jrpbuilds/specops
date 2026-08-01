import { access, mkdir, readFile, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// OpenCode keeps npm-installed plugins in its cache. These copies are only
// consumed when the config references the package by name; a `file://` plugin
// is loaded directly from the build folder. Removing the stale installs makes
// sure nothing older than the current local build can be picked up.
const CACHE_ROOTS = [
    path.join(os.homedir(), ".cache", "opencode", "packages", "@jrpbuilds"),
    path.join(os.homedir(), ".cache", "opencode", "node_modules", "@jrpbuilds"),
]

async function pathExists(target) {
    try {
        await access(target)
        return true
    } catch {
        return false
    }
}

async function removeIfPresent(target) {
    if (await pathExists(target)) {
        await rm(target, { recursive: true, force: true })
        console.log(`removed ${target}`)
    }
}

// Rebuild dist so the plugin opencode imports from `file://` is guaranteed to
// match the current source tree.
function runBuild() {
    return new Promise((resolve, reject) => {
        const child = spawn("npm", ["run", "build"], {
            cwd: repositoryRoot,
            stdio: "inherit",
            shell: process.platform === "win32",
        })
        child.on("exit", code => {
            if (code === 0) {
                resolve()
            } else {
                reject(new Error(`npm run build exited with code ${code}`))
            }
        })
        child.on("error", reject)
    })
}

// Import the freshly built entry and assert it exposes the canonical plugin
// module shape opencode expects: `{ id, server }`.
async function verifyPluginEntry() {
    const entry = await import(path.join(repositoryRoot, "dist", "index.js"))
    const plugin = entry.default
    if (!plugin || plugin.id !== "specops" || typeof plugin.server !== "function") {
        throw new Error("dist/index.js does not expose a specops plugin module")
    }
    console.log(`verified dist/index.js exports { id: "${plugin.id}", server }`)
}

// Parse and validate the global user configuration with the freshly built
// validator. The file is user-owned, so a failure is reported but never
// overwritten.
async function verifyGlobalConfig() {
    const configPath = path.join(os.homedir(), ".config", "opencode", "specops.json")
    if (!(await pathExists(configPath))) {
        console.log("no global config at ~/.config/opencode/specops.json; defaults will be used")
        return
    }
    const config = JSON.parse(await readFile(configPath, "utf8"))
    const configModule = await import(path.join(repositoryRoot, "dist", "config.js"))
    configModule.validatePartialConfig(config, configPath)
    console.log(`validated ${configPath}`)
}

try {
    await mkdir(path.join(repositoryRoot, "dist"), { recursive: true })
} catch {
    // The build step creates dist; nothing to do here.
}

for (const root of CACHE_ROOTS) {
    await removeIfPresent(root)
}

await runBuild()
await verifyPluginEntry()
await verifyGlobalConfig()

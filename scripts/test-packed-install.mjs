import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { spawn, spawnSync } from "node:child_process"

const repositoryRoot = path.resolve(import.meta.dirname, "..")
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "specops-packed-"))
const packageDirectory = path.join(temporaryRoot, "package")
const isolatedConfigHome = path.join(temporaryRoot, "config")
const npmCache = path.join(temporaryRoot, "npm-cache")

const packed = spawnSync("npm", ["pack", "--pack-destination", temporaryRoot], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache },
})
assertProcess(packed, "npm pack")
const archiveName = (await readdir(temporaryRoot)).find(file => file.endsWith(".tgz"))
assert(archiveName, "npm pack did not create an archive")
const archive = path.join(temporaryRoot, archiveName)

const extracted = spawnSync("tar", ["-xzf", archive, "-C", temporaryRoot], {
    encoding: "utf8",
})
assertProcess(extracted, "package extraction")
const packageMetadata = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
)
assert(packageMetadata.bin === undefined, "package unexpectedly installs a separate CLI binary")

// OpenCode supplies the peer SDK at runtime. The test uses the exact locally
// installed peer without copying any source files into the packed package.
await symlink(
    path.join(repositoryRoot, "node_modules"),
    path.join(packageDirectory, "node_modules"),
)

const manifestPath = path.join(isolatedConfigHome, "opencode", "specops-manifest.json")
await mkdir(path.dirname(manifestPath), { recursive: true })
await writeFile(manifestPath, `${JSON.stringify({ version: 2, agents: {} }, null, 2)}\n`)

process.env.XDG_CONFIG_HOME = isolatedConfigHome
process.env.HOME = path.join(temporaryRoot, "home")

const packageEntry = `${pathToFileURL(path.join(packageDirectory, "dist", "index.js")).href}?${randomUUID()}`
const pluginModule = await import(packageEntry)
const idsModule = await import(
    `${pathToFileURL(path.join(packageDirectory, "dist", "capabilities", "ids.js")).href}?${randomUUID()}`
)
const protocolModule = await import(
    `${pathToFileURL(path.join(packageDirectory, "dist", "protocol.js")).href}?${randomUUID()}`
)
const manifestModule = await import(
    `${pathToFileURL(path.join(packageDirectory, "dist", "manifest.js")).href}?${randomUUID()}`
)
const tuiModule = await import(
    `${pathToFileURL(path.join(packageDirectory, "dist", "tui.js")).href}?${randomUUID()}`
)

const hooks = await pluginModule.default.server(fakePluginInput(packageDirectory))
const config = {}
await hooks.config(config)

const { AGENT_IDS, ALL_AGENT_IDS } = idsModule
const tuiLayers = []
await tuiModule.default.tui(
    {
        keymap: {
            registerLayer: layer => {
                tuiLayers.push(layer)
                return () => {}
            },
        },
        event: { on: () => () => {} },
        lifecycle: { onDispose() {} },
    },
    undefined,
    {},
)
assert(
    tuiLayers.some(layer =>
        layer.commands?.some(
            command =>
                command.name === "specops.models.configure" &&
                command.namespace === "palette" &&
                command.title === "SpecOps: Configure agent models",
        ),
    ),
    "packed TUI did not register the model settings command",
)
assert(
    config.command.specops.agent === AGENT_IDS.controller.interactive,
    "interactive command drift",
)
assert(
    config.command["specops-auto"].agent === AGENT_IDS.controller.automatic,
    "automatic command drift",
)
assert(
    Object.keys(config.command).sort().join("|") ===
        ["specops", "specops-auto", "specops-doctor", "specops-onboard", "specops-status"]
            .sort()
            .join("|"),
    "packed public command catalogue drifted",
)
assert(
    config.agent[AGENT_IDS.controller.interactive]?.mode === "primary",
    "interactive controller missing",
)
assert(
    config.agent[AGENT_IDS.controller.automatic]?.mode === "primary",
    "automatic controller missing",
)
assert(
    Object.keys(config.agent).sort().join("|") === [...ALL_AGENT_IDS].sort().join("|"),
    "packed runtime did not register the exact agent catalogue",
)

for (const id of ALL_AGENT_IDS) {
    assert(config.agent[id], `packed runtime omitted ${id}`)
    assert(config.agent[id].prompt, `packed runtime omitted the prompt for ${id}`)
}

const interactive = config.agent[AGENT_IDS.controller.interactive]
assert(interactive.permission.todowrite === "deny", "interactive controller must deny todowrite")
assert(interactive.permission.read === "deny", "interactive controller must deny read")
assert(interactive.permission.glob === "deny", "interactive controller must deny glob")
assert(interactive.permission.grep === "deny", "interactive controller must deny grep")
assert(
    interactive.prompt.includes("FIRST action"),
    "controller prompt lacks first-action guardrail",
)
assert(
    interactive.prompt.includes("specops-assessor"),
    "controller prompt lacks assessor reference",
)
assert(interactive.prompt.includes("Never do"), "controller prompt lacks self-work guardrail")
assert(
    interactive.prompt.includes("collapse, simulate"),
    "controller prompt lacks no-simulation guardrail",
)
assert(!interactive.model, "interactive controller should use OpenCode global default model")

const persistedManifest = manifestModule.validateManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
)
assert(
    Object.keys(persistedManifest.agents).sort().join("|") === [...ALL_AGENT_IDS].sort().join("|"),
    "clean materialisation did not replace the partial manifest",
)

const toolIDs = Object.values(protocolModule.TOOL_IDS)
assert(
    Object.keys(hooks.tool).sort().join("|") === toolIDs.sort().join("|"),
    "packed protocol tool catalogue drifted",
)

const doctorOutput = await hooks.tool[protocolModule.TOOL_IDS.doctor].execute(
    {},
    fakeToolContext(packageDirectory),
)
assert(typeof doctorOutput === "string", "doctor did not return text")
assert(
    doctorOutput.includes(`PASS /specops resolves ${AGENT_IDS.controller.interactive}`),
    "doctor missed interactive resolution",
)
assert(
    doctorOutput.includes(`PASS /specops-auto resolves ${AGENT_IDS.controller.automatic}`),
    "doctor missed automatic resolution",
)
const opencodePresent = spawnSync("opencode", ["--version"], {
    encoding: "utf8",
    detached: true,
})
if (opencodePresent.status === 0) {
    assert(
        doctorOutput.includes("PASS CLI auto available: opencode run --command specops-auto"),
        "doctor missed the supported OpenCode CLI adapter",
    )
}
// else: opencode isn't installed (cloud CI) — skip the opencode-relying
// assertion; the doctor's CLI-adapter FAIL is the correct behaviour there.

// Verify global + project configuration merging in isolation so the main
// smoke project is unaffected by any global settings.
const mergeConfigHome = path.join(temporaryRoot, "merge-config")
const mergeProjectDirectory = path.join(temporaryRoot, "merge-project")
await mkdir(path.join(mergeConfigHome, "opencode"), { recursive: true })
await mkdir(path.join(mergeProjectDirectory, ".opencode"), { recursive: true })
await writeFile(
    path.join(mergeConfigHome, "opencode", "specops.json"),
    `${JSON.stringify({ version: 2, workflow: { defaultTier: "standard" } }, null, 2)}\n`,
)
await writeFile(
    path.join(mergeProjectDirectory, ".opencode", "specops.json"),
    `${JSON.stringify(
        {
            version: 2,
            workflow: { onboarding: "always" },
            automation: { requireCleanWorktree: false },
        },
        null,
        2,
    )}\n`,
)
const openspecModule = await import(
    `${pathToFileURL(path.join(packageDirectory, "dist", "openspec.js")).href}?${randomUUID()}`
)
const previousXdg = process.env.XDG_CONFIG_HOME
process.env.XDG_CONFIG_HOME = mergeConfigHome
let mergedConfig

try {
    mergedConfig = await openspecModule.readConfig(mergeProjectDirectory)
} finally {
    if (previousXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME
    } else {
        process.env.XDG_CONFIG_HOME = previousXdg
    }
}
assert(
    mergedConfig.workflow.defaultTier === "standard",
    "global workflow defaultTier not inherited",
)
assert(
    mergedConfig.workflow.onboarding === "always",
    "project workflow onboarding override not applied",
)
assert(
    mergedConfig.automation.requireCleanWorktree === false,
    "project automation override not applied",
)
assert(mergedConfig.openspec.command === null, "default openspec command not preserved")

const smokeProjectDirectory = path.join(temporaryRoot, "smoke-project")
await mkdir(smokeProjectDirectory, { recursive: true })
await writeFile(path.join(smokeProjectDirectory, "README.md"), "# Packed smoke project\n")
assertProcess(
    spawnSync("git", ["init"], { cwd: smokeProjectDirectory, encoding: "utf8" }),
    "smoke project git init",
)
assertProcess(
    spawnSync("git", ["config", "user.name", "SpecOps Smoke"], {
        cwd: smokeProjectDirectory,
        encoding: "utf8",
    }),
    "smoke project git user",
)
assertProcess(
    spawnSync("git", ["config", "user.email", "specops-smoke@example.invalid"], {
        cwd: smokeProjectDirectory,
        encoding: "utf8",
    }),
    "smoke project git email",
)

const smokeContext = fakeToolContext(smokeProjectDirectory)
const onboardOutput = await hooks.tool[protocolModule.TOOL_IDS.onboard].execute({}, smokeContext)
assert(onboardOutput === "SpecOps final assets installed.", "packed onboarding failed")
assertProcess(
    spawnSync("git", ["add", "."], { cwd: smokeProjectDirectory, encoding: "utf8" }),
    "smoke project git add",
)
assertProcess(
    spawnSync("git", ["commit", "-m", "Initialize smoke project"], {
        cwd: smokeProjectDirectory,
        encoding: "utf8",
    }),
    "smoke project git commit",
)

const assessment = JSON.stringify({
    changeKind: "bugfix",
    expectedFiles: 1,
    expectedModules: 1,
    restoresExistingBehavior: true,
    changesRequirements: false,
    publicContract: "none",
    riskFacets: [],
    touchedSurfaces: [],
    uncertainty: {
        requirements: "high",
        repository: "high",
        design: "high",
        implementation: "high",
        verification: "high",
    },
    suggestedTier: "lean",
    inspectedPaths: ["README.md"],
    unresolvedQuestions: [],
    likelyValidations: [],
    facts: ["Clean packed smoke project."],
    inferences: [],
})
const startSummary = await hooks.tool[protocolModule.TOOL_IDS.startRun].execute(
    {
        goal: "Confirm packed scheduler lifecycle",
        assessment,
        requestedTier: "auto",
        mode: "automatic",
    },
    smokeContext,
)
const changeMatch = startSummary.match(/confirm-packed-scheduler-lifecycle[^\s]*/)
assert(changeMatch, "packed start-run did not return a change name in its summary")
const change = changeMatch[0]

const state = JSON.parse(
    await hooks.tool[protocolModule.TOOL_IDS.getStatus].execute({ change }, smokeContext),
)
assert(state.version === 4, "packed start-run did not persist final state")

const directive = JSON.parse(
    await hooks.tool[protocolModule.TOOL_IDS.nextAction].execute({ change }, smokeContext),
)
assert(
    directive.type === "dispatch" && directive.action?.id,
    "packed scheduler did not issue its first worker action",
)
const firstAction = directive.action
const status = JSON.parse(
    await hooks.tool[protocolModule.TOOL_IDS.getStatus].execute({ change }, smokeContext),
)
assert(
    status.dispatches?.some(
        dispatch => dispatch.id === firstAction.id && dispatch.status === "issued",
    ),
    "packed status did not report first scheduler dispatch",
)

const packagedFiles = await recursiveFiles(packageDirectory)
assert(
    !packagedFiles.some(
        file => file.includes("/src/") || (file.endsWith(".ts") && !file.endsWith(".d.ts")),
    ),
    "source-only TypeScript leaked into packed output",
)
for (const file of packagedFiles.filter(file => /\.(?:js|json|map)$/.test(file))) {
    const content = await readFile(file, "utf8")
    assert(!content.includes(repositoryRoot), `source checkout path leaked into ${file}`)
}

const openCodeSmoke = await runOpenCodeSmoke(
    pathToFileURL(path.join(packageDirectory, "dist", "index.js")).href,
    isolatedConfigHome,
    temporaryRoot,
    smokeProjectDirectory,
    idsModule,
)

process.stderr.write(
    `Packed install smoke passed: ${ALL_AGENT_IDS.length} agents, ${toolIDs.length} tools, manifest ${manifestPath}; ${openCodeSmoke}\n`,
)

function fakePluginInput(directory) {
    return {
        directory,
        worktree: directory,
        project: {},
        client: {},
        serverUrl: new URL("http://127.0.0.1"),
        $() {},
        experimental_workspace: { register() {} },
    }
}

function fakeToolContext(directory) {
    return {
        directory,
        worktree: directory,
        sessionID: "packed-smoke",
        messageID: "packed-smoke",
        agent: "packed-smoke",
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
    }
}

async function recursiveFiles(directory) {
    const files = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === "node_modules") {
            continue
        }
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) {
            files.push(...(await recursiveFiles(target)))
        } else {
            files.push(target)
        }
    }
    return files
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message)
    }
}

function assertProcess(result, label) {
    if (result.status !== 0) {
        const details = [
            `exit=${result.status ?? "none"}`,
            `signal=${result.signal ?? "none"}`,
            result.error ? `error=${result.error.message}` : undefined,
            result.stderr || result.stdout || "no process output",
        ].filter(Boolean)
        throw new Error(`${label} failed: ${details.join("\n")}`)
    }
}

async function runOpenCodeSmoke(
    pluginEntry,
    configHome,
    temporaryDirectory,
    smokeProjectDirectory,
    ids,
) {
    if (process.env.SPECOPS_OPENCODE_SMOKE !== "1") {
        return "real OpenCode smoke available through npm run smoke:opencode"
    }

    const available = spawnSync("opencode", ["--version"], { encoding: "utf8", detached: true })
    if (available.status !== 0) {
        return "OpenCode binary unavailable; packaged hook verification completed"
    }

    const runHelp = spawnSync("opencode", ["run", "--help"], {
        encoding: "utf8",
        detached: true,
        timeout: 10_000,
    })
    assertProcess(runHelp, "OpenCode run help")
    const runHelpOutput = `${runHelp.stdout}\n${runHelp.stderr}`
    assert(
        runHelpOutput.includes("--command") &&
            runHelpOutput.includes("--dir") &&
            runHelpOutput.includes("--format"),
        "OpenCode run help omitted the documented CLI adapter options",
    )

    const openCodeDirectory = path.join(configHome, "opencode")
    const configurationPath = path.join(openCodeDirectory, "opencode.json")
    const smokeHome = path.join(temporaryDirectory, "opencode-home")
    await mkdir(openCodeDirectory, { recursive: true })
    await mkdir(smokeHome, { recursive: true })
    await writeFile(configurationPath, `${JSON.stringify({ plugin: [pluginEntry] }, null, 2)}\n`)
    const environment = {
        ...process.env,
        HOME: smokeHome,
        XDG_CONFIG_HOME: configHome,
        OPENCODE_CONFIG: configurationPath,
    }
    const resolved = spawnSync(
        "opencode",
        ["debug", "config", "--print-logs", "--log-level", "DEBUG"],
        {
            cwd: packageDirectory,
            encoding: "utf8",
            env: environment,
            maxBuffer: 4 * 1024 * 1024,
            detached: true,
            timeout: 30_000,
        },
    )
    if (resolved.status !== 0) {
        const diagnosticOutput = `${resolved.stdout}\n${resolved.stderr}`
        const externalBoundary =
            /failed to fetch models\.dev|unable to connect|network|ECONN|fetch failed/i.test(
                diagnosticOutput,
            )
        if (externalBoundary) {
            const cli = await runAutomaticCli(environment, smokeProjectDirectory, true)
            return `OpenCode ${available.stdout.trim()} reached an external model-catalogue boundary during config resolution; ${cli}`
        }
        assertProcess(resolved, "OpenCode resolved-config smoke")
    }
    assert(
        resolved.stdout.includes(ids.AGENT_IDS.controller.interactive),
        "OpenCode did not resolve the interactive controller",
    )
    assert(
        resolved.stdout.includes(ids.AGENT_IDS.controller.automatic),
        "OpenCode did not resolve the automatic controller",
    )

    for (const controller of Object.values(ids.AGENT_IDS.controller)) {
        const agent = spawnSync("opencode", ["debug", "agent", controller], {
            cwd: packageDirectory,
            encoding: "utf8",
            env: environment,
            maxBuffer: 2 * 1024 * 1024,
            detached: true,
            timeout: 30_000,
        })
        assertProcess(agent, `OpenCode agent resolution for ${controller}`)
        assert(agent.stdout.includes(controller), `OpenCode debug output omitted ${controller}`)
        assert(agent.stdout.includes("primary"), `${controller} is not primary in OpenCode`)
    }

    const cli = await runAutomaticCli(environment, smokeProjectDirectory)
    return `OpenCode ${available.stdout.trim()} resolved both controllers; ${cli}`
}

/**
 * Run the documented CLI adapter until it issues its first deterministic
 * action, or report that the external provider boundary prevented that point.
 */
async function runAutomaticCli(environment, directory, knownExternalBoundary = false) {
    const child = spawn(
        "opencode",
        [
            "run",
            "--command",
            "specops-auto",
            "--dir",
            directory,
            "--format",
            "json",
            "Confirm packed CLI automatic execution",
        ],
        {
            cwd: directory,
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
        },
    )

    let stdout = ""
    let stderr = ""
    let reachedFirstAction = false
    let timedOut = false
    const outputLimit = 2 * 1024 * 1024
    child.stdout.on("data", chunk => {
        stdout = (stdout + chunk.toString()).slice(-outputLimit)
        reachedFirstAction ||= stdout.includes(`"tool":"specops_next_action"`)
        const reachedPendingQuestion = stdout.includes(`"reason":"pending-question"`)
        if (reachedFirstAction && !reachedPendingQuestion) {
            child.kill("SIGINT")
        } else if (reachedPendingQuestion) {
            child.kill("SIGINT")
        }
    })
    child.stderr.on("data", chunk => {
        stderr = (stderr + chunk.toString()).slice(-outputLimit)
    })

    const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGINT")
    }, 30_000)
    const result = await new Promise(resolve => {
        child.on("close", (code, signal) => resolve({ code, signal }))
        child.on("error", error => resolve({ code: null, signal: null, error }))
    })
    clearTimeout(timer)

    const combined = `${stdout}\n${stderr}`
    assert(!combined.includes("command not found"), "CLI could not resolve specops-auto")
    assert(!combined.includes("agent not found"), "CLI could not resolve automatic controller")
    const reachedPendingQuestion = combined.includes(`"reason":"pending-question"`)
    if (reachedFirstAction || reachedPendingQuestion) {
        assert(
            result.signal === "SIGINT" || result.code === 130 || result.code === 0,
            `CLI cancellation was not clean: ${JSON.stringify(result)}`,
        )
        if (reachedPendingQuestion) {
            return "CLI started without TUI and paused for a pending question"
        }
        return "CLI started without TUI and issued its first scheduler action"
    }

    const providerBoundary =
        /auth|credential|network|provider|rate.?limit|timeout|ECONN|fetch failed/i.test(combined) ||
        (timedOut && (knownExternalBoundary || combined.includes(`"type":"step_start"`)))
    assert(
        providerBoundary,
        `CLI did not reach its first action or a recognizable provider boundary${
            timedOut ? " before timeout" : ""
        }:\n${combined.slice(-4_000)}`,
    )
    return "CLI started without TUI and stopped at the external provider boundary"
}

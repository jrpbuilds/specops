import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"))
const packageLock = JSON.parse(
    await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"),
)
const nodeVersion = (await readFile(path.join(repositoryRoot, ".nvmrc"), "utf8")).trim()
const openCodeVersion = packageJson.devDependencies["@opencode-ai/plugin"]
const openSpecVersion = packageJson.dependencies["@fission-ai/openspec"]
const failures = []

assertEqual(packageJson.engines.node, `>=${nodeVersion}`, "package.json Node engine")
assertEqual(
    packageJson.peerDependencies["@opencode-ai/plugin"],
    `>=${openCodeVersion}`,
    "package.json OpenCode peer",
)
assertEqual(
    packageJson.dependencies["@fission-ai/openspec"],
    "1.7.0",
    "package.json OpenSpec dependency",
)

const lockRoot = packageLock.packages?.[""]
assertEqual(lockRoot?.engines?.node, packageJson.engines.node, "lockfile Node engine")
assertEqual(
    lockRoot?.devDependencies?.["@opencode-ai/plugin"],
    openCodeVersion,
    "lockfile OpenCode devDependency",
)
assertEqual(
    lockRoot?.peerDependencies?.["@opencode-ai/plugin"],
    packageJson.peerDependencies["@opencode-ai/plugin"],
    "lockfile OpenCode peer",
)
assertEqual(
    packageLock.packages?.["node_modules/@opencode-ai/plugin"]?.version,
    openCodeVersion,
    "locked OpenCode plugin",
)
assertEqual(
    packageLock.packages?.["node_modules/@opencode-ai/sdk"]?.version,
    openCodeVersion,
    "locked OpenCode SDK",
)
assertEqual(
    packageLock.packages?.["node_modules/@fission-ai/openspec"]?.version,
    openSpecVersion,
    "locked OpenSpec package",
)

const maintainedDocuments = [
    "README.md",
    "docs/getting-started.md",
    "docs/development.md",
    "docs/troubleshooting.md",
    "site/index.html",
]
const currentReferences = [nodeVersion, openCodeVersion, openSpecVersion]
const staleReferences = ["20.19", "1.16.2", "OpenSpec 1.6"]

for (const relativeFile of maintainedDocuments) {
    const source = await readFile(path.join(repositoryRoot, relativeFile), "utf8")
    for (const reference of currentReferences) {
        if (!source.includes(reference)) {
            failures.push(`${relativeFile}: missing supported version ${reference}`)
        }
    }
    for (const reference of staleReferences) {
        if (source.includes(reference)) {
            failures.push(`${relativeFile}: stale compatibility reference ${reference}`)
        }
    }
}

if (failures.length > 0) {
    throw new Error(`Compatibility validation failed:\n${failures.join("\n")}`)
}

process.stdout.write(
    `Compatibility declarations passed: Node ${nodeVersion}, OpenCode ${openCodeVersion}, OpenSpec ${openSpecVersion}.\n`,
)

/**
 * Assert one compatibility declaration and retain all failures for one useful report.
 * @param {unknown} actual - Value read from a package or lockfile declaration.
 * @param {string} expected - Canonical supported value.
 * @param {string} name - Human-readable declaration name.
 */
function assertEqual(actual, expected, name) {
    if (actual !== expected) {
        failures.push(`${name}: expected ${expected}, received ${String(actual)}`)
    }
}

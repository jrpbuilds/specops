import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const openSpecDirectory = path.join(repositoryRoot, "openspec")
const bundledSchemas = path.join(repositoryRoot, "schemas")

// Populate `openspec/` for this repository's own OpenSpec use. The bundled
// schema templates live in `schemas/` (the published source of truth); this
// mirrors the plugin's `onboard()` into the repo's live `openspec/` tree so
// `npm run validate:openspec` and `specops-doctor` work on a fresh checkout.
await mkdir(path.join(openSpecDirectory, "changes"), { recursive: true })
await mkdir(path.join(openSpecDirectory, "specs"), { recursive: true })
for (const schema of ["specops-lean", "specops-standard", "specops"]) {
    const target = path.join(openSpecDirectory, "schemas", schema)
    await mkdir(target, { recursive: true })
    await copyMissing(path.join(bundledSchemas, schema), target)
}

try {
    await stat(path.join(openSpecDirectory, "config.yaml"))
} catch {
    await writeFile(
        path.join(openSpecDirectory, "config.yaml"),
        "schema: specops\nrules:\n  verification:\n    - Record only registry-backed commands.\n",
    )
}

async function copyMissing(source, target) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name)
        const to = path.join(target, entry.name)
        if (entry.isDirectory()) {
            await mkdir(to, { recursive: true })
            await copyMissing(from, to)
            continue
        }
        try {
            await stat(to)
        } catch {
            await copyFile(from, to)
        }
    }
}

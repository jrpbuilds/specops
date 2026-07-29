import { rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// dist is reproducible output. Cleaning it before compilation prevents removed
// source modules from being accidentally included in the published package.
await rm(path.join(repositoryRoot, "dist"), { recursive: true, force: true })

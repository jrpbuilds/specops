import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { validateConfig } from "../src/config.js"

describe("example configuration", () => {
    it("matches the strict current configuration format", async () => {
        const examplePath = path.resolve(import.meta.dirname, "..", "examples", "specops.json")
        const example = JSON.parse(await readFile(examplePath, "utf8"))

        expect(validateConfig(example)).toMatchObject({
            version: 1,
            workflow: { defaultTier: example.workflow.defaultTier },
        })
    })
})

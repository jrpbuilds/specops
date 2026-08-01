import { mkdir, mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { uniqueChangeName } from "../src/openspec.js"

const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

describe("OpenSpec change names", () => {
    it("does not impose the previous 48-character limit", async () => {
        const directory = await temporaryDirectory()
        const name = await uniqueChangeName(directory, "a".repeat(60))

        expect(name).toHaveLength(60)
        expect(name).toMatch(KEBAB_NAME)
    })

    it("bounds generated names at OpenSpec's 200-character limit", async () => {
        const directory = await temporaryDirectory()
        const name = await uniqueChangeName(directory, "a".repeat(250))

        expect(name).toHaveLength(200)
        expect(name).toMatch(KEBAB_NAME)
    })

    it("removes a separator cut off at the length boundary", async () => {
        const directory = await temporaryDirectory()
        const goal = `${"a".repeat(199)} trailing words`
        const name = await uniqueChangeName(directory, goal)

        expect(name).toHaveLength(199)
        expect(name).toMatch(KEBAB_NAME)
        expect(name.endsWith("-")).toBe(false)
    })

    it("reserves space for a collision suffix", async () => {
        const directory = await temporaryDirectory()
        const base = "a".repeat(200)
        await mkdir(path.join(directory, "openspec", "changes", base), { recursive: true })

        const name = await uniqueChangeName(directory, base)

        expect(name.length).toBeLessThanOrEqual(200)
        expect(name).toMatch(KEBAB_NAME)
        expect(name).not.toBe(base)
    })
})

async function temporaryDirectory(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "specops-openspec-name-"))
}

import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

const INSTALL_SCRIPT = path.resolve(import.meta.dirname, "..", "scripts", "install.sh")
const PLUGIN = "@jrpbuilds/specops"

/**
 * Run the repository installer against isolated OpenCode configuration files.
 *
 * @param root - Temporary home and XDG root for the test.
 * @param server - Server configuration path.
 * @param tui - TUI configuration path.
 * @returns Installer standard output.
 */
function runInstaller(root: string, server: string, tui: string): string {
    return execFileSync("bash", [INSTALL_SCRIPT], {
        encoding: "utf8",
        env: {
            ...process.env,
            HOME: root,
            XDG_CONFIG_HOME: path.join(root, "xdg"),
            OPENCODE_CONFIG: server,
            OPENCODE_TUI_CONFIG: tui,
        },
    })
}

/**
 * Provide a temporary directory and remove it after the test callback finishes.
 *
 * @param callback - Test work to execute inside the temporary directory.
 * @returns The callback result.
 */
async function withTemporaryDirectory<T>(callback: (root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(path.join(os.tmpdir(), "specops-install-"))
    try {
        return await callback(root)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

describe("installer", () => {
    it("registers server and TUI plugins idempotently", async () => {
        await withTemporaryDirectory(async root => {
            const server = path.join(root, "opencode.json")
            const tui = path.join(root, "tui.json")
            await writeFile(
                server,
                JSON.stringify({ plugin: ["other"], share: "disabled" }),
                "utf8",
            )
            await writeFile(
                tui,
                JSON.stringify({ plugins: ["other-tui"], animations: true }),
                "utf8",
            )

            const firstOutput = runInstaller(root, server, tui)
            runInstaller(root, server, tui)

            const serverConfig = JSON.parse(await readFile(server, "utf8")) as {
                plugin: string[]
            }
            const tuiConfig = JSON.parse(await readFile(tui, "utf8")) as {
                plugins: string[]
            }
            expect(serverConfig.plugin).toEqual(["other", PLUGIN])
            expect(tuiConfig.plugins).toEqual(["other-tui", PLUGIN])
            expect(firstOutput).toContain("first load")
            expect(firstOutput).toContain("specops-manifest.json")
        })
    })

    it("preserves the current singular TUI plugin key", async () => {
        await withTemporaryDirectory(async root => {
            const server = path.join(root, "opencode.json")
            const tui = path.join(root, "tui.json")
            await writeFile(tui, JSON.stringify({ plugin: ["other-tui"] }), "utf8")

            runInstaller(root, server, tui)

            const config = JSON.parse(await readFile(tui, "utf8")) as {
                plugin: string[]
                plugins?: string[]
            }
            expect(config.plugin).toEqual(["other-tui", PLUGIN])
            expect(config).not.toHaveProperty("plugins")
        })
    })
})

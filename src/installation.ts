import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Config } from "@opencode-ai/plugin"
import { ALL_AGENT_IDS } from "./capabilities/ids.js"
import {
    DEFAULT_MANIFEST,
    isLegacyManifest,
    manifestAgentConfig,
    validateManifest,
    type SpecOpsManifest,
} from "./manifest.js"

/** Result of loading or materialising the agent model manifest. */
export type ManifestMaterialisation = {
    status: "ready" | "upgrade-required"
    manifest: SpecOpsManifest
    path: string
    replacedInvalidFile: boolean
}

/** Read-only manifest state used by diagnostics and the TUI editor. */
export type ManifestInspection =
    | {
          status: "ready"
          manifest: SpecOpsManifest
          path: string
          contentHash: string
      }
    | {
          status: "upgrade-required"
          legacy: { version: 1; agents: Record<string, unknown> }
          path: string
          contentHash: string
      }
    | { status: "invalid"; path: string; reason: string; contentHash?: string }

/** Error raised when a settings editor would overwrite a newer file. */
export class ManifestConflictError extends Error {
    constructor() {
        super("the SpecOps manifest changed after the editor was opened")
        this.name = "ManifestConflictError"
    }
}

/** Resolve OpenCode's configuration directory using its XDG convention. */
function resolveOpenCodeConfigDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = os.homedir(),
): string {
    return environment.XDG_CONFIG_HOME
        ? path.join(environment.XDG_CONFIG_HOME, "opencode")
        : path.join(homeDirectory, ".config", "opencode")
}

/** Resolve the global user-editable SpecOps manifest path. */
export function resolveManifestPath(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = os.homedir(),
): string {
    return path.join(
        resolveOpenCodeConfigDirectory(environment, homeDirectory),
        "specops-manifest.json",
    )
}

/**
 * Load a v2 manifest, preserve a legacy v1 file, or repair other invalid data.
 *
 * A legacy file is never rewritten here. The current session safely receives
 * packaged v2 defaults and the TUI is responsible for a deliberate upgrade.
 */
export async function materializeAgentManifest(
    destination: string = resolveManifestPath(),
): Promise<ManifestMaterialisation> {
    try {
        const parsed = JSON.parse(await readFile(destination, "utf8")) as unknown
        if (isLegacyManifest(parsed)) {
            return {
                status: "upgrade-required",
                manifest: structuredClone(DEFAULT_MANIFEST),
                path: destination,
                replacedInvalidFile: false,
            }
        }
        try {
            return {
                status: "ready",
                manifest: validateManifest(parsed),
                path: destination,
                replacedInvalidFile: false,
            }
        } catch {
            await writeManifestAtomically(destination, DEFAULT_MANIFEST)
            return {
                status: "ready",
                manifest: structuredClone(DEFAULT_MANIFEST),
                path: destination,
                replacedInvalidFile: true,
            }
        }
    } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT"
        await writeManifestAtomically(destination, DEFAULT_MANIFEST)
        return {
            status: "ready",
            manifest: structuredClone(DEFAULT_MANIFEST),
            path: destination,
            replacedInvalidFile: !missing,
        }
    }
}

/** Inspect the persisted manifest without repairing or rewriting it. */
export async function inspectAgentManifest(
    destination: string = resolveManifestPath(),
): Promise<ManifestInspection> {
    try {
        const raw = await readFile(destination, "utf8")
        const contentHash = hashContent(raw)
        const parsed = JSON.parse(raw) as unknown
        if (isLegacyManifest(parsed)) {
            return {
                status: "upgrade-required",
                legacy: parsed,
                path: destination,
                contentHash,
            }
        }
        try {
            return {
                status: "ready",
                manifest: validateManifest(parsed),
                path: destination,
                contentHash,
            }
        } catch (error) {
            return {
                status: "invalid",
                path: destination,
                contentHash,
                reason: error instanceof Error ? error.message : String(error),
            }
        }
    } catch (error) {
        return {
            status: "invalid",
            path: destination,
            reason:
                (error as NodeJS.ErrnoException).code === "ENOENT"
                    ? "file does not exist"
                    : error instanceof Error
                      ? error.message
                      : String(error),
        }
    }
}

/**
 * Validate and atomically save settings if the file is still the inspected
 * revision.
 */
export async function saveAgentManifest(
    manifest: SpecOpsManifest,
    expectedContentHash: string | undefined,
    destination: string = resolveManifestPath(),
): Promise<void> {
    validateManifest(manifest)
    let currentHash: string | undefined
    try {
        currentHash = hashContent(await readFile(destination, "utf8"))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (currentHash !== expectedContentHash) throw new ManifestConflictError()
    await writeManifestAtomically(destination, manifest)
}

/** Register every canonical agent while preserving external registrations. */
export function registerManifestAgents(config: Config, manifest: SpecOpsManifest): void {
    config.agent ??= {}
    for (const id of ALL_AGENT_IDS) {
        config.agent[id] ??= manifestAgentConfig(id, manifest.agents[id])
    }
}

/** Hash exact on-disk content for optimistic concurrency control. */
function hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex")
}

/** Persist a validated manifest through a same-directory atomic rename. */
async function writeManifestAtomically(
    destination: string,
    manifest: SpecOpsManifest,
): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true })
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    await rename(temporary, destination)
}

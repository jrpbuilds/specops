import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Config } from "@opencode-ai/plugin"
import { ALL_AGENT_IDS } from "./capabilities/ids.js"
import {
    DEFAULT_MANIFEST,
    manifestAgentConfig,
    migrateLegacyFrontierManifest,
    validateManifest,
    type SpecOpsManifest,
} from "./manifest.js"

/**
 * Result of loading or cleanly materialising the final agent manifest.
 *
 * `replacedInvalidFile` is `true` when an existing file was found but was
 * invalid and was replaced with the default manifest.
 */
export type ManifestMaterialisation = {
    manifest: SpecOpsManifest
    path: string
    replacedInvalidFile: boolean
}

/**
 * Read-only manifest inspection result used by doctor and smoke tests.
 *
 * Discriminated by `valid`: when `true`, the full parsed manifest is
 * available; when `false`, `reason` explains why inspection failed.
 */
export type ManifestInspection =
    | { valid: true; manifest: SpecOpsManifest; path: string }
    | { valid: false; path: string; reason: string }

/**
 * Resolve OpenCode's configuration directory using the same XDG convention as
 * OpenCode itself. An explicit path makes tests and development installs
 * hermetic without touching a user's real configuration.
 *
 * When `XDG_CONFIG_HOME` is set the directory is
 * `$XDG_CONFIG_HOME/opencode`; otherwise it falls back to
 * `~/.config/opencode`.
 *
 * @param environment - Process environment (defaults to `process.env`).
 * @param homeDirectory - User home directory (defaults to `os.homedir()`).
 * @returns Absolute path to the OpenCode configuration directory.
 */
function resolveOpenCodeConfigDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = os.homedir(),
): string {
    return environment.XDG_CONFIG_HOME
        ? path.join(environment.XDG_CONFIG_HOME, "opencode")
        : path.join(homeDirectory, ".config", "opencode")
}

/**
 * Resolve the user-editable final manifest path.
 *
 * The manifest file lives at `<opencode-config>/specops-manifest.json`.
 *
 * @param environment - Process environment (defaults to `process.env`).
 * @param homeDirectory - User home directory (defaults to `os.homedir()`).
 * @returns Absolute path to the manifest JSON file.
 */
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
 * Load an exact final manifest, upgrade the immediately preceding catalogue,
 * or atomically replace another invalid/partial file.
 *
 * The exact pre-frontier catalogue receives a targeted additive upgrade that
 * preserves its existing model and provider settings while adding the two
 * frontier agents. No removed ID is translated or retained. If the file is
 * missing it is created from {@link DEFAULT_MANIFEST}; any other invalid file
 * is overwritten and `replacedInvalidFile` is set in the result.
 *
 * @param destination - Absolute path to the manifest file; defaults to
 * {@link resolveManifestPath}.
 * @returns The materialised manifest and its path, with `replacedInvalidFile`
 * indicating whether an existing invalid file was overwritten.
 */
export async function materializeAgentManifest(
    destination: string = resolveManifestPath(),
): Promise<ManifestMaterialisation> {
    try {
        const parsed = JSON.parse(await readFile(destination, "utf8")) as unknown
        try {
            const manifest = validateManifest(parsed)
            return { manifest, path: destination, replacedInvalidFile: false }
        } catch {
            const migrated = migrateLegacyFrontierManifest(parsed)
            if (migrated) {
                await writeManifestAtomically(destination, migrated)
                return { manifest: migrated, path: destination, replacedInvalidFile: false }
            }
            throw new Error("invalid SpecOps manifest")
        }
    } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT"
        await writeManifestAtomically(destination, DEFAULT_MANIFEST)
        return {
            manifest: structuredClone(DEFAULT_MANIFEST),
            path: destination,
            replacedInvalidFile: !missing,
        }
    }
}

/**
 * Inspect the persisted manifest without repairing or rewriting it.
 *
 * Reads and validates the manifest, returning a discriminated result: on
 * success the parsed manifest is included; on failure (missing file or
 * validation error) a `reason` explains why.
 *
 * @param destination - Absolute path to the manifest file; defaults to
 * {@link resolveManifestPath}.
 * @returns A {@link ManifestInspection} indicating success or failure.
 */
export async function inspectAgentManifest(
    destination: string = resolveManifestPath(),
): Promise<ManifestInspection> {
    try {
        const manifest = validateManifest(JSON.parse(await readFile(destination, "utf8")))
        return { valid: true, manifest, path: destination }
    } catch (error) {
        return {
            valid: false,
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
 * Register every final agent in the configuration object OpenCode resolves.
 *
 * Iterates {@link ALL_AGENT_IDS} and assigns each a configuration built by
 * {@link manifestAgentConfig}, leaving any pre-existing user-provided
 * entry (`??=`) untouched so external registrations win.
 *
 * @param config - OpenCode configuration object whose `agent` map is updated
 * in place.
 * @param manifest - Materialised manifest supplying per-agent entries.
 */
export function registerManifestAgents(config: Config, manifest: SpecOpsManifest): void {
    config.agent ??= {}
    for (const id of ALL_AGENT_IDS) {
        config.agent[id] ??= manifestAgentConfig(id, manifest.agents[id])
    }
}

/**
 * Write the manifest to `destination` atomically by writing a temp file and
 * renaming it, so a crash mid-write cannot leave a partial manifest.
 *
 * @param destination - Absolute path to the final manifest file.
 * @param manifest - Manifest to persist.
 */
async function writeManifestAtomically(
    destination: string,
    manifest: SpecOpsManifest,
): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true })
    const temporary = `${destination}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    await rename(temporary, destination)
}

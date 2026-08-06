import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Config } from "@opencode-ai/plugin";
import { ALL_AGENT_IDS, AGENT_IDS, type AgentId } from "./agents/ids.js";
import { AGENT_REGISTRY } from "./agents/registry.js";
import type { SpecOpsConfig } from "./config.js";
import {
    DEFAULT_MANIFEST,
    manifestAgentConfig,
    validateManifest,
    type SpecOpsManifest,
} from "./agents/manifest.js";

type AgentConfig = NonNullable<NonNullable<Config["agent"]>[string]>;
type AgentPermissionConfig = NonNullable<AgentConfig["permission"]>;

/** Result of loading or materialising the agent model manifest. */
export type ManifestMaterialisation = {
    status: "ready";
    manifest: SpecOpsManifest;
    path: string;
    replacedInvalidFile: boolean;
    migratedFromV2: boolean;
    migrationWarnings: readonly string[];
};

/** Read-only manifest state used by diagnostics and the TUI editor. */
export type ManifestInspection =
    | {
          status: "ready";
          manifest: SpecOpsManifest;
          path: string;
          contentHash: string;
      }
    | { status: "invalid"; path: string; reason: string; contentHash?: string };

/** Error raised when a settings editor would overwrite a newer file. */
export class ManifestConflictError extends Error {
    constructor() {
        super("the SpecOps manifest changed after the editor was opened");
        this.name = "ManifestConflictError";
    }
}

/** Resolve OpenCode's configuration directory using its XDG convention. */
function resolveOpenCodeConfigDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = os.homedir(),
): string {
    return environment.XDG_CONFIG_HOME
        ? path.join(environment.XDG_CONFIG_HOME, "opencode")
        : path.join(homeDirectory, ".config", "opencode");
}

/** Resolve the global user-editable SpecOps manifest path. */
export function resolveManifestPath(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = os.homedir(),
): string {
    return path.join(
        resolveOpenCodeConfigDirectory(environment, homeDirectory),
        "specops-manifest.json",
    );
}

/** Resolve the global user-editable SpecOps configuration path. */
export function resolveGlobalConfigPath(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = os.homedir(),
): string {
    return path.join(resolveOpenCodeConfigDirectory(environment, homeDirectory), "specops.json");
}

/**
 * Load a valid current manifest, or reset invalid/missing data to defaults.
 *
 * Only the current manifest version is accepted; any other file is treated as
 * invalid and replaced with packaged defaults.
 */
export async function materializeAgentManifest(
    destination: string = resolveManifestPath(),
): Promise<ManifestMaterialisation> {
    try {
        const parsed = JSON.parse(await readFile(destination, "utf8"));
        return {
            status: "ready",
            manifest: validateManifest(parsed),
            path: destination,
            replacedInvalidFile: false,
            migratedFromV2: false,
            migrationWarnings: [],
        };
    } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        if (!missing) {
            try {
                const legacy = JSON.parse(await readFile(destination, "utf8"));
                const migration = migrateV2Manifest(legacy);
                if (migration) {
                    await writeManifestAtomically(destination, migration.manifest);
                    return {
                        status: "ready",
                        manifest: migration.manifest,
                        path: destination,
                        replacedInvalidFile: true,
                        migratedFromV2: true,
                        migrationWarnings: migration.warnings,
                    };
                }
            } catch {
                // Invalid JSON or a non-V2 shape is replaced with V3 defaults below.
            }
        }
        await writeManifestAtomically(destination, DEFAULT_MANIFEST);
        return {
            status: "ready",
            manifest: structuredClone(DEFAULT_MANIFEST),
            path: destination,
            replacedInvalidFile: !missing,
            migratedFromV2: false,
            migrationWarnings: [],
        };
    }
}

/** Result of migrating the former 24-agent model manifest to V3. */
export type ManifestMigration = { manifest: SpecOpsManifest; warnings: readonly string[] };

/**
 * Migrate unambiguous V2 model selections without carrying permissions or
 * step policy into V3. A conflicting legacy frontier selection is deliberately
 * left at the OpenCode default and reported to the caller.
 */
export function migrateV2Manifest(value: unknown): ManifestMigration | undefined {
    if (!isRecord(value) || value.version !== 2 || !isRecord(value.agents)) return undefined;
    const legacy = value.agents;
    const agents = structuredClone(DEFAULT_MANIFEST.agents);
    const warnings: string[] = [];
    const mappings: Record<AgentId, readonly string[]> = {
        [AGENT_IDS.coordinator]: ["specops-interactive-controller"],
        [AGENT_IDS.explorer]: ["specops-explorer"],
        [AGENT_IDS.planner]: ["specops-planner"],
        [AGENT_IDS.designer]: ["specops-designer"],
        [AGENT_IDS.implementer]: ["specops-implementer"],
        [AGENT_IDS.reviewer]: ["specops-risk-reviewer"],
        [AGENT_IDS.frontier]: ["specops-frontier-low", "specops-frontier-high"],
    };

    for (const id of ALL_AGENT_IDS) {
        const selections = mappings[id]
            .map(legacyID => manifestEntry(legacy[legacyID]))
            .filter((entry): entry is SpecOpsManifest["agents"][AgentId] => entry !== undefined);
        const distinct = new Map(selections.map(entry => [JSON.stringify(entry), entry]));
        if (distinct.size === 1) {
            agents[id] = distinct.values().next().value as SpecOpsManifest["agents"][AgentId];
        } else if (distinct.size > 1) {
            warnings.push(`${id}: legacy mappings conflict; using the OpenCode default model`);
        }
    }
    return { manifest: { version: 3, agents }, warnings };
}

/** Inspect the persisted manifest without repairing or rewriting it. */
export async function inspectAgentManifest(
    destination: string = resolveManifestPath(),
): Promise<ManifestInspection> {
    try {
        const raw = await readFile(destination, "utf8");
        const contentHash = hashContent(raw);
        try {
            return {
                status: "ready",
                manifest: validateManifest(JSON.parse(raw)),
                path: destination,
                contentHash,
            };
        } catch (error) {
            return {
                status: "invalid",
                path: destination,
                contentHash,
                reason: error instanceof Error ? error.message : String(error),
            };
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
        };
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
    validateManifest(manifest);
    let currentHash: string | undefined;
    try {
        currentHash = hashContent(await readFile(destination, "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (currentHash !== expectedContentHash) throw new ManifestConflictError();
    await writeManifestAtomically(destination, manifest);
}

/** Return OpenCode's wildcard for every tool exposed by one MCP server. */
function mcpToolPattern(serverName: string): string {
    return `${serverName.replace(/[^a-zA-Z0-9_-]/g, "_")}_*`;
}

/** Build MCP permission rules for the effective OpenCode server catalogue. */
function mcpPermissionRules(
    config: Config,
    mcpPolicy: SpecOpsConfig["integrations"]["mcp"],
): Record<string, "allow" | "deny"> {
    const action = mcpPolicy === "disabled" ? "deny" : "allow";
    const servers = config.mcp ?? {};
    return Object.fromEntries(
        Object.entries(servers)
            .filter(([, entry]) => entry?.enabled !== false)
            .map(([serverName]) => [mcpToolPattern(serverName), action]),
    );
}

/** Read an existing agent permission object without changing its shape. */
function existingAgentPermission(agent: unknown): AgentPermissionConfig {
    if (typeof agent !== "object" || agent === null || !("permission" in agent)) return {};
    const permission = (agent as { permission?: unknown }).permission;
    return typeof permission === "object" && permission !== null
        ? (permission as AgentPermissionConfig)
        : {};
}

/**
 * Register canonical agents while preserving external registrations.
 *
 * MCP rules are derived from OpenCode's effective server catalogue so they
 * match the server-prefixed tool ids OpenCode exposes at runtime. Allow mode
 * applies policy-owned allowances before existing permissions (so a host-level
 * MCP denial cannot block SpecOps workers); disabled mode applies policy-owned
 * denials after existing permissions. Other agent settings remain user- or
 * host-owned.
 */
export function registerManifestAgents(
    config: Config,
    manifest: SpecOpsManifest,
    mcpPolicy: SpecOpsConfig["integrations"]["mcp"] = "allow",
): void {
    config.agent ??= {};
    const mcpRules = mcpPermissionRules(config, mcpPolicy);
    for (const id of ALL_AGENT_IDS) {
        const agent = manifestAgentConfig(id, manifest.agents[id]);
        if (AGENT_REGISTRY[id].mode !== "subagent" || Object.keys(mcpRules).length === 0) {
            config.agent[id] = agent;
            continue;
        }

        const existingPermission = existingAgentPermission(agent);
        config.agent[id] = {
            ...agent,
            permission:
                mcpPolicy === "disabled"
                    ? ({ ...existingPermission, ...mcpRules } as AgentPermissionConfig)
                    : ({ ...mcpRules, ...existingPermission } as AgentPermissionConfig),
        };
    }
}

/** Narrow unknown JSON to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Retain only model and variant fields supported by the V3 manifest. */
function manifestEntry(value: unknown): SpecOpsManifest["agents"][AgentId] | undefined {
    if (!isRecord(value) || typeof value.model !== "string" || !value.model.trim())
        return undefined;
    return {
        model: value.model,
        ...(typeof value.variant === "string" && value.variant.trim()
            ? { variant: value.variant }
            : {}),
    };
}

/** Hash exact on-disk content for optimistic concurrency control. */
function hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

/** Persist a validated manifest through a same-directory atomic rename. */
async function writeManifestAtomically(
    destination: string,
    manifest: SpecOpsManifest,
): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
}

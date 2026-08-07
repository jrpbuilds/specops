import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Config } from "@opencode-ai/plugin";
import { ALL_AGENT_IDS, AGENT_IDS, type AgentId } from "./agents/ids.js";
import { AGENT_REGISTRY } from "./agents/registry.js";
import {
    DEFAULT_MANIFEST,
    manifestAgentConfig,
    validateManifest,
    type SpecOpsManifest,
} from "./agents/manifest.js";
import { writeFileAtomic } from "./state/atomic.js";

type AgentConfig = NonNullable<NonNullable<Config["agent"]>[string]>;
type AgentPermissionConfig = NonNullable<AgentConfig["permission"]>;

/** Strict persisted configuration consumed only by active V1 integration code. */
export type V1Configuration = {
    version: 1;
    models: Record<AgentId, { model?: string; variant?: string }>;
    openspec: { command: string[] | null };
    validation: {
        commands: Array<{
            id: string;
            executable: string;
            args: string[];
            cwd?: string;
            timeoutMs: number;
            maxOutputBytes: number;
        }>;
    };
    integrations: { mcp: "allow" | "disabled" };
};

/** Report emitted exactly when a legacy configuration file is migrated. */
export type ConfigurationMigrationReport = { path: string; removedFields: readonly string[] };

/** Default V1 choices defer models and validation policy to explicit users. */
export const DEFAULT_V1_CONFIGURATION: V1Configuration = {
    version: 1,
    models: Object.fromEntries(ALL_AGENT_IDS.map(id => [id, {}])) as V1Configuration["models"],
    openspec: { command: null },
    validation: { commands: [] },
    integrations: { mcp: "allow" },
};

let configurationMigrationReports: ConfigurationMigrationReport[] = [];

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

/** Load the merged V1 configuration after one-time migration of recognised V2 files. */
export async function loadV1Configuration(directory: string): Promise<V1Configuration> {
    const reports = await migrateV1Configuration(directory);
    configurationMigrationReports = reports;
    const [global, project] = await Promise.all([
        readV1ConfigurationFile(resolveGlobalConfigPath()),
        readV1ConfigurationFile(path.join(directory, ".opencode", "specops.json")),
    ]);
    return mergeV1Configuration(global, project);
}

/** Return and clear the reports created by the most recent migration attempt. */
export function consumeConfigurationMigrationReports(): ConfigurationMigrationReport[] {
    const reports = configurationMigrationReports;
    configurationMigrationReports = [];
    return reports;
}

/** Migrate each recognised legacy SpecOps configuration exactly once. */
export async function migrateV1Configuration(
    directory: string,
): Promise<ConfigurationMigrationReport[]> {
    const reports = await Promise.all([
        migrateV1ConfigurationFile(resolveGlobalConfigPath()),
        migrateV1ConfigurationFile(path.join(directory, ".opencode", "specops.json")),
    ]);
    return reports.filter((report): report is ConfigurationMigrationReport => report !== undefined);
}

/** Strictly validate one V1 configuration without retaining obsolete fields. */
export function validateV1Configuration(value: unknown): V1Configuration {
    if (!isRecord(value) || value.version !== 1)
        throw new Error("invalid V1 SpecOps configuration version");
    if (!hasOnlyKeys(value, ["version", "models", "openspec", "validation", "integrations"])) {
        throw new Error("invalid V1 SpecOps configuration field");
    }
    if (
        !isRecord(value.models) ||
        Object.keys(value.models).sort().join("|") !== [...ALL_AGENT_IDS].sort().join("|")
    ) {
        throw new Error("invalid V1 SpecOps model mappings");
    }
    for (const id of ALL_AGENT_IDS) {
        const model = value.models[id];
        if (
            !isRecord(model) ||
            !hasOnlyKeys(model, ["model", "variant"]) ||
            (model.model !== undefined &&
                (typeof model.model !== "string" || !model.model.trim())) ||
            (model.variant !== undefined &&
                (typeof model.variant !== "string" || !model.variant.trim()))
        ) {
            throw new Error(`invalid V1 model mapping for ${id}`);
        }
    }
    if (
        !isRecord(value.openspec) ||
        !hasOnlyKeys(value.openspec, ["command"]) ||
        (value.openspec.command !== null &&
            (!Array.isArray(value.openspec.command) ||
                value.openspec.command.some(item => typeof item !== "string" || !item)))
    ) {
        throw new Error("invalid V1 OpenSpec command configuration");
    }
    if (
        !isRecord(value.validation) ||
        !hasOnlyKeys(value.validation, ["commands"]) ||
        !Array.isArray(value.validation.commands)
    ) {
        throw new Error("invalid V1 validation configuration");
    }
    for (const command of value.validation.commands) validateV1Command(command);
    if (
        !isRecord(value.integrations) ||
        !hasOnlyKeys(value.integrations, ["mcp"]) ||
        (value.integrations.mcp !== "allow" && value.integrations.mcp !== "disabled")
    ) {
        throw new Error("invalid V1 MCP integration configuration");
    }
    return structuredClone(value) as V1Configuration;
}

/** Migrate a V2 file atomically; current V1 and unrelated files remain untouched. */
export async function migrateV1ConfigurationFile(
    destination: string,
): Promise<ConfigurationMigrationReport | undefined> {
    let raw: unknown;
    try {
        raw = JSON.parse(await readFile(destination, "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error(
            `cannot migrate SpecOps configuration ${destination}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (isRecord(raw) && raw.version === 1) {
        validateV1Configuration(raw);
        return undefined;
    }
    if (!isRecord(raw) || raw.version !== 2) {
        throw new Error(
            `unsupported existing SpecOps configuration at ${destination}; it was not modified`,
        );
    }
    const removedFields = legacyConfigurationFields(raw);
    const migrated = validateV1Configuration({
        version: 1,
        models: structuredClone(DEFAULT_V1_CONFIGURATION.models),
        openspec: { command: legacyCommand(raw) },
        validation: { commands: [] },
        integrations: { mcp: legacyMcp(raw) },
    });
    await writeFileAtomic(destination, `${JSON.stringify(migrated, null, 2)}\n`);
    return { path: destination, removedFields };
}

/** Read an optional V1 file; a missing file contributes no override. */
async function readV1ConfigurationFile(destination: string): Promise<V1Configuration | undefined> {
    try {
        return validateV1Configuration(JSON.parse(await readFile(destination, "utf8")));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

/** Merge dedicated global and project configuration preserving only V1 choices. */
function mergeV1Configuration(
    global: V1Configuration | undefined,
    project: V1Configuration | undefined,
): V1Configuration {
    const base = global ?? DEFAULT_V1_CONFIGURATION;
    const override = project;
    return validateV1Configuration({
        version: 1,
        models: { ...base.models, ...(override?.models ?? {}) },
        openspec: override?.openspec ?? base.openspec,
        validation: override?.validation ?? base.validation,
        integrations: override?.integrations ?? base.integrations,
    });
}

/** Validate one shell-free required validation command. */
function validateV1Command(value: unknown): void {
    if (
        !isRecord(value) ||
        !hasOnlyKeys(value, ["id", "executable", "args", "cwd", "timeoutMs", "maxOutputBytes"]) ||
        typeof value.id !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,127}$/.test(value.id) ||
        typeof value.executable !== "string" ||
        !value.executable ||
        !Array.isArray(value.args) ||
        value.args.some(arg => typeof arg !== "string") ||
        (value.cwd !== undefined &&
            (typeof value.cwd !== "string" ||
                value.cwd.startsWith("/") ||
                value.cwd.split(/[\\/]/).includes(".."))) ||
        !Number.isInteger(value.timeoutMs) ||
        (value.timeoutMs as number) <= 0 ||
        !Number.isInteger(value.maxOutputBytes) ||
        (value.maxOutputBytes as number) <= 0
    ) {
        throw new Error("invalid V1 validation command");
    }
}

/** Extract all known retired configuration fields for explicit migration reporting. */
function legacyConfigurationFields(value: Record<string, unknown>): string[] {
    return [
        "workflow",
        "routing",
        "automation",
        "escalation",
        "frontier",
        "review",
        "openspec.autoArchive",
    ]
        .filter(field =>
            field === "openspec.autoArchive"
                ? isRecord(value.openspec) && "autoArchive" in value.openspec
                : field in value,
        )
        .sort();
}

/** Preserve the only legacy values that remain genuine V1 user choices. */
function legacyCommand(value: Record<string, unknown>): string[] | null {
    const command = isRecord(value.openspec) ? value.openspec.command : undefined;
    return Array.isArray(command) && command.every(item => typeof item === "string" && item)
        ? [...command]
        : null;
}

/** Preserve the only legacy integration toggle retained by V1. */
function legacyMcp(value: Record<string, unknown>): "allow" | "disabled" {
    const mcp = isRecord(value.integrations) ? value.integrations.mcp : undefined;
    return mcp === "disabled" ? "disabled" : "allow";
}

/** Narrow a plain JSON configuration object. */
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key));
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
    mcpPolicy: "allow" | "disabled",
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
    mcpPolicy: "allow" | "disabled" = "allow",
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

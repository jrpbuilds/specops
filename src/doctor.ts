import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_AGENT_IDS } from "./agents/ids.js";
import { AGENT_REGISTRY, agentPrompt } from "./agents/registry.js";
import { OpenSpecAdapter } from "./openspec/adapter.js";
import { renderPrompt } from "./prompts/renderer.js";
import { LegacyRunStateError, readV1Run } from "./state/store.js";
import {
    consumeConfigurationMigrationReports,
    inspectAgentManifest,
    resolveManifestPath,
} from "./installation.js";
import { loadV1Configuration } from "./config/loader.js";
import { runProcess } from "./process.js";

/** Severity classes used by V1 diagnostics. */
type DoctorLevel = "error" | "warning" | "info";

/** One actionable, bounded installation diagnostic. */
export type DoctorDiagnostic = {
    level: DoctorLevel;
    message: string;
    remediation?: string;
};

/** Injectable command and OpenSpec boundaries used by focused doctor tests. */
export type DoctorDependencies = {
    adapter?: {
        version(): Promise<string>;
        schemas(): Promise<Array<{ name: string }>>;
    };
    openCodeVersion?: () => Promise<string>;
    resolveConfiguration?: (directory: string) => Promise<unknown>;
    manifestPath?: string;
    packageRoot?: string;
};

/**
 * Run V1 architecture diagnostics and return structured results for command
 * rendering. The optional legacy config argument is accepted only to preserve
 * the public function signature during the explicit Phase 8 migration.
 */
void doctor;
async function doctor(directory: string): Promise<string> {
    return formatDoctorDiagnostics(await collectDoctorDiagnostics(directory));
}

/** Execute all specification-required V1 installation and project checks. */
export async function collectDoctorDiagnostics(
    directory: string,
    dependencies: DoctorDependencies = {},
): Promise<DoctorDiagnostic[]> {
    const diagnostics: DoctorDiagnostic[] = [];
    const adapter = dependencies.adapter ?? (await buildConfiguredAdapter(directory));
    const packageRoot = dependencies.packageRoot ?? packageDirectory();

    await checkOpenCode(diagnostics, dependencies.openCodeVersion ?? defaultOpenCodeVersion);
    await checkOpenSpec(diagnostics, adapter);
    await checkPackageSchemas(diagnostics, packageRoot);
    await checkProjectSchema(diagnostics, directory);
    checkAgentRegistration(diagnostics);
    checkPrompts(diagnostics);
    await checkManifest(diagnostics, dependencies.manifestPath ?? resolveManifestPath());
    await checkConfiguration(
        diagnostics,
        directory,
        dependencies.resolveConfiguration ?? loadV1Configuration,
    );
    for (const report of consumeConfigurationMigrationReports()) {
        diagnostics.push({
            level: "warning",
            message: `migrated legacy configuration ${report.path}; removed fields: ${report.removedFields.join(", ") || "none"}`,
        });
    }
    await checkWritablePaths(diagnostics, directory);
    await checkLegacySchemas(diagnostics, directory);
    await checkLegacyRuns(diagnostics, directory);
    return diagnostics;
}

/** Render diagnostics with explicit severity and practical remediation. */
export function formatDoctorDiagnostics(diagnostics: readonly DoctorDiagnostic[]): string {
    return diagnostics
        .map(item => {
            const line = `${item.level.toUpperCase()} ${item.message}`;
            return item.remediation ? `${line}\n  Remediation: ${item.remediation}` : line;
        })
        .join("\n");
}

/** Verify OpenCode is present and reports a version. */
async function checkOpenCode(
    diagnostics: DoctorDiagnostic[],
    version: () => Promise<string>,
): Promise<void> {
    try {
        const detected = await version();
        if (!detected.trim()) throw new Error("empty version output");
        diagnostics.push({ level: "info", message: `OpenCode available (${detected.trim()})` });
    } catch (error) {
        diagnostics.push({
            level: "error",
            message: `OpenCode is unavailable or did not report a version: ${message(error)}`,
            remediation: "Install a supported OpenCode release and restart the plugin.",
        });
    }
}

/** Check the supported OpenSpec range and its standard JSON schema interface. */
async function checkOpenSpec(
    diagnostics: DoctorDiagnostic[],
    adapter: NonNullable<DoctorDependencies["adapter"]>,
): Promise<void> {
    try {
        const version = await adapter.version();
        diagnostics.push({ level: "info", message: `OpenSpec ${version} is compatible` });
    } catch (error) {
        diagnostics.push({
            level: "error",
            message: `OpenSpec compatibility check failed: ${message(error)}`,
            remediation: "Install OpenSpec >=1.7.0 <1.8.0 and rerun /specops-doctor.",
        });
        return;
    }
    try {
        const schemas = await adapter.schemas();
        if (!schemas.some(schema => schema.name === "spec-driven")) {
            throw new Error("the standard spec-driven schema is unavailable");
        }
        diagnostics.push({
            level: "info",
            message: "OpenSpec JSON schema interface provides spec-driven",
        });
    } catch (error) {
        diagnostics.push({
            level: "error",
            message: `OpenSpec schema interface check failed: ${message(error)}`,
            remediation: "Reinstall the supported OpenSpec 1.7 release.",
        });
    }
}

/** Confirm the package itself no longer bundles a required custom schema. */
async function checkPackageSchemas(
    diagnostics: DoctorDiagnostic[],
    packageRoot: string,
): Promise<void> {
    const schemas = await names(path.join(packageRoot, "schemas"));
    const custom = schemas.filter(name => /^specops(?:-|$)/.test(name));
    diagnostics.push(
        custom.length
            ? {
                  level: "error",
                  message: `package still bundles custom SpecOps schemas: ${custom.join(", ")}`,
                  remediation: "Reinstall a clean SpecOps 1.0 package.",
              }
            : { level: "info", message: "package requires no custom SpecOps schema" },
    );
}

/** Require the active project to use standard upstream spec-driven semantics. */
async function checkProjectSchema(
    diagnostics: DoctorDiagnostic[],
    directory: string,
): Promise<void> {
    try {
        const config = await readFile(path.join(directory, "openspec", "config.yaml"), "utf8");
        if (!/^schema:\s*spec-driven\s*$/m.test(config))
            throw new Error("schema is not spec-driven");
        diagnostics.push({ level: "info", message: "project OpenSpec schema is spec-driven" });
    } catch (error) {
        diagnostics.push({
            level: "error",
            message: `project OpenSpec schema is unsupported: ${message(error)}`,
            remediation:
                "Run /specops-onboard for a standard project; do not overwrite custom schemas.",
        });
    }
}

/** Check exact agent registrations and their owned permission policy. */
function checkAgentRegistration(diagnostics: DoctorDiagnostic[]): void {
    const missing = ALL_AGENT_IDS.filter(id => !AGENT_REGISTRY[id]);
    diagnostics.push(
        missing.length
            ? {
                  level: "error",
                  message: `missing V1 agent registrations: ${missing.join(", ")}`,
                  remediation: "Reinstall SpecOps.",
              }
            : {
                  level: "info",
                  message: "all seven V1 agents and permission policies are registered",
              },
    );
}

/** Load every packaged prompt and prove its simple placeholders render strictly. */
function checkPrompts(diagnostics: DoctorDiagnostic[]): void {
    try {
        for (const id of ALL_AGENT_IDS) {
            const prompt = agentPrompt(id);
            const trusted: Record<string, string> = {};
            const untrusted: Record<string, string> = {};
            for (const match of prompt.matchAll(
                /\{\{(?:(trusted|untrusted):)?([a-zA-Z][a-zA-Z0-9_]*)\}\}/g,
            )) {
                (match[1] === "untrusted" ? untrusted : trusted)[match[2]] = "diagnostic";
            }
            renderPrompt(prompt, { trusted, untrusted });
        }
        diagnostics.push({
            level: "info",
            message: "all seven packaged prompts load and render strictly",
        });
    } catch (error) {
        diagnostics.push({
            level: "error",
            message: `prompt-file check failed: ${message(error)}`,
            remediation: "Reinstall the package so every prompts/*.md asset is present.",
        });
    }
}

/** Validate the user-owned seven-role model manifest without rewriting it. */
async function checkManifest(diagnostics: DoctorDiagnostic[], manifestPath: string): Promise<void> {
    const inspection = await inspectAgentManifest(manifestPath);
    diagnostics.push(
        inspection.status === "ready"
            ? { level: "info", message: `seven-role model manifest is valid (${inspection.path})` }
            : {
                  level: "warning",
                  message: `model manifest requires V1 migration or repair: ${inspection.reason}`,
                  remediation:
                      "Restart SpecOps to run the one-time migration, then rerun /specops-doctor.",
              },
    );
}

/** Run the active strict configuration loader and surface invalid values. */
async function checkConfiguration(
    diagnostics: DoctorDiagnostic[],
    directory: string,
    resolve: (directory: string) => Promise<unknown>,
): Promise<void> {
    try {
        await resolve(directory);
        diagnostics.push({
            level: "info",
            message: "SpecOps configuration passed strict validation",
        });
    } catch (error) {
        diagnostics.push({
            level: "error",
            message: `SpecOps configuration is invalid: ${message(error)}`,
            remediation: "Correct the reported configuration field and rerun /specops-doctor.",
        });
    }
}

/** Ensure managed state and standard OpenSpec change paths can be written. */
async function checkWritablePaths(
    diagnostics: DoctorDiagnostic[],
    directory: string,
): Promise<void> {
    const paths = [path.join(directory, ".specops"), path.join(directory, "openspec", "changes")];
    for (const target of paths) {
        try {
            await access(target, constants.W_OK);
            diagnostics.push({ level: "info", message: `writable path: ${target}` });
        } catch {
            diagnostics.push({
                level: "error",
                message: `required path is not writable: ${target}`,
                remediation:
                    "Create the standard project directories and grant the current user write access.",
            });
        }
    }
}

/** Warn about user-project legacy schemas without deleting or modifying them. */
async function checkLegacySchemas(
    diagnostics: DoctorDiagnostic[],
    directory: string,
): Promise<void> {
    const legacy = (await names(path.join(directory, "openspec", "schemas"))).filter(name =>
        /^specops(?:-|$)/.test(name),
    );
    if (legacy.length) {
        diagnostics.push({
            level: "warning",
            message: `legacy SpecOps schemas detected in this project: ${legacy.join(", ")}`,
            remediation: "SpecOps 1.0 uses standard spec-driven and leaves these files untouched.",
        });
    }
}

/** Detect incompatible previous run state without trying to translate it. */
async function checkLegacyRuns(diagnostics: DoctorDiagnostic[], directory: string): Promise<void> {
    for (const change of await names(path.join(directory, ".specops", "runs"))) {
        try {
            await readV1Run(directory, change);
        } catch (error) {
            if (error instanceof LegacyRunStateError) {
                diagnostics.push({
                    level: "warning",
                    message: `legacy SpecOps run state detected for ${change}; it cannot resume in V1`,
                    remediation: "Keep the existing artifacts and begin a fresh V1 run when ready.",
                });
            }
        }
    }
}

/** Return directory entry names, treating an absent optional directory as empty. */
async function names(directory: string): Promise<string[]> {
    try {
        return (await readdir(directory)).sort();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
}

/** Execute the host command shell-free for the compatibility presence check. */
async function defaultOpenCodeVersion(): Promise<string> {
    const result = await runProcess("opencode", ["--version"], process.cwd());
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "command failed");
    return result.stdout;
}

/**
 * Build the OpenSpec adapter using the configured OpenSpec command override
 * so doctor diagnostics are deterministic with respect to V1 configuration.
 * Falls back to the default adapter when configuration cannot be loaded.
 */
async function buildConfiguredAdapter(directory: string): Promise<OpenSpecAdapter> {
    try {
        const configuration = await loadV1Configuration(directory);
        return new OpenSpecAdapter({
            directory,
            command: configuration.openspec.command,
        });
    } catch {
        return new OpenSpecAdapter({ directory });
    }
}

/** Resolve the source or packed package root without caller-controlled paths. */
function packageDirectory(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** Preserve useful errors while avoiding accidental non-Error formatting. */
function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Native OpenCode TUI editor for SpecOps agent model and variant mappings.
 */
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { ALL_AGENT_IDS, type AgentId } from "./agents/ids.js";
import { inspectAgentManifest, ManifestConflictError, saveAgentManifest } from "./installation.js";
import {
    agentSettingsCategory,
    clearConfiguredModel,
    configuredModels,
    createManifestDraft,
    selectConfiguredModel,
    validateManifestSelections,
    type ConfiguredModel,
} from "./model-settings.js";
import { DEFAULT_MANIFEST, type SpecOpsManifest } from "./agents/manifest.js";

const COMMAND_NAME = "specops.models.configure";
const BACK = Symbol("specops-back");

/**
 * Register the command-palette entry for the agent model editor.
 */
export function registerModelSettings(api: TuiPluginApi): void {
    let editorOpen = false;

    /** Open the model editor once, guarding against re-entrant launches. */
    const openEditor = async (): Promise<void> => {
        if (editorOpen) return;
        editorOpen = true;
        try {
            await showModelEditor(api, () => {
                editorOpen = false;
            });
        } catch (error) {
            editorOpen = false;
            api.ui.toast({
                variant: "error",
                title: "SpecOps model settings",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    };

    const unregisterCommand = api.keymap.registerLayer({
        commands: [
            {
                namespace: "palette",
                name: COMMAND_NAME,
                title: "SpecOps: Configure agent models",
                desc: "Choose a configured OpenCode model and variant for each agent",
                category: "SpecOps",
                run: openEditor,
            },
        ],
    });

    api.lifecycle.onDispose(unregisterCommand);
}

/**
 * Open a staged, callback-driven dropdown editor and save only after review.
 */
async function showModelEditor(api: TuiPluginApi, onClose: () => void): Promise<void> {
    const inspection = await inspectAgentManifest();
    const models = configuredModels(api.state.provider);
    if (!models.length) {
        onClose();
        api.ui.toast({
            variant: "error",
            title: "SpecOps model settings",
            message: "OpenCode has no configured models to select.",
        });
        return;
    }

    const source = inspection.status === "ready" ? inspection.manifest : DEFAULT_MANIFEST;
    const expectedContentHash = inspection.contentHash;
    const draft = createManifestDraft(source, models);
    const initial = structuredClone(draft.manifest);
    let staged = structuredClone(draft.manifest);

    let closed = false;
    /** Mark the editor closed exactly once, idempotently. */
    const finish = (): void => {
        if (closed) return;
        closed = true;
        onClose();
    };
    /** Clear the dialog surface and finish the editor. */
    const close = (): void => {
        api.ui.dialog.clear();
        finish();
    };

    /** Surface manifest validation issues and return to the agent list on confirm. */
    const showIssues = (issues: readonly string[]): void => {
        api.ui.dialog.replace(() =>
            api.ui.DialogAlert({
                title: "Complete the model mapping",
                message: issues.join("\n"),
                onConfirm: showAgents,
            }),
        );
    };

    /** Validate the staged mapping and persist it once if the on-disk hash is unchanged. */
    const save = async (): Promise<void> => {
        const issues = validateManifestSelections(staged, models);
        if (issues.length) {
            showIssues(issues);
            return;
        }
        try {
            await saveAgentManifest(staged, expectedContentHash);
            close();
            api.ui.toast({
                variant: "success",
                title: "SpecOps model settings saved",
                message: "Restart or reload OpenCode to apply the new agent mappings.",
            });
        } catch (error) {
            if (error instanceof ManifestConflictError) {
                api.ui.dialog.replace(() =>
                    api.ui.DialogAlert({
                        title: "Settings changed on disk",
                        message:
                            "SpecOps did not overwrite the newer manifest. Reopen the editor to review it.",
                        onConfirm: close,
                    }),
                );
                return;
            }
            throw error;
        }
    };

    /** Show the save-confirmation dialog, or issues, before persisting. */
    const showReview = (): void => {
        const issues = validateManifestSelections(staged, models);
        if (issues.length) {
            showIssues(issues);
            return;
        }
        const changed = changedAgentIds(initial, staged).length;
        api.ui.dialog.replace(() =>
            api.ui.DialogConfirm({
                title: "Save SpecOps model mappings?",
                message: [
                    `Schema v3 will contain all ${ALL_AGENT_IDS.length} roles.`,
                    `${changed} agent selection${changed === 1 ? "" : "s"} changed.`,
                    "Workflow steps, prompts, tools, and permissions remain managed by SpecOps.",
                ].join("\n"),
                onConfirm: save,
                onCancel: showAgents,
            }),
        );
    };

    /** Pick a variant for the selected model, or clear it to the model default. */
    const showVariant = (id: AgentId, model: ConfiguredModel): void => {
        const variants = ["", ...model.variants];
        api.ui.dialog.replace(() =>
            api.ui.DialogSelect<string | typeof BACK>({
                title: `${id}: variant`,
                placeholder: "Search variants",
                current: staged.agents[id].variant ?? "",
                options: [
                    ...variants.map(variant => ({
                        title: variant || "Default",
                        value: variant,
                        description: variant
                            ? `OpenCode variant ${variant}`
                            : "Use the model's default variant",
                    })),
                    {
                        title: "Back to models",
                        value: BACK,
                        description: "Choose a different model for this agent",
                    },
                ],
                onSelect: option => {
                    if (option.value === BACK) {
                        showModels(id);
                        return;
                    }
                    staged.agents[id] = {
                        model: staged.agents[id].model,
                        ...(option.value ? { variant: option.value } : {}),
                    };
                    showAgents();
                },
            }),
        );
    };

    /** Pick a configured model (or OpenCode's global default) for one agent. */
    const showModels = (id: AgentId): void => {
        api.ui.dialog.replace(() =>
            api.ui.DialogSelect<string | typeof BACK>({
                title: `${id}: model`,
                placeholder: "Search configured models",
                current: staged.agents[id].model,
                options: [
                    {
                        title: "Use OpenCode default",
                        value: "",
                        description: "Use OpenCode's configured global default model",
                    },
                    ...models.map(model => ({
                        title: model.name,
                        value: model.id,
                        category: model.providerName,
                        description: model.id,
                    })),
                    {
                        title: "Back to agents",
                        value: BACK,
                        description: "Return without changing this agent",
                    },
                ],
                onSelect: option => {
                    if (option.value === BACK) {
                        showAgents();
                        return;
                    }
                    if (option.value === "") {
                        staged.agents[id] = clearConfiguredModel(staged.agents[id]);
                        showAgents();
                        return;
                    }
                    const selected = models.find(model => model.id === option.value);
                    if (!selected) return;
                    staged.agents[id] = selectConfiguredModel(staged.agents[id], selected);
                    showVariant(id, selected);
                },
            }),
        );
    };

    /** Render the staged agent mapping list with review and cancel actions. */
    const showAgents = (): void => {
        api.ui.dialog.setSize("xlarge");
        const unresolved = new Set(
            validateManifestSelections(staged, models).map(issue => issue.split(":")[0]),
        );
        const changed = new Set(changedAgentIds(initial, staged));
        const agentOptions = ALL_AGENT_IDS.map(id => ({
            title: `${unresolved.has(id) ? "⚠ " : ""}${changed.has(id) ? "✓ " : ""}${id}`,
            value: id,
            category: agentSettingsCategory(id),
            footer: describeSelection(staged, id, models),
        }));
        api.ui.dialog.replace(
            () =>
                api.ui.DialogSelect({
                    title: "SpecOps agent model mappings",
                    placeholder: "Search agent IDs",
                    options: [
                        ...agentOptions,
                        {
                            title: "Review and save",
                            value: "__save__",
                            category: "Actions",
                            description: "Validate all mappings and write schema v3 once",
                            footer: `${changed.size} changed`,
                        },
                        {
                            title: "Cancel",
                            value: "__cancel__",
                            category: "Actions",
                            description: "Discard staged changes",
                        },
                    ],
                    onSelect: option => {
                        if (option.value === "__save__") {
                            showReview();
                        } else if (option.value === "__cancel__") {
                            close();
                        } else {
                            showModels(option.value as AgentId);
                        }
                    },
                }),
            finish,
        );
    };

    showAgents();
}

/** Describe one staged model mapping compactly in the agent list. */
function describeSelection(
    manifest: SpecOpsManifest,
    id: AgentId,
    models: readonly ConfiguredModel[],
): string {
    const entry = manifest.agents[id];
    if (!entry.model?.trim()) {
        return "OpenCode default";
    }
    const name = models.find(model => model.id === entry.model)?.name ?? entry.model;
    const compactName = name.length > 28 ? `${name.slice(0, 27)}…` : name;
    return `${compactName} · ${entry.variant ?? "Default"}`;
}

/** Return agents whose staged model or variant differs from the opened draft. */
function changedAgentIds(initial: SpecOpsManifest, staged: SpecOpsManifest): readonly AgentId[] {
    return ALL_AGENT_IDS.filter(
        id => JSON.stringify(initial.agents[id]) !== JSON.stringify(staged.agents[id]),
    );
}

/** SpecOps TUI plugin module registered with OpenCode's plugin manager. */
const SpecOpsTuiPlugin = {
    id: "specops",
    tui: async api => {
        registerModelSettings(api);
    },
} satisfies TuiPluginModule;

export default SpecOpsTuiPlugin;

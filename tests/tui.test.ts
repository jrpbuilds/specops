import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_IDS, ALL_AGENT_IDS } from "../src/agents/ids.js";
import { resolveManifestPath } from "../src/installation.js";
import { DEFAULT_MANIFEST, validateManifest } from "../src/agents/manifest.js";
import { registerModelSettings } from "../src/tui.js";

type SelectOption = {
    title: string;
    value: string;
    category?: string;
    description?: string;
    footer?: string;
};
type SelectDialog = {
    title: string;
    options: SelectOption[];
    onSelect?: (option: SelectOption) => void;
};
type ConfirmDialog = {
    title: string;
    onConfirm?: () => void | Promise<void>;
    onCancel?: () => void;
};
type AlertDialog = { title: string; message: string; onConfirm?: () => void };
type Command = {
    namespace?: string;
    name: string;
    title?: string;
    desc?: string;
    category?: string;
    run: () => void | Promise<void>;
};
type Layer = { commands: Command[] };

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(() => {
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
});

describe.sequential("SpecOps model settings TUI", () => {
    it("registers a native command and saves a complete v3 mapping", async () => {
        const harness = await createHarness(DEFAULT_MANIFEST);
        registerModelSettings(harness.api);

        expect(harness.layer.commands.map(command => command.name)).toContain(
            "specops.models.configure",
        );
        expect(harness.layer.commands[0]).toMatchObject({
            namespace: "palette",
            title: "SpecOps: Configure agent models",
            desc: "Choose a configured OpenCode model and variant for each agent",
            category: "SpecOps",
        });

        await harness.layer.commands[0].run();
        const agents = harness.rendered as SelectDialog;
        expect(agents.title).toBe("SpecOps agent model mappings");
        expect(harness.dialogSize).toBe("xlarge");
        expect(agents.options[0]).toMatchObject({
            title: ALL_AGENT_IDS[0],
            category: "Coordination",
            footer: expect.stringContaining("default"),
        });
        expect(agents.options.find(option => option.value === AGENT_IDS.frontier)).toMatchObject({
            category: "Frontier",
        });
        agents.onSelect?.(agents.options[0]);

        const model = harness.rendered as SelectDialog;
        const custom = model.options.find(option => option.value === "configured/custom");
        if (!custom) throw new Error("missing custom model");
        model.onSelect?.(custom);

        const variant = harness.rendered as SelectDialog;
        const high = variant.options.find(option => option.value === "high");
        if (!high) throw new Error("missing high variant");
        variant.onSelect?.(high);

        const updatedAgents = harness.rendered as SelectDialog;
        expect(updatedAgents.options[0]).toMatchObject({
            title: `✓ ${ALL_AGENT_IDS[0]}`,
            category: "Coordination",
            footer: "custom · high",
        });
        const review = updatedAgents.options.find(option => option.value === "__save__");
        if (!review) throw new Error("missing review option");
        updatedAgents.onSelect?.(review);
        expect((harness.rendered as ConfirmDialog).title).toBe("Save SpecOps model mappings?");
        await (harness.rendered as ConfirmDialog).onConfirm?.();

        const persisted = validateManifest(
            JSON.parse(await readFile(harness.manifestPath, "utf8")),
        );
        expect(persisted.version).toBe(3);
        expect(Object.keys(persisted.agents)).toHaveLength(ALL_AGENT_IDS.length);
        expect(persisted.agents[ALL_AGENT_IDS[0]]).toEqual({
            model: "configured/custom",
            variant: "high",
        });
        expect(harness.toasts.at(-1)?.message).toContain("Restart or reload OpenCode");
    });

    it("discards staged edits when cancelled", async () => {
        const harness = await createHarness(DEFAULT_MANIFEST);
        const before = await readFile(harness.manifestPath, "utf8");
        registerModelSettings(harness.api);

        await harness.layer.commands[0].run();
        expect(harness.toasts).toEqual([]);
        const agents = harness.rendered as SelectDialog;
        const cancel = agents.options.find(option => option.value === "__cancel__");
        if (!cancel) throw new Error("missing cancel option");
        agents.onSelect?.(cancel);

        expect(await readFile(harness.manifestPath, "utf8")).toBe(before);
    });

    it("refuses to overwrite a concurrently modified manifest", async () => {
        const harness = await createHarness(DEFAULT_MANIFEST);
        registerModelSettings(harness.api);
        await harness.layer.commands[0].run();

        const newer = structuredClone(DEFAULT_MANIFEST);
        newer.agents[ALL_AGENT_IDS[1]] = { model: "configured/custom", variant: "high" };
        const newerBytes = `${JSON.stringify(newer, null, 2)}\n`;
        await writeFile(harness.manifestPath, newerBytes);

        const agents = harness.rendered as SelectDialog;
        const review = agents.options.find(option => option.value === "__save__");
        if (!review) throw new Error("missing review option");
        agents.onSelect?.(review);
        await (harness.rendered as ConfirmDialog).onConfirm?.();

        expect((harness.rendered as AlertDialog).title).toBe("Settings changed on disk");
        expect(await readFile(harness.manifestPath, "utf8")).toBe(newerBytes);
    });
});

/** Build a deterministic fake of the pinned OpenCode TUI surface. */
async function createHarness(initial: unknown): Promise<{
    api: TuiPluginApi;
    layer: Layer;
    events: Map<string, () => void | Promise<void>>;
    manifestPath: string;
    rendered: unknown;
    toasts: Array<{ message: string }>;
    dialogSize: string;
}> {
    const home = await mkdtemp(path.join(os.tmpdir(), "specops-tui-"));
    process.env.XDG_CONFIG_HOME = path.join(home, "config");
    const manifestPath = resolveManifestPath();
    await writeFileEnsuringDirectory(manifestPath, `${JSON.stringify(initial, null, 2)}\n`);

    const state: {
        layer: Layer;
        rendered: unknown;
        toasts: Array<{ message: string }>;
        dialogSize: string;
    } = { layer: { commands: [] }, rendered: undefined, toasts: [], dialogSize: "medium" };
    const events = new Map<string, () => void | Promise<void>>();
    const api = {
        keymap: {
            registerLayer(layer: Layer) {
                state.layer = layer;
                return () => undefined;
            },
        },
        event: {
            on(type: string, handler: () => void | Promise<void>) {
                events.set(type, handler);
                return () => undefined;
            },
        },
        lifecycle: { onDispose: () => () => undefined },
        state: { provider: configuredProviders() },
        ui: {
            DialogSelect(props: unknown) {
                return props;
            },
            DialogConfirm(props: unknown) {
                return props;
            },
            DialogAlert(props: unknown) {
                return props;
            },
            toast(input: { message: string }) {
                state.toasts.push(input);
            },
            dialog: {
                replace(render: () => unknown) {
                    state.rendered = render();
                },
                clear() {
                    state.rendered = undefined;
                },
                setSize(size: string) {
                    state.dialogSize = size;
                },
            },
        },
    } as unknown as TuiPluginApi;

    return {
        api,
        get layer() {
            return state.layer;
        },
        events,
        manifestPath,
        get rendered() {
            return state.rendered;
        },
        toasts: state.toasts,
        get dialogSize() {
            return state.dialogSize;
        },
    };
}

/** Expose every configured packaged default plus one editable model with two variants. */
function configuredProviders(): unknown[] {
    const modelIDs = new Set(
        ALL_AGENT_IDS.map(id => DEFAULT_MANIFEST.agents[id].model).filter(
            (model): model is string => Boolean(model),
        ),
    );
    modelIDs.add("configured/custom");
    const providers = new Map<string, Record<string, unknown>>();
    for (const fullID of modelIDs) {
        const separator = fullID.indexOf("/");
        const providerID = fullID.slice(0, separator);
        const modelID = fullID.slice(separator + 1);
        const models = providers.get(providerID) ?? {};
        models[modelID] = {
            id: modelID,
            providerID,
            name: modelID,
            variants: { high: {}, low: {} },
        };
        providers.set(providerID, models);
    }
    return [...providers].map(([id, models]) => ({ id, name: id, models }));
}

/** Write a fixture after creating its isolated OpenCode config directory. */
async function writeFileEnsuringDirectory(destination: string, content: string): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
}

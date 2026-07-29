/**
 * OpenCode TUI companion for SpecOps.
 *
 * The server entry point owns SpecOps commands, tools, and agents. This small
 * companion registers the package with OpenCode's Plugins menu so users can
 * discover and manage its TUI lifecycle alongside other installed plugins.
 */
import type { TuiPluginModule } from "@opencode-ai/plugin/tui"

/**
 * SpecOps TUI plugin module registered with OpenCode's Plugins menu.
 *
 * `id` is the canonical plugin identifier shared with the server entry; `tui`
 * is a no-op lifecycle hook because SpecOps does not own a TUI surface.
 */
const SpecOpsTuiPlugin = {
    /** Canonical plugin identifier shared with the server entry point. */
    id: "specops",
    /** No-op TUI lifecycle hook; SpecOps owns no TUI surface. */
    tui: async () => {},
} satisfies TuiPluginModule

export default SpecOpsTuiPlugin

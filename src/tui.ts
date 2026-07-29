/**
 * OpenCode TUI companion for SpecOps.
 *
 * The server entry point owns SpecOps commands, tools, and agents. This small
 * companion registers the package with OpenCode's Plugins menu so users can
 * discover and manage its TUI lifecycle alongside other installed plugins.
 */
import type { TuiPluginModule } from "@opencode-ai/plugin/tui"

const SpecOpsTuiPlugin = {
  id: "specops",
  tui: async () => {},
} satisfies TuiPluginModule

export default SpecOpsTuiPlugin

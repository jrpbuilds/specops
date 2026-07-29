#!/usr/bin/env bash
# SpecOps one-line installer.
#
# Adds @jrpbuilds/specops to OpenCode's server and TUI plugin configuration.
# Idempotent: running it again is a no-op. OpenCode's Bun runtime handles the
# actual npm install/update on the next launch, so this script only edits config.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jrpbuilds/specops/master/scripts/install.sh | bash
#
# Environment:
#   OPENCODE_CONFIG  Path to the opencode.json to edit. Defaults to:
#                    - ./opencode.json in the current directory if it exists
#                    - otherwise $XDG_CONFIG_HOME/opencode/opencode.json
#                      (or ~/.config/opencode/opencode.json)
#   OPENCODE_TUI_CONFIG Path to the TUI tui.json to edit. Defaults to
#                    ~/.config/opencode/tui.json.
#
# Requirements: Node.js 20.19+ (always present when OpenCode is installed).

set -euo pipefail

PLUGIN="@jrpbuilds/specops"
CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
OPENCODE_CONFIG_DIR="${CONFIG_HOME}/opencode"

# Resolve the target config file.
if [ -n "${OPENCODE_CONFIG:-}" ]; then
  CONFIG="$OPENCODE_CONFIG"
elif [ -f "opencode.json" ]; then
  CONFIG="opencode.json"
else
  CONFIG="${OPENCODE_CONFIG_DIR}/opencode.json"
fi

TUI_CONFIG="${OPENCODE_TUI_CONFIG:-${OPENCODE_CONFIG_DIR}/tui.json}"

mkdir -p "$(dirname "$CONFIG")"
mkdir -p "$(dirname "$TUI_CONFIG")"

# Use a Node one-liner to safely merge the package into the server and TUI
# configs. Node is always available because OpenCode requires Node 20.19+.
node -e '
  const fs = require("node:fs");
  const [serverPath, tuiPath, plugin] = process.argv.slice(1);
  const load = (path) => {
    try {
      const value = JSON.parse(fs.readFileSync(path, "utf-8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  };
  const add = (config, key) => {
    const plugins = Array.isArray(config[key]) ? config[key] : [];
    if (!plugins.includes(plugin)) plugins.push(plugin);
    config[key] = plugins;
  };
  const save = (path, config) => fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");

  const server = load(serverPath);
  add(server, "plugin");
  save(serverPath, server);

  const tui = load(tuiPath);
  add(tui, Array.isArray(tui.plugin) ? "plugin" : "plugins");
  save(tuiPath, tui);
' "$CONFIG" "$TUI_CONFIG" "$PLUGIN"

# Create the directory for the user-editable manifest so the plugin can write
# the default on first load without a race.
mkdir -p "${OPENCODE_CONFIG_DIR}"

cat <<EOF

SpecOps plugin registered in:
  - $CONFIG (server commands, tools, and agents)
  - $TUI_CONFIG (Plugins menu)

Next steps:
  1. Launch opencode in any project directory.
  2. On first load, the plugin writes the default agent manifest to:
     ${OPENCODE_CONFIG_DIR}/specops-manifest.json
     Use "SpecOps: Configure agent models" in the OpenCode command palette to
     choose configured models and variants. Workflow policy always comes from
     the packaged registry. The mapping persists across plugin updates.
  3. Restart or reload OpenCode after saving, then try: /specops-doctor
     Then: /specops-auto add a focused health endpoint with tests and documentation

To update SpecOps later, just re-run this script (no-op if already installed)
or bump the version in your opencode.json plugin array. OpenCode's Bun runtime
handles npm installs/updates automatically on launch.
EOF

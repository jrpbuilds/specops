#!/usr/bin/env bash
# SpecOps one-line installer.
#
# Adds @jrpbuilds/specops to the OpenCode plugin array in opencode.json.
# Idempotent: running it again is a no-op. OpenCode's Bun runtime handles the
# actual npm install/update on the next launch, so this script only edits config.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jrpbuilds/specops/master/scripts/install.sh | bash
#
# Environment:
#   OPENCODE_CONFIG  Path to the opencode.json to edit. Defaults to:
#                    - ./opencode.json in the current directory if it exists
#                    - otherwise ~/.config/opencode/opencode.json
#
# Requirements: Node.js 20.19+ (always present when OpenCode is installed).

set -euo pipefail

PLUGIN="@jrpbuilds/specops"

# Resolve the target config file.
if [ -n "${OPENCODE_CONFIG:-}" ]; then
  CONFIG="$OPENCODE_CONFIG"
elif [ -f "opencode.json" ]; then
  CONFIG="opencode.json"
else
  CONFIG="${HOME}/.config/opencode/opencode.json"
fi

mkdir -p "$(dirname "$CONFIG")"

# Use a Node one-liner to safely merge the plugin entry into the JSON config.
# Node is always available because OpenCode requires Node 20.19+. This avoids
# a hard dependency on jq and handles the cases where the file is missing or
# has no "plugin" array yet.
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const plugin = process.argv[2];
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path, "utf-8"));
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new Error("not an object");
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      config = {};
    } else if (error.code === "ENOENT" || error.message === "not an object") {
      config = {};
    } else {
      config = {};
    }
  }
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  if (!plugins.includes(plugin)) {
    plugins.push(plugin);
  }
  config.plugin = plugins;
  fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
  console.log(plugins.includes(plugin) && plugins.length === (config.plugin.length)
    ? "Added " + plugin + " to " + path
    : "Updated " + path);
' "$CONFIG" "$PLUGIN"

# Create the directory for the user-editable manifest so the plugin can write
# the default on first load without a race.
mkdir -p "${HOME}/.config/opencode"

cat <<EOF

SpecOps plugin reference added to: $CONFIG

Next steps:
  1. Launch opencode in any project directory.
  2. On first load, the plugin writes the default agent manifest to:
     ~/.config/opencode/specops-manifest.json
     Edit this file to customize agent models and permissions. It persists
     across plugin updates.
  3. Try it with: /specops-doctor
     Then: /specops-auto add a focused health endpoint with tests and documentation

To update SpecOps later, just re-run this script (no-op if already installed)
or bump the version in your opencode.json plugin array. OpenCode's Bun runtime
handles npm installs/updates automatically on launch.
EOF

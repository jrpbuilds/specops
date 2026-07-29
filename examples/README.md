# SpecOps project configuration examples

These files are templates for the per-project SpecOps runtime policy. Copy
them into your project's `.opencode/` directory to customize SpecOps behavior
for that project. The plugin reads them from `<project>/.opencode/`.

## Files

- `specops.json` — Runtime policy: workflow tier thresholds, automation gates,
  review limits, and MCP integration mode. Copy to `.opencode/specops.json`
  in your project and edit as needed. When this file is missing, SpecOps uses
  safe defaults from `DEFAULT_CONFIG` in `src/core.ts`.
- `specops.schema.json` — JSON Schema for `specops.json`. Reference it from
  your `specops.json` via `"$schema"` for editor validation:
  ```json
  { "$schema": "./specops.schema.json", ... }
  ```

## Usage

```bash
mkdir -p .opencode
cp examples/specops.json .opencode/specops.json
cp examples/specops.schema.json .opencode/specops.schema.json
```

These are project-level files; they are not part of the npm package and are
not required to use SpecOps. The agent manifest (models, steps, permissions)
lives separately at `~/.config/opencode/specops-manifest.json` and is managed
by the plugin on first load.

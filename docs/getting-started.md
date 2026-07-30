# Getting started

## Requirements

- OpenCode 1.16.2 or newer;
- Node.js 20.19 or newer;
- a Git repository with at least one baseline commit;
- OpenSpec assets installed by SpecOps.

## Published installation

Install through OpenCode:

```bash
opencode plugin @jrpbuilds/specops -g
```

Restart OpenCode after installation. During plugin load, SpecOps automatically materialises
`specops-manifest.json` in OpenCode's configuration directory and registers all controllers and
workers in the resolved configuration.

## Repository onboarding

From the project you want to modify:

```text
/specops-onboard
/specops-doctor
```

Onboarding installs three final OpenSpec schemas under `openspec/schemas/` without overwriting
existing project files. Doctor should report:

- valid project configuration;
- readable package metadata;
- exact final manifest;
- both public controller mappings;
- installed OpenCode support for `run --command`, `--dir`, and `--format`;
- all workers as subagents;
- complete capability and prompt resolution;
- all three OpenSpec schemas.

## First run

Choose an execution experience:

```text
/specops add a health endpoint with tests
/specops-auto add a health endpoint with tests
```

Interactive mode presents bounded unresolved questions. Automatic mode pauses
the same run instead of asking, but routing and worker stages remain identical.
A successful Lean run uses four total task calls: assessment, compact planning,
implementation, and bundled verification.

For CI, scripts, schedules, and agent machines, run that same automatic command without opening
the TUI:

```bash
opencode run --command specops-auto --dir /path/to/project \
  "add a health endpoint with tests"
```

Add `--format json` for raw NDJSON events. OpenCode receives the goal as its positional message;
SpecOps does not install another executable or define private CLI flags.

## Model assignments

After first load, edit:

```text
$XDG_CONFIG_HOME/opencode/specops-manifest.json
```

or `~/.config/opencode/specops-manifest.json` when XDG configuration is unset.

Open `SpecOps: Configure agent models` from OpenCode's command palette. Select an agent, one of
OpenCode's configured provider/model entries, and either **Default** or a variant exposed by that
model. Review the complete mapping and save it once.

The schema-v2 manifest accepts exactly `model` and optional `variant` for every canonical agent.
Workflow steps, prompts, tools, permissions, and modes remain registry-owned. Restart or reload
OpenCode and run `/specops-doctor` after saving.

If an existing schema-v1 manifest is detected, the mapping screen opens once per launch. SpecOps
preserves the old file until you save and uses packaged defaults for that session. Available legacy
model choices are carried forward; unavailable choices visibly require a replacement.

## Development installation

```bash
npm install
npm run generate
npm run check
```

For a local OpenCode configuration, point the plugin array at the built entry:

```json
{
    "plugin": ["file:///absolute/path/to/specops/dist/index.js"]
}
```

Use an isolated `XDG_CONFIG_HOME` while developing. The automated packed smoke test follows this
same path with an extracted npm tarball, not source imports:

```bash
npm run smoke:opencode
```

To reinstall, rebuild and restart OpenCode. For published installations, use
`opencode plugin @jrpbuilds/specops -g -f`.

## Files created

After clean installation and onboarding, expect:

- OpenCode config containing the plugin package or local packed entry;
- `specops-manifest.json` in the OpenCode config directory;
- repository `openspec/config.yaml`;
- repository `openspec/schemas/specops-lean/`;
- repository `openspec/schemas/specops-standard/`;
- repository `openspec/schemas/specops/`.

No manually copied prompt files or agent definitions are required; prompts are embedded in the
packaged runtime configuration.

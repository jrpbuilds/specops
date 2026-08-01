# Getting started

## Requirements

- OpenCode 1.18.10 or newer;
- Node.js 24.18.1 or newer;
- a Git repository with at least one baseline commit;
- OpenSpec 1.7.0 assets installed by SpecOps.

## Published installation

Install through OpenCode:

```bash
opencode plugin @jrpbuilds/specops -g
```

Restart OpenCode after installation. During plugin load, SpecOps automatically materialises
`specops-manifest.json` and a complete editable `specops.json` in OpenCode's configuration
directory, then registers all controllers and workers in the resolved configuration. Existing
configuration files are preserved.

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

Interactive mode presents unresolved questions. Automatic mode pauses
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

SpecOps ships with every agent set to **Default**; each agent inherits OpenCode's configured
global default model until you assign a provider/model mapping.

After first load, edit:

```text
$XDG_CONFIG_HOME/opencode/specops-manifest.json
```

or `~/.config/opencode/specops-manifest.json` when XDG configuration is unset.

Open `SpecOps: Configure agent models` from OpenCode's command palette. Select an agent, one of
OpenCode's configured provider/model entries, and either **Default** (for OpenCode's global default)
or a variant exposed by that model. Choose **Use OpenCode default** to clear an agent-specific
selection so it follows OpenCode's global model again.

The schema-v2 manifest accepts an optional `model` and optional `variant` for every canonical
agent. An absent or blank `model` means "use OpenCode's global default". Workflow steps, prompts,
tools, permissions, and modes remain registry-owned. Restart or reload OpenCode and run
`/specops-doctor` after saving.

### Recommended mapping (neutral placeholders)

This is the shape we use internally. Replace `<provider>` with your configured OpenCode providers
and `<model>` with the exact model IDs they expose. We tune stronger models for assessment, design,
implementation, and frontier adjudication, and smaller/cheaper models for the controllers and
narrow specialists.

```json
{
    "version": 2,
    "agents": {
        "specops-auto-controller": { "model": "<provider>/<model>", "variant": "high" },
        "specops-interactive-controller": { "model": "<provider>/<model>", "variant": "high" },
        "specops-assessor": { "model": "<provider>/<strong-model>", "variant": "high" },
        "specops-explorer": { "model": "<provider>/<model>", "variant": "high" },
        "specops-planner": { "model": "<provider>/<model>", "variant": "high" },
        "specops-designer": { "model": "<provider>/<strong-model>", "variant": "max" },
        "specops-implementer": { "model": "<provider>/<code-model>", "variant": "thinking" },
        "specops-verifier": { "model": "<provider>/<strong-model>", "variant": "max" },
        "specops-repairer": { "model": "<provider>/<model>", "variant": "medium" },
        "specops-risk-reviewer": { "model": "<provider>/<model>", "variant": "thinking" },
        "specops-correctness-judge": { "model": "<provider>/<model>", "variant": "high" },
        "specops-compliance-judge": { "model": "<provider>/<strong-model>", "variant": "high" },
        "specops-review-refuter": { "model": "<provider>/<model>", "variant": "max" },
        "specops-frontier-low": { "model": "<provider>/<model>", "variant": "high" },
        "specops-frontier-high": { "model": "<provider>/<strong-model>", "variant": "high" },
        "specops-security-specialist": { "model": "<provider>/<strong-model>", "variant": "max" },
        "specops-data-migration-specialist": { "model": "<provider>/<model>", "variant": "high" },
        "specops-contract-specialist": { "model": "<provider>/<model>", "variant": "max" },
        "specops-concurrency-specialist": {
            "model": "<provider>/<strong-model>",
            "variant": "max"
        },
        "specops-resilience-specialist": { "model": "<provider>/<model>", "variant": "thinking" },
        "specops-performance-specialist": { "model": "<provider>/<model>", "variant": "high" },
        "specops-infrastructure-specialist": { "model": "<provider>/<model>", "variant": "high" },
        "specops-usability-specialist": { "model": "<provider>/<model>", "variant": "thinking" },
        "specops-maintainability-specialist": { "model": "<provider>/<model>", "variant": "high" }
    }
}
```

If an existing schema-v1 manifest is detected, it is treated as invalid and atomically replaced with the current defaults. Configure model choices through the command-palette editor afterward.

## Development installation

The repository pins its development runtime in `.nvmrc`:

```bash
nvm install
nvm use
```

Equivalent Node version-manager commands are fine as long as they select Node.js 24.18.1 or newer.

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
- `specops.json` in the OpenCode config directory containing the complete global defaults;
- repository `openspec/config.yaml`;
- repository `openspec/schemas/specops-lean/`;
- repository `openspec/schemas/specops-standard/`;
- repository `openspec/schemas/specops/`.

No manually copied prompt files or agent definitions are required; prompts are embedded in the
packaged runtime configuration.

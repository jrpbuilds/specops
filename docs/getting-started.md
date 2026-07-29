# Getting started

## Prerequisites

- Git with at least one baseline commit.
- Node.js 20.19 or newer.
- OpenCode 1.16.2 or a compatible newer release.
- Credentials and provider access for the models in the SpecOps manifest.

OpenSpec is pinned as a bundled dependency of the `@jrpbuilds/specops` npm
package. A global OpenSpec install is not needed.

## Install

Add the plugin to your OpenCode config:

```bash
curl -fsSL https://raw.githubusercontent.com/jrpbuilds/specops/master/scripts/install.sh | bash
```

Or manually add `"@jrpbuilds/specops"` to the `plugin` array in your
`opencode.json` and the `plugin` array in global `~/.config/opencode/tui.json`:

```json
{ "plugin": ["@jrpbuilds/specops"] }
```

```json
{ "plugin": ["@jrpbuilds/specops"] }
```

OpenCode's Bun runtime installs the package from npm on the next launch, and
the TUI registration makes it visible in OpenCode's Plugins menu. On
first load, the plugin writes the default agent manifest to
`~/.config/opencode/specops-manifest.json` — edit it to customize agent models
and permissions. It persists across plugin updates.

Establish a clean baseline before using automatic mode:

```bash
git add .
git commit -m "baseline"
opencode .
```

Run `/specops-doctor` first. It checks Git, Node, the bundled OpenSpec CLI, the
schema, and MCP policy without changing the project.

To initialize or refresh project memory without starting a change:

```text
/specops onboard <project context or goals>
```

This stores the analyzed result in `openspec/onboarding.md` inside the project
repository while preserving `openspec/config.yaml`.

## First use

`/specops-auto <goal>` bootstraps missing `openspec/` assets, assesses the
smallest safe Lean, Standard, or Full workflow, and runs to completion without
phase questions. It escalates automatically when later evidence requires more
planning or review. It stops when the worktree is dirty, a required model is
unavailable, validation fails, evidence grows stale, or bounded repair cannot
clear a blocking defect.

Its workers are native OpenCode tasks. Press `ctrl+x`, then `down` during the
run to open the subagent section and inspect any worker. Use
`/specops-auto-headless <goal>` only when compact CI-style execution matters
more than native worker navigation.

`/specops <goal>` performs the same conceptual workflow with explicit
checkpoints. Use it when requirements are exploratory, changes are risky, or
you want to edit artifacts between stages.

## What enters the repository

```text
openspec/
  config.yaml          Project context and rules
  schemas/specops/     Workflow schema and templates (seeded by the plugin)
  specs/               Archived source-of-truth behavior
  changes/             Active and archived change memory
.opencode/             (optional, per-project)
  specops.json         Runtime policy override
```

The agent manifest lives at `~/.config/opencode/specops-manifest.json` (global,
persists across plugin updates). The plugin code itself is installed from npm
to `~/.cache/opencode/node_modules/@jrpbuilds/specops/` by OpenCode's Bun
runtime. There is no hidden SpecOps database.

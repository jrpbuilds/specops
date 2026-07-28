# Getting started

## Prerequisites

- Git with at least one baseline commit.
- Node.js 20.19 or newer.
- OpenCode 1.16.2 or a compatible newer release.
- Credentials and provider access for the models in the SpecOps manifest.

OpenSpec is pinned as a project dependency. A global OpenSpec install is not
needed.

## Install in this repository

From the repository root:

```bash
npm install
python3 scripts/sync-opencode-manifest.py
npm run check
```

The sync command creates `opencode.json` when absent, merges the managed agents,
and creates only missing prompt files. It preserves all unrelated top-level
configuration, existing non-SpecOps agents, and existing prompt customizations.

Commit the installed plugin and establish a clean baseline before using
automatic mode:

```bash
git add .
git commit -m "install SpecOps"
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
.opencode/
  lib/                 Runtime helpers
  plugins/             OpenCode plugin entrypoint
  prompts/             Versioned agent contracts
  sdd-manifest.json    Agent/model/permission mapping
  specops.json         Runtime policy
openspec/
  config.yaml          Project context and rules
  schemas/specops/     Workflow schema and templates
  specs/               Archived source-of-truth behavior
  changes/             Active and archived change memory
opencode.json          Generated OpenCode agent definitions
```

These files are intentionally local and versionable. There is no hidden SpecOps
database.

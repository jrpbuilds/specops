# SpecOps

SpecOps is a lightweight, open-code Spec-Driven Development plugin for
[OpenCode](https://opencode.ai), powered by
[OpenSpec](https://openspec.dev/).

It turns a goal into durable, repo-local specifications, implementation,
verification evidence, two independent judgments, and a refuted engineering
review. The name is a nod to Spec-Driven Development plus surgical subagent
execution.

## What is included

- Fully automated `/specops-auto <goal>` execution with visible, inspectable
  native OpenCode workers, intelligent Lean/Standard/Full workflow sizing,
  evidence-driven escalation, and bounded repair loops.
- Checkpointed `/specops <goal>` execution for user edits between every phase.
- A custom OpenSpec schema from exploration through review and archive.
- Nineteen least-privilege agents with centrally configurable models.
- Parallel Judgment Day and four-specialist review panels.
- SHA-256-bound receipts that prevent stale evidence from being archived.
- Optional use of the user's existing MCP tools, with no required MCP server.
- Additive manifest synchronization that preserves unrelated OpenCode settings.

All durable project memory lives under `openspec/` in the project repository.
SpecOps does not require Engram, a database, a hosted service, or an MCP server.

## Adaptive execution

SpecOps starts with the smallest workflow that can safely complete the goal:

| Tier | Typical use |
| --- | --- |
| Lean | Localized documentation, configuration, tests, and restorative bug fixes |
| Standard | Localized new or changed behavior requiring proposal and specifications |
| Full | Sensitive, architectural, breaking, migratory, destructive, infrastructural, concurrent, cross-cutting, or large changes |

It escalates only when concrete repository evidence crosses a scope or safety
boundary, or when safe progress is genuinely blocked after inspection.
Low-risk wording choices and reversible assumptions remain at the current
tier. Transient provider capacity errors also do not affect routing: SpecOps
keeps the configured agent and model, waits with backoff, and retries until the
provider recovers or the user interrupts.

## Quick start

Requirements: Git, Node.js 20.19 or newer, OpenCode 1.16.2 or a compatible
newer release, and access to the models configured in
`.opencode/sdd-manifest.json`.

```bash
npm install
python3 scripts/sync-opencode-manifest.py
npm run check
opencode .
```

Inside OpenCode:

```text
/specops-doctor
/specops-auto add a focused health endpoint with tests and documentation
```

Automatic mode requires a clean, committed Git baseline and never creates a
commit, pushes, stashes, resets, or opens a pull request. Review the resulting
working tree yourself. During a run, use `ctrl+x`, then `down` to open
OpenCode's subagent pane and select any worker transcript.

For a controlled workflow:

```text
/specops add a focused health endpoint with tests and documentation
```

This pauses after each artifact and before implementation and archive.

## Documentation

- [Getting started](docs/getting-started.md)
- [How the architecture works](docs/architecture.md)
- [Automatic and interactive workflows](docs/workflows.md)
- [Agents and prompts](docs/agents.md)
- [Configuration](docs/configuration.md)
- [Security, permissions, and MCP](docs/security-and-integrations.md)
- [Command reference](docs/commands.md)
- [Development and validation](docs/development.md)
- [Troubleshooting](docs/troubleshooting.md)

## Status

This repository is an initial working implementation intended for direct
OpenCode testing. Model identifiers are deliberately centralized so provider or
model changes do not require editing the orchestrator.

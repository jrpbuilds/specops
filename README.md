# SpecOps

![SpecOps](https://raw.githubusercontent.com/jrpbuilds/specops/master/docs/specops-logo.webp)

SpecOps is an OpenCode plugin for deterministic, evidence-driven software changes backed by
OpenSpec artifacts. Language models supply bounded reasoning and implementation work; TypeScript
owns routing, scheduling, persistence, invalidation, command evidence, review independence, repair
budgets, and completion gates.

The project is intentionally clean-slate. It supports one run-state format (version 2) and one
canonical agent catalogue. There are no aliases or fallback pipelines for earlier pre-release
designs. The installer only provides a targeted additive upgrade from the immediately preceding
agent catalogue so existing model choices survive the addition of the two frontier routes.

## What SpecOps provides

- Lean, Standard, and Full scope tiers selected from repository evidence, risk, and uncertainty.
- A single deterministic scheduler shared by interactive and automatic execution.
- Full-tier planning in three ordered stages: requirements bundle, independent design, task
  refinement.
- Risk-facet specialists selected independently from scope tier.
- Direct command execution with argument arrays, no shell, confined working directories, timeout,
  controlled environment, and bounded output.
- Durable artifact provenance and dependency-based invalidation.
- Bounded worker-raised questions for material decisions that repository inspection cannot resolve,
  with answer-bound provenance and deterministic invalidation.
- Optional adaptive Luna/Sol frontier escalation for evidence-backed workflow blockers.
- Independent correctness and specification-compliance judgments.
- Evidence-backed review submissions, a refuted OpenSpec ledger, and bounded repair tasks.
- Diff-bound command evidence and independent re-review after every accepted repair.
- A strict, user-editable model manifest generated from the canonical capability registry.

## Installation

OpenCode 1.16.2 or newer and Node.js 20.19 or newer are required.

For a published install:

```bash
opencode plugin @jrpbuilds/specops -g
```

It registers `@jrpbuilds/specops` in OpenCode's server and TUI configuration. On the first plugin
load, SpecOps automatically writes the exact final agent manifest to:

```text
$XDG_CONFIG_HOME/opencode/specops-manifest.json
```

When `XDG_CONFIG_HOME` is unset, the path is
`~/.config/opencode/specops-manifest.json`. No manual agent-file copying is required.

Open `SpecOps: Configure agent models` from OpenCode's command palette to choose a configured
model and optional model variant for every controller and worker. The manifest controls only those
two fields; step limits, modes, prompts, tools, and permissions remain controlled by the packaged
capability registry.

Legacy schema-v1 manifests are preserved byte-for-byte and trigger the mapping screen once per
OpenCode launch until the user reviews and saves schema v2. During that session, SpecOps uses its
packaged defaults. Other malformed or wrong-catalogue manifests are atomically replaced with the
current defaults.

After installation:

```text
/specops-onboard
/specops-doctor
/specops describe the change you want
```

See [Getting started](docs/getting-started.md) for the complete clean-install and development
reinstall flows.

## Execution modes

| Command                | Behaviour                                                                       |
| ---------------------- | ------------------------------------------------------------------------------- |
| `/specops <goal>`      | Interactive controller with checkpoints and native worker-question handling.    |
| `/specops-auto <goal>` | Automatic controller using visible native workers; pauses for material choices. |
| `/specops-status`      | Reads an existing version 2 run.                                                |
| `/specops-doctor`      | Validates installation, manifest, commands, agents, prompts, and schemas.       |
| `/specops-onboard`     | Installs final OpenSpec schemas into the current repository.                    |

The generated [command catalogue](docs/commands.md) records the exact runtime target for every
public command.

### Non-interactive CLI auto

The same automatic workflow is available without opening the TUI through OpenCode's supported
CLI adapter:

```bash
opencode run --command specops-auto --dir /path/to/project \
  "add a health endpoint with tests"
```

Use `--format json` for raw NDJSON events suitable for CI. The positional message is the workflow
goal, `--dir` selects the project, and project configuration supplies any minimum scope tier. Do
not add OpenCode's unrelated `--auto` permission flag.

```bash
set -o pipefail
opencode run --command specops-auto --dir "$PWD" --format json \
  "apply the scheduled maintenance change" | tee specops.ndjson
```

OpenCode owns the process exit code. Exit `0` means the command session completed, not necessarily
that every workflow gate passed; CI must also require persisted outcome category `completed`.
Interruptions conventionally return `130`, while other nonzero exits cover host, installation,
provider, or internal failures. Persisted outcomes distinguish policy blocks, validation failures,
review failures, cancellation, and successful completion.

Automatic and CLI runs cannot answer worker-raised questions. When a material choice cannot be
resolved from repository evidence, SpecOps persists a resumable paused run instead of guessing.
Resume it interactively without rerunning the original worker:

```bash
opencode run --command specops --dir /path/to/project "resume"
```

## Workflow

Every run begins with a strict assessment and deterministic routing decision.

```text
assessment
  → Lean: compact plan → implementation → bundled verification and assurance
  → Standard/Full: exploration → planning bundle
  → independent design (Full only)
  → task refinement (Full only; Standard tasks are bundled)
  → specialist consultations selected during planning
  → implementation
  → registered verification
  → independent judgments
  → cross-cutting risk scan
  → independent specialist reviews
  → refutation ledger
  → adaptive frontier adjudication only when a validated blocker requires it
  → repair and re-verification when required
  → completion receipt
```

Interactive and automatic entrypoints share this scheduler. A successful Lean
run therefore uses four total subagent calls, including assessment. Known risk
routes directly to Standard/Full; newly discovered risk or actual diff overflow
upgrades the run before completion.

Worker output does not directly mutate requirements or planning artifacts. Planner and designer
responses are validated, then persisted atomically by the controller. Only implementer and
repairer agents can modify repository code.

At any worker boundary, a genuinely unresolved material decision may enter a bounded question
loop. Interactive runs present validated options through OpenCode's native question UI. Answers
are hashed into dispatch provenance, invalidate affected downstream artifacts, and cause a fresh
dispatch for the interrupted phase. Dismissing a question leaves the run paused and resumable;
question budgets prevent unbounded loops.

See [Architecture](docs/architecture.md), [Workflows](docs/workflows.md), and
[Artifacts and state](docs/artifacts-and-state.md).

## Configuration

Project policy lives at `.opencode/specops.json`. Start from
[examples/specops.json](examples/specops.json); its schema is
[examples/specops.schema.json](examples/specops.schema.json).

Configuration is strict. Unknown fields, invalid thresholds, and incomplete escalation or question
budget objects fail at startup instead of being ignored. See
[Configuration](docs/configuration.md).

## Agent models

The generated manifest contains every final controller and worker. Prefer the
`SpecOps: Configure agent models` command. Its dropdowns list only models already configured in
OpenCode and the variants each model actually exposes:

```json
{
    "version": 2,
    "agents": {
        "<canonical-agent-id>": {
            "model": "provider/model",
            "variant": "high"
        }
    }
}
```

`model` and `variant` are both optional; an absent or blank `model` means the
agent uses OpenCode's configured global default model. All canonical agent IDs
must be present. Unknown fields, partial catalogues, and unsupported variants
are rejected. Restart or reload OpenCode after saving, then run
`/specops-doctor`. The complete generated catalogue and role descriptions are in
[Agents](docs/agents.md). Clean installs ship every agent set to OpenCode's
global default; assign stronger coding models to the implementer, repairer, and
frontier roles for the most reliable results. Existing manifests preserve their
current selection.

## Development and verification

```bash
npm install
npm run generate
npm run format
npm run check
npm run smoke:opencode
npm pack --dry-run
```

`npm run check` includes formatting, strict TypeScript and unused-symbol checks, unit/integration
tests, packed-output materialisation tests, generated-asset drift checks, and
OpenSpec schema validation. `npm run smoke:opencode` additionally loads the packed plugin through
a real isolated OpenCode installation and runs the documented CLI command until the first
scheduler action or an external provider boundary is reached.

See [Development](docs/development.md) for the exact validation matrix and provider boundary.

## Troubleshooting

If a command reports a missing controller:

1. Run `/specops-doctor`.
2. Inspect the manifest path reported by doctor.
3. Rebuild/reinstall the package and restart OpenCode.
4. Run `opencode debug config` and `opencode debug agent <controller-id>` if needed.

Schema-v1 manifests are preserved until their mappings are reviewed in the command-palette editor.
Other invalid or partial manifests are replaced with current defaults on plugin load; removed IDs
are never translated. More diagnostics are in [Troubleshooting](docs/troubleshooting.md).

## Documentation

- [Getting started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Workflows and scope tiers](docs/workflows.md)
- [Agent catalogue](docs/agents.md)
- [Commands](docs/commands.md)
- [Configuration](docs/configuration.md)
- [Artifacts and persisted state](docs/artifacts-and-state.md)
- [Security, evidence, and integrations](docs/security-and-integrations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development and testing](docs/development.md)

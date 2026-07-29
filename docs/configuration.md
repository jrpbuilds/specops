# Configuration

## Agent manifest

The agent manifest lives at `~/.config/opencode/specops-manifest.json`. The
plugin creates it on first load from the built-in default and never overwrites
it afterwards — your edits persist across plugin updates.

Edit it directly to change agent models, `steps`, tools, permissions, or
provider/model options such as `reasoningEffort`:

```json
{
  "agents": {
    "sdd-apply": {
      "model": "opencode/north-mini-code-free",
      "steps": 96,
      "tools": { "question": false, "todowrite": false },
      "permission": { "bash": "allow", "edit": "allow", "task": "deny" }
    },
    "sdd-propose": {
      "model": "opencode/nemotron-3-ultra-free",
      "steps": 32,
      "tools": {},
      "permission": { "bash": "deny", "edit": "deny", "task": "deny" },
      "reasoningEffort": "high"
    }
  }
}
```

Extra fields beyond the four known keys (`model`, `steps`, `tools`, `permission`)
pass through to the generated OpenCode agent as provider/model options.
`reasoningEffort` is the documented OpenCode spelling for reasoning levels.

The plugin reads this file on every load and registers all 19 workers
programmatically via its `config()` hook. No `opencode.json` mutation is
required.

### Power-user file-based config

If you prefer to materialize agent definitions into your project's
`opencode.json` (e.g. for version control or editor autocompletion), run:

```bash
python3 scripts/sync-opencode-manifest.py
```

This reads the manifest from `~/.config/opencode/specops-manifest.json` and
writes the agent entries into the project's `opencode.json`. Existing agents
and unrelated config are preserved. Use `--check` in CI to detect drift.

Model access is provider-specific. If an `opencode/*` model is unavailable,
replace only its manifest mapping with a compatible configured provider/model.

## Runtime policy

`.opencode/specops.json` (per-project) controls orchestration. Copy the
template from `examples/specops.json`:

```bash
mkdir -p .opencode
cp examples/specops.json .opencode/specops.json
```

```json
{
  "openspec": {
    "command": null,
    "schema": "specops"
  },
  "workflow": {
    "default_tier": "auto",
    "onboarding": "if-missing",
    "lean_max_files": 2,
    "lean_max_modules": 1,
    "full_min_files": 9,
    "full_min_modules": 4
  },
  "automation": {
    "max_fix_cycles": 3,
    "require_clean_worktree": true,
    "blocking_severities": ["BLOCKER", "HIGH"]
  },
  "review": {
    "max_diff_bytes": 200000,
    "transient_retries": 1,
    "agent_timeout_seconds": 300
  },
  "integrations": {
    "mcp": "inherit"
  }
}
```

When `.opencode/specops.json` is missing, SpecOps uses safe defaults from
`DEFAULT_CONFIG` in `src/core.ts`.

`openspec.command: null` uses the pinned bundled OpenSpec dependency through the
system `node` executable. An array overrides the executable and prefix arguments
without shell parsing, for example `["/usr/local/bin/openspec"]`.

Keep the repair bound small. A larger value increases cost and can conceal a
bad specification; it does not expand agent permissions.

`workflow.default_tier` is a minimum. `auto` lets the assessor choose; an
explicit tier cannot override a higher safety floor. File/module thresholds
bound Lean and trigger Full for large changes. Semantic Full floors include
security, breaking contracts, migrations, dependencies, infrastructure,
concurrency, destructive operations, architecture, and critical unknowns.

`workflow.onboarding: "if-missing"` avoids spending an onboarding worker on
every small run. Use `"always"` to refresh project memory for every change.

`blocking_severities` determines which refuted review findings trigger repair.
Lean requires Judge A; Standard and Full require both independent passes.

`max_diff_bytes` is a completeness safeguard. SpecOps fails on an oversized
snapshot rather than silently reviewing a truncation.

`agent_timeout_seconds` limits each worker attempt. The default is five minutes.
`transient_retries` controls fresh-session retries for non-capacity failures.
Provider capacity failures (HTTP 429, temporary availability, timeout, and
transient streaming errors) keep polling with capped exponential backoff until
the worker succeeds or the user interrupts. Retries preserve the configured
agent and model. Agent-specific `steps` values live in the manifest and
force a text-only result after a bounded number of tool iterations.

## Existing OpenSpec projects

Onboarding copies only missing `specops-lean`, `specops-standard`, and
`specops` schema assets. It never
replaces an existing `openspec/config.yaml` or changes that project's default
schema. Each change records its selected schema and may only move upward.

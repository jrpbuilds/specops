# Configuration

## Agent manifest

Edit `.opencode/sdd-manifest.json`, then run:

```bash
python3 scripts/sync-opencode-manifest.py
```

Use `--check` in CI to detect drift. Synchronization is atomic and deterministic.
It preserves unrelated OpenCode settings and agents. Managed SpecOps agent IDs
are authoritative and replaced from the manifest.

Model access is provider-specific. If an `opencode-go/*` model is unavailable,
replace only its manifest mapping with a compatible configured provider/model.

## Runtime policy

`.opencode/specops.json` controls orchestration:

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
agent and model. Agent-specific `maxSteps` values live in the manifest and
force a text-only result after a bounded number of tool iterations.

## Existing OpenSpec projects

Onboarding copies only missing `specops-lean`, `specops-standard`, and
`specops` schema assets. It never
replaces an existing `openspec/config.yaml` or changes that project's default
schema. Each change records its selected schema and may only move upward.

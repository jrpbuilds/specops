# Troubleshooting

## Automatic mode says the worktree is dirty

This is intentional. `git status --short` identifies the pre-existing work.
Commit, stash, or remove it yourself. SpecOps will not decide how to preserve
user work.

## Git has no baseline commit

Create the initial commit before automatic mode. Receipts bind to `HEAD`, so an
unborn branch cannot provide auditable evidence.

## A configured model is unavailable

Run `opencode models` and replace that agent's model in
`.opencode/sdd-manifest.json`, then run the sync script. The orchestrator does
not silently substitute a model because agent diversity is part of the review
contract.

## OpenSpec cannot be resolved

Run `npm install` at the repository root and `/specops-doctor`. The default
runtime requires `node` on `PATH` and resolves the pinned
`@fission-ai/openspec` package. Use `openspec.command` only for a deliberate
local override.

## OpenSpec schema is missing

Run `/sdd-onboard`. It restores only missing schema files and preserves existing
OpenSpec configuration and templates.

## A change does not archive

Read the retained active change. Common reasons are:

- strict spec validation failed;
- a judge required by the selected tier did not emit standalone `[PASS]`;
- a BLOCKER or HIGH finding survived the refuter;
- the repair bound was reached;
- code or artifacts changed after review; or
- a child agent created a commit, changing the bound baseline.

Fix the underlying issue and rerun the dependent stages. Do not edit the receipt
to force freshness.

## A run selected a larger tier than expected

Read `routing.md` and `specops-run.json` in the active change. Tier flags and
configuration are minimums, while security, breaking contracts, migrations,
dependencies, infrastructure, concurrency, destructive work, architecture,
critical unknowns, and configured size thresholds impose higher floors.
Escalation history records which worker discovered the additional scope.

## OpenCode shows two plugin origins

Only `sdd-orchestrator.ts` should be inside `.opencode/plugins/`. Move helper
source into `.opencode/lib/`, then restart OpenCode.

## MCP is absent or failing

SpecOps does not require MCP. Set `integrations.mcp` to `disabled` if an
unreliable configured server is distracting child sessions. Fixing or removing
the user's server remains outside SpecOps onboarding.
## Provider rate limits

Free OpenCode Zen models can return transient HTTP 429 or streaming errors.
SpecOps treats these as capacity signals rather than workflow or escalation
evidence. It keeps the same phase, agent, model, prompt, and change ID, waits
with capped exponential backoff, and polls until the provider succeeds or the
user interrupts.

# SpecOps 1.0 Legacy Architecture Inventory

This inventory records the 0.x surface at `pre-specops-1.0-rewrite` before the
V1 rewrite. It is a removal and migration map, not a compatibility plan. The
approved V1 technical specification and the `rewrite-specops-1-0` OpenSpec
change are authoritative when this inventory disagrees with current code.

## Public Commands

| Current command    | Current owner                           | V1 disposition                                                 |
| ------------------ | --------------------------------------- | -------------------------------------------------------------- |
| `/specops`         | Interactive controller                  | Replace in Phase 4 with the coordinator entry point.           |
| `/specops-auto`    | Automatic controller                    | Delete in Phase 8; automatic mode is excluded.                 |
| `/specops-onboard` | `specops_onboard` tool                  | Replace in Phase 1 with upstream standard OpenSpec onboarding. |
| `/specops-status`  | `specops_get_status` tool               | Replace in Phase 8 with coarse V1 status.                      |
| `/specops-archive` | Interactive controller and archive tool | Delete in Phase 8; archival is a completion action.            |
| `/specops-doctor`  | `specops_doctor` tool                   | Replace in Phase 8 with V1 diagnostics.                        |

Source: `src/commands.ts`.

## Protocol Tools

`src/protocol.ts` currently declares 17 scheduler-oriented tools:

```text
specops_start_run
specops_next_action
specops_complete_action
specops_recover_dispatch
specops_answer_question
specops_answer_questions
specops_dismiss_question
specops_resume_checkpoint
specops_request_context
specops_run_validation
specops_get_status
specops_cancel_run
specops_finalize
specops_archive_run
specops_onboard
specops_doctor
specops_openspec
```

Phase 8 replaces this catalogue with exactly six V1 tools:
`specops_start_or_resume`, `specops_reconcile_stage`, `specops_get_status`,
`specops_run_validation`, `specops_finalize`, and `specops_cancel`. Scheduler,
dispatch, question-answer, archive-maintenance, onboarding, doctor, and raw
OpenSpec tool IDs have no compatibility layer.

## Agent Catalogue

`src/capabilities/ids.ts` declares 24 agents:

| Group       | Current IDs                                                                                                                                                 | V1 disposition                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Controllers | `specops-auto-controller`, `specops-interactive-controller`                                                                                                 | Replace with `specops-coordinator`.                                                                                    |
| Core        | `specops-assessor`, `specops-explorer`, `specops-planner`, `specops-designer`, `specops-implementer`, `specops-verifier`, `specops-repairer`                | Retain explorer/planner/designer/implementer concepts under the seven V1 IDs; remove assessor, verifier, and repairer. |
| Review      | `specops-risk-reviewer`, `specops-correctness-judge`, `specops-compliance-judge`, `specops-review-refuter`, `specops-frontier-low`, `specops-frontier-high` | Replace with one reviewer and one frontier agent.                                                                      |
| Specialists | security, data-migration, contract, concurrency, resilience, performance, infrastructure, usability, and maintainability specialists                        | Delete; their concerns are part of the independent V1 review when material.                                            |

`src/capabilities/registry.ts` owns the legacy capability registry, agent roles,
models, permissions, and controller/worker policy. `src/capabilities/context.ts`
provides capability context. Phase 2 replaces the directory with the seven-role
agent registry and permissions model.

## OpenSpec Schemas And Artifacts

Bundled custom schemas to delete in Phase 1:

```text
schemas/specops/schema.yaml
schemas/specops-lean/schema.yaml
schemas/specops-standard/schema.yaml
schemas/specops/templates/
```

The `specops` templates include proposal, specification, design, task,
exploration, verification, review-ledger, and judgment formats. They duplicate
or replace upstream OpenSpec semantics and are excluded from V1. `src/openspec.ts`
and `scripts/onboard.mjs` currently install and validate these schemas.

## Workflow And Routing Modules

The legacy scheduler pipeline is implemented by:

```text
src/workflow/actions.ts
src/workflow/archive.ts
src/workflow/artifacts.ts
src/workflow/checkpoints.ts
src/workflow/completion.ts
src/workflow/contracts.ts
src/workflow/contracts.generated.ts
src/workflow/directive.ts
src/workflow/engine.ts
src/workflow/interactive.ts
src/workflow/previews.ts
src/workflow/questions.ts
src/workflow/reviews.ts
src/workflow/run-start.ts
src/workflow/run-state.ts
src/workflow/scheduler.ts
src/workflow/writer-guards.ts
```

These modules model capability selection, directives, dispatch issuance and
recovery, phase checkpoints, scheduler state, artifact graph handling, review
tribunals, and archive maintenance. Phase 4–7 introduce the coarse V1 planning,
implementation, review, and finalisation modules; Phase 9 deletes this list
after all imports move.

Related legacy policy directories are:

```text
src/artifacts/graph.ts
src/artifacts/lifecycle.ts
src/escalation/policy.ts
src/frontier/policy.ts
src/routing/assessment.ts
src/routing/policy.ts
src/evidence/registry.ts
src/evidence/commands.ts
```

The V1 repository identity, validation registry, and evidence modules replace
the retained responsibilities. Capability routing, escalation taxonomies,
frontier tiers, and artifact invalidation graphs are deleted in Phase 9.

## Generated And Integration Surfaces

| Path                                  | Current purpose                                                 | V1 disposition                                                       |
| ------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/prompts.generated.ts`            | Generated TypeScript prompts and controller instructions        | Replace with seven Markdown files in Phase 2; delete generated file. |
| `src/workflow/contracts.generated.ts` | Generated worker wire contracts                                 | Delete in Phase 9.                                                   |
| `scripts/generate-contracts.mjs`      | Generates prompts/contracts                                     | Delete in Phase 2.                                                   |
| `scripts/check-generated.mjs`         | Verifies generated artifacts                                    | Remove from the final check pipeline in Phase 10.                    |
| `scripts/generate-docs.mjs`           | Generates command/agent documentation                           | Review in Phase 10; retain only if it serves the V1 source of truth. |
| `scripts/evaluate-review-fixer.mjs`   | Legacy review-fixer evaluation                                  | Delete in Phase 9.                                                   |
| `src/orchestrator.ts`                 | Registers old deterministic workflow tools                      | Replace with `src/plugin.ts` and V1 `src/index.ts` in Phase 9.       |
| `src/worker_output.ts`                | Parses legacy worker markers, escalation, and protocol payloads | Delete in Phase 9.                                                   |

`src/index.ts`, `src/installation.ts`, `src/model-settings.ts`, and `src/tui.ts`
are integration surfaces to retain only after their agent, manifest, command,
and configuration dependencies move to V1.

## State And Persistence

| Current path                    | Current responsibility                                               | V1 disposition                                                                    |
| ------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/state/store.ts`            | Atomic filesystem state primitives and legacy persisted run handling | Extract reusable atomic writes in Phase 1; replace run-state handling in Phase 3. |
| `src/workflow/run-state.ts`     | Fine-grained scheduler state, dispatch provenance, and recovery      | Delete in Phase 9.                                                                |
| `src/workflow/contracts.ts`     | Scheduler action and persisted protocol contracts                    | Delete in Phase 9.                                                                |
| `src/workflow/writer-guards.ts` | Legacy artifact writer controls                                      | Replace with V1 path ownership in Phase 2/3; delete in Phase 9.                   |

V1 persists only coarse `run.json`, exploration, review, and validation evidence
under `.specops/runs/<change>/`; it must detect old run state without translating
or resuming it.

## Configuration And Manifest

`src/config.ts`, `src/config/fields.ts`, and `src/config/sections.ts` currently
define configuration version 2 with these top-level fields:

```text
version
openspec.command
openspec.autoArchive
workflow.defaultTier
workflow.scopeThresholds
routing.forceFullForFacets
escalation.budgets
frontier.mode
frontier.maxEscalationsPerRun
frontier.maxDispatchesPerRun
frontier.maxHighDispatchesPerRun
review.blockingSeverities
review.maxDiffBytes
review.maxContextBytes
review.transientRetries
review.commandTimeoutSeconds
review.commandOutputBytes
integrations.mcp
```

`src/manifest.ts` persists a version 2 manifest for the 24-agent catalogue.
`examples/specops.schema.json`, `examples/specops.json`, and
`examples/specops.global.json` document the same obsolete shape. Phase 9
replaces these with minimal V1 configuration and a seven-role version 3 manifest;
old configuration is migrated once as specified, while legacy run state is not.

## Tests

The current test suite includes legacy behaviour in:

```text
tests/archive.test.ts
tests/checkpoints.test.ts
tests/controller-guardrails.test.ts
tests/frontier.test.ts
tests/lean-workflow.test.ts
tests/openspec.test.ts
tests/previews.test.ts
tests/questions.test.ts
tests/reliability.test.ts
tests/runtime-integration.test.ts
tests/specops.test.ts
tests/summary.test.ts
tests/worker-contracts.test.ts
```

`tests/config.test.ts`, `tests/doctor.test.ts`, `tests/model-settings.test.ts`,
and `tests/tui.test.ts` require focused V1 replacement coverage. Phase 9 deletes
tests that assert removed tiers, dispatch, specialist, tribunal, generated
contract, custom-schema, or automatic-mode behaviour and retains only
appropriately rewritten coverage.

## Reusable Utilities

The following components are candidates to retain after dependency review:

```text
src/git.ts                 Shell-free process execution.
src/security/redact.ts     Sensitive-output redaction.
src/state/store.ts         Atomic-write primitives only.
src/tui.ts                 Model-selection user interface after seven-role trim.
src/model-settings.ts      Provider/model/variant selection after manifest rewrite.
scripts/clean.mjs          Build output cleanup.
scripts/check-doc-links.mjs Documentation link validation.
scripts/check-compatibility.mjs Compatibility documentation checks, if updated for V1.
scripts/test-packed-install.mjs Packed-install coverage, after V1 expectations replace legacy assertions.
```

## Deletion Candidates By Phase

| Phase | Candidates                                                                                                                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Custom schemas, their templates, schema-copy onboarding, and custom-schema validation script.                                                                                                                    |
| 2     | `src/capabilities/`, `src/prompts.generated.ts`, and `scripts/generate-contracts.mjs`.                                                                                                                           |
| 3–8   | Legacy consumers superseded by state, workflow, review, finalisation, commands, and doctor replacements.                                                                                                         |
| 9     | Old scheduler/workflow modules, protocol, escalation/frontier/routing/artifact directories, generated contracts, worker output, legacy orchestrator/manifest/config shape, examples, and obsolete tests/scripts. |
| 10    | Remaining generated-pipeline steps, stale dependencies, and documentation describing removed architecture.                                                                                                       |

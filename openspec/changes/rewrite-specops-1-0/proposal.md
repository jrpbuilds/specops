## Why

SpecOps 0.x ships a 24-agent capability registry, three custom OpenSpec schemas (`specops`, `specops-lean`, `specops-standard`), a generated wire-contract protocol, a dispatch scheduler, and a review tribunal. The result is hard to understand, hard to maintain, and couples SpecOps to bespoke orchestration that OpenSpec 1.7's standard `spec-driven` workflow already owns. SpecOps 1.0 replaces this with a bounded, interactive, seven-agent workflow that delegates artifact readiness, instructions, validation, and archival to OpenSpec and keeps TypeScript responsibility limited to safety, gates, and persistence.

## What Changes

- **BREAKING**: Replace the 24-agent capability registry with exactly seven agents (`specops-coordinator`, `-explorer`, `-planner`, `-designer`, `-implementer`, `-reviewer`, `-frontier`); remove automatic controller, assessor, verifier, repairer, risk reviewer, correctness/compliance judges, refuter, frontier-low/high split, and all specialist agents.
- **BREAKING**: Delete the `specops`, `specops-lean`, and `specops-standard` custom schemas and all onboarding that installs them; support only the upstream `spec-driven` schema.
- **BREAKING**: Remove `/specops-auto` and `/specops-archive`; final public commands are `/specops`, `/specops-status`, `/specops-cancel`, `/specops-doctor`, `/specops-onboard`.
- Replace the dispatch scheduler, action catalogue, directive engine, generated contracts, and review tribunal with a single coarse interactive workflow driven by a thin OpenSpec 1.7 adapter.
- Store agent prompts as editable Markdown files; delete `prompts.generated.ts` and `scripts/generate-contracts.mjs`.
- Introduce a coarse `run.json` run-state model, deterministic repository-state identity, and validation evidence bound to repository identity.
- Implement bounded artifact correction (two attempts after initial write), one independent reviewer, bounded repair (default max two), two user checkpoints (planning, completion), and OpenSpec archival only after explicit user approval.
- Preserve reusable utilities (shell-free process execution, atomic writes, sensitive-output redaction, model-selection TUI) after confirming they do not depend on removed architecture.
- Migrate the 24-agent model manifest to a seven-role manifest, preserving obvious model mappings and reporting ambiguous ones.
- Replace the configuration surface with a minimal V1 shape exposing only genuine project or user choices: seven-role model mappings and variants, the OpenSpec command override, required validation commands, validation timeouts, bounded output capture settings, and the MCP integration toggle. Remove workflow tiers, routing, automation, escalation budgets, frontier dispatch budgets, reviewer policy knobs, and automatic archival. Artifact correction, review repair, transient provider retry, and frontier consultation limits are internal bounded constants and do not appear as configuration fields. Legacy configuration is migrated once: supported values are preserved, known obsolete fields are removed, all removed fields are reported, the migrated V1 configuration is atomically persisted, and strict V1 validation is applied after migration.

## Capabilities

### New Capabilities

- `openspec-adapter`: Typed shell-free adapter over OpenSpec 1.7 JSON interfaces (version detection, schema detection, status, instructions, validation, archive) with `>=1.7.0 <1.8.0` range enforcement and `spec-driven`-only enforcement.
- `agent-catalogue`: Exactly seven registered agents with least-privilege permissions, Markdown prompt templates with a fail-strict placeholder renderer, and a migrated seven-role model manifest.
- `run-state`: Atomic coarse run-state persistence, deterministic repository-state identity, dirty-tree baseline capture, external-mutation detection, validation evidence bound to identity, and coarse recovery boundaries.
- `planning-workflow`: Coordinator-driven exploration and standard OpenSpec proposal/specs/design/tasks authoring with bounded artifact correction, material questions, and a single planning checkpoint.
- `implementation-workflow`: Implementer source/test mutation, OpenSpec task-checkbox tracking, one frontier consultation per stage attempt, required project validation execution, and external-mutation handling.
- `review-workflow`: One read-only independent reviewer writing a fixed Markdown review artifact, freshness enforcement, and bounded repair with exhaustion to a blocked state; no tribunal.
- `completion-workflow`: Completion checkpoint (archive / request changes / leave open / cancel), verified-but-open state, finalisation checks, OpenSpec archival, and retryable archive failure.
- `command-surface`: The five final public commands, a minimal workflow tool surface (no dispatch IDs or scheduler directives), `/specops-status` output, `/specops-doctor` diagnostics, and non-destructive installation migration.
- `legacy-removal`: Deletion of the old scheduler, dispatch protocol, custom schemas, obsolete agents, generated contracts, dead code, and obsolete tests; replaced by tests for the new product requirements.
- `configuration`: Minimal V1 configuration shape with defaults that allow the plugin to run with minimal setup once OpenSpec is available; no tiers, routing, automation, escalation, frontier budgets, reviewer policy, or automatic archival.

### Modified Capabilities

_(none — the prior architecture has no canonical specs in `openspec/specs/`; this change introduces the V1 capability set fresh.)_

## Impact

- **Code**: Rewrites `src/index.ts`, `src/commands.ts`, `src/protocol.ts`, `src/doctor.ts`, `src/installation.ts`, `src/config.ts`, `src/manifest.ts`, `src/model-settings.ts`, `src/tui.ts`, `src/orchestrator.ts`, `src/types.ts`, `src/state/store.ts`, `src/openspec.ts`; deletes `src/capabilities/`, `src/escalation/`, `src/frontier/`, `src/routing/`, `src/artifacts/`, `src/evidence/registry.ts`, `src/workflow/*` (old engine), `src/prompts.generated.ts`, `src/worker_output.ts`, `scripts/generate-contracts.mjs`, `scripts/evaluate-review-fixer.mjs`.
- **Schemas**: Deletes `schemas/specops*`; stops copying them on onboard. The repository's `openspec/` tree is re-established as a tracked standard `spec-driven` project (no longer gitignored).
- **Dependencies**: Keeps `@fission-ai/openspec@1.7.0` and `@opencode-ai/plugin`; removes now-unused deps via `knip`.
- **Package**: Updates `package.json` scripts (drops `validate:openspec` and `eval:review-fixer`; adds `test:openspec:compat`); adds `prompts/**/*.md` to `files[]`; removes `examples/specops.schema.json` and the old-shape `examples/specops.json`/`specops.global.json`.
- **Configuration**: Removes fields for tiers, capability graphs, dispatch budgets, refutation, frontier levels, custom-schema installation, reviewer policy knobs, and automatic archival; keeps model mappings, validation commands, timeouts, bounded output capture, and the correction and repair limits as internal bounded constants.
- **Compatibility**: Old runs cannot resume and are detected as legacy state; old custom schemas are not deleted automatically but are no longer used.
- **Users**: Must run `/specops-doctor` after upgrade; interactive workflow only.

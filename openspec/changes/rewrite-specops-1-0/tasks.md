# Implementation Tasks

Each phase group below corresponds to a Phase 0–10 stage of the SpecOps 1.0 rewrite (see `design.md` for the decisions behind each step). Tasks are ordered by dependency. Every group ends with an explicit verification task.

## 1. Phase 0 — Baseline and rewrite guardrails

- [x] 1.1 Verify the current branch is `master` and the working tree is clean; create the immutable `pre-specops-1.0-rewrite` tag at the commit immediately before rewrite implementation unless it already exists at that commit; do not push the tag or any commits
- [x] 1.2 In a separate temporary clone or temporary Git worktree created from `pre-specops-1.0-rewrite`, capture `npm install && npm run check && npm run smoke:opencode` output to `docs/internal/specops-1.0-baseline.txt` (do not run the legacy check pipeline in the active `master` workspace)
- [x] 1.3 Commit the current approved `SpecOps 1.0 Technical Specification` at `docs/specops-1.0-technical-spec.md`
- [x] 1.4 Write the legacy architecture inventory at `docs/internal/specops-1.0-legacy-inventory.md` (commands, tools, agents, schemas, workflow modules, generated files, scripts, state files, config fields, tests, reusable utils, deletion candidates)
- [x] 1.5 Initialise the fresh standard `openspec/` project via `openspec init --tools opencode`; confirm `openspec/config.yaml` uses `spec-driven`; commit the tracked project
- [x] 1.6 Create the standard change `rewrite-specops-1-0` via `openspec new change rewrite-specops-1-0 --schema spec-driven` (done during this planning pass)
- [x] 1.7 Add `tests/guardrails.test.ts` with boundary assertions initially skipped where dependent on later phases: exactly seven agents, no `/specops-auto`, no bundled `specops*` schemas, exact five-command set, no old protocol tool IDs, OpenSpec range `>=1.7.0 <1.8.0`, seven prompt files, `openspec/` tracked, exact six-tool catalogue
- [x] 1.8 Verify Phase 0: `openspec validate rewrite-specops-1-0 --strict` passes; guardrail tests load; baseline file exists at `docs/internal/specops-1.0-baseline.txt`

## 2. Phase 1 — OpenSpec 1.7 adapter and standard onboarding

- [x] 2.1 Extract shell-free `runProcess` and atomic-write primitives into dependency-free modules (`src/git.ts` kept; `src/state/atomic.ts` extracted)
- [x] 2.2 Create `src/openspec/version.ts`: parse `openspec --version`; enforce `>=1.7.0 <1.8.0`; reject 1.6, 1.8, and malformed output with remediation
- [x] 2.3 Create `src/openspec/schema.ts`: `getProjectSchema`/`assertStandardSchema` via `schemas --json` and `status --json schemaName`; reject non-`spec-driven` without mutating schema files
- [x] 2.4 Create `src/openspec/status.ts`, `instructions.ts`, `validation.ts`, `archive.ts` typed result modules over `--json` output
- [x] 2.5 Create `src/openspec/adapter.ts` aggregating the typed operations behind one `OpenSpecAdapter`; route all OpenSpec calls through it; report operational failures distinct from artifact validation failures
- [x] 2.6 Rewrite `scripts/onboard.mjs` to invoke `openspec init --tools opencode`, verify `openspec/config.yaml` + `spec-driven`, and stop copying bundled schemas
- [x] 2.7 Rewrite the `/specops-onboard` command template to call the new onboarding path
- [x] 2.8 Delete `schemas/specops/`, `schemas/specops-lean/`, `schemas/specops-standard/` and remove their references from `package.json`, build scripts, generated checks, and docs
- [x] 2.9 Remove the `validate:openspec` script; add `test:openspec:compat` against the installed 1.7.0 standard schema; update `check`
- [x] 2.10 Write `tests/openspec-adapter.test.ts` covering version accept/reject, schema detect/reject-without-mutation, status/instructions/validate/archive JSON parsing, operational failures, malformed JSON, and standard onboarding
- [x] 2.11 Verify Phase 1: adapter tests pass against installed `@fission-ai/openspec@1.7.0`; no custom schema files remain in the package; `/specops-onboard` produces a standard `openspec/config.yaml`

## 3. Phase 2 — Agent catalogue, prompts, and model manifest

- [x] 3.1 Create `src/agents/ids.ts` with exactly the seven final agent IDs
- [x] 3.2 Create `src/agents/registry.ts` with least-privilege `AgentPolicy` per the spec §20 permission table (coordinator-only dispatch+question; implementer-only source edit; no recursive dispatch)
- [x] 3.3 Create `src/agents/permissions.ts` defining per-agent native `edit` permission (`"ask"` for planner/designer/explorer/reviewer, `"allow"` for implementer, `"deny"` for coordinator/frontier) and the owned-path set resolver used by the `permission.ask` hook
- [x] 3.4 Register the OpenCode `permission.ask` hook to inspect edit path patterns against the active agent's owned-path set, returning `"allow"` for owned paths and `"deny"` otherwise; document the fallback (deny native edit + `specops_write_artifact` tool) only if the hook cannot expose path patterns in a packed install
- [x] 3.4 Create the seven Markdown prompt files under `prompts/` (coordinator, explorer, planner, designer, implementer, reviewer, frontier) defining role, allowed/prohibited actions, required evidence, question rules, output expectations, blocker reporting, frontier behaviour
- [x] 3.5 Create `src/prompts/loader.ts` to load packaged Markdown reliably from source and packed installs; fail on missing files
- [x] 3.6 Create `src/prompts/renderer.ts` with fail-strict named-placeholder rendering (reject missing required values and unresolved placeholders; no loops/conditionals/inheritance; delimit trusted from untrusted content)
- [x] 3.7 Create `src/agents/manifest.ts` with `SpecOpsManifest { version: 3, agents: Record<SevenRoles, {model?, variant?}> }` and `validateManifest` asserting the exact seven roles
- [x] 3.8 Update `src/installation.ts` to migrate v2 24-agent manifests to v3 seven-role (preserve obvious mappings, map interactive controller→coordinator, pick one frontier model, discard obsolete roles, report ambiguous mappings); never preserve old permissions or step policy
- [x] 3.9 Update `src/model-settings.ts` and `src/tui.ts` to show only the seven roles; preserve provider/model/variant selection
- [x] 3.10 Add `prompts/**/*.md` to `package.json files[]`; update `scripts/test-packed-install.mjs` to assert prompt files are present and loadable
- [x] 3.11 Delete `src/prompts.generated.ts` and `scripts/generate-contracts.mjs`; migrate every Phase 2-owned consumer to `src/agents/` and ensure no V1 module imports `src/capabilities/`. Leave `src/capabilities/` unchanged and unextended solely for retained legacy scheduler, workflow, orchestrator, manifest, model-settings, and TUI consumers; delete it in Phase 9.
- [x] 3.12 Write `tests/agents.test.ts`, `tests/prompts.test.ts`, and `tests/manifest.test.ts` (exact catalogue, permissions, no recursive dispatch, prompt files, packed loading, placeholder rendering, unresolved/missing-value rejection, v3 defaults, v2→v3 migration, stale catalogue rejection, TUI role list, no obsolete IDs in packaged output)
- [x] 3.13 Verify Phase 2: exactly seven agents registered; prompts load from a packed install; active V1 catalogues, registered agents, manifest defaults, prompts, TUI, permission policies, command surfaces, and runtime dispatch surfaces contain no obsolete agent IDs. Allow obsolete IDs only in explicit V2-to-V3 migration mapping code/tests, untouched Phase 9 legacy modules, and historical migration documentation.

## 4. Phase 3 — Run state, repository identity, and validation evidence

- [ ] 4.1 Create `src/state/schema.ts` with the coarse `RunState` (status, stage, identities, correction counters, repair counter, failure); no dispatches/capability IDs/provenance/facets
- [ ] 4.2 Create `src/state/paths.ts` for canonical `.specops/runs/<change>/{exploration.md, review.md, run.json, validation/}` with traversal safety
- [ ] 4.3 Create `src/state/store.ts` with atomic create/read/update, schema validation, legacy-state detection (clear incompatibility, no translation), cancellation persistence, and terminal-state protection
- [ ] 4.4 Create `src/state/recovery.ts` for coarse recovery: on resume, inspect current repository state, OpenSpec change status, and existing artifacts, then resume from the last persisted stage; no reconstruction or replay of individual model actions
- [ ] 4.5 Create `src/repository/identity.ts` with the deterministic SHA-256 repository-state identity (tracked mods, staged, deletions, untracked non-ignored; exclude `.git/`, `.specops/`, validation evidence, OpenSpec planning artifacts for the implementation-only identity)
- [ ] 4.6 Create `src/repository/baseline.ts` for dirty-tree baseline capture with user warning and no auto-reset
- [ ] 4.7 Create `src/repository/changes.ts` for changed-file summary and external-mutation detection at boundaries
- [ ] 4.8 Create `src/validation/registry.ts` for required command configuration (explicit authoritative; explorer recommendations separate until accepted)
- [ ] 4.9 Create `src/validation/executor.ts` shell-free over `runProcess`; record command id, executable, args, cwd, start/end, duration, exit code, timeout status, bounded stdout/stderr, repository identity, output hash
- [ ] 4.10 Create `src/validation/evidence.ts` for evidence persistence and invalidation on repository mutation
- [ ] 4.11 Write `tests/state.test.ts`, `tests/repository-identity.test.ts`, and `tests/validation-evidence.test.ts` (schema, atomic writes, interrupted-write safety, legacy rejection, transitions, dirty-tree baseline, deterministic hashing, untracked/deletion inclusion, metadata exclusion, external mutation, evidence persistence/invalidation, timeout, bounded output, shell-free execution, command config)
- [ ] 4.12 Verify Phase 3: run state is createable, readable, and resumable; identity is deterministic; evidence is bound to identity; no new code depends on old dispatch/scheduler state

## 5. Phase 4 — Planning workflow vertical slice

- [ ] 5.1 Create `src/workflow/coordinator.ts` for run creation (OpenSpec compat + schema check, change creation/identification, baseline capture, exploration start)
- [ ] 5.2 Create `src/workflow/stages.ts` for stage transitions
- [ ] 5.3 Create `src/workflow/planning.ts` for proposal → specs → design → tasks orchestration with OpenSpec readiness queries and instructions passed to owning agents
- [ ] 5.4 Implement exploration: coordinator dispatches explorer read-only; verify `.specops/runs/<change>/exploration.md` exists and is non-empty
- [ ] 5.5 Implement the artifact correction loop (initial write + up to two corrections; exact OpenSpec errors returned to the owning agent; exhaustion pause with retry/switch model/edit manually/cancel; TypeScript never rewrites artifact content)
- [ ] 5.6 Create `src/workflow/questions.ts` for material-question policy (permitted vs prohibited); route worker blockers to the coordinator; use OpenCode native `question`
- [ ] 5.7 Create `src/workflow/checkpoints.ts` for the single planning checkpoint (Continue / Request planning changes / Cancel) with feedback routing and revalidation
- [ ] 5.8 Implement the presentation-only planning overview
- [ ] 5.9 Update `src/commands.ts` so `/specops` starts/resumes a run via the coordinator
- [ ] 5.10 Write `tests/planning-workflow.test.ts` with fake agent runners and fake adapter responses (run creation, exploration, readiness, each artifact, valid first attempt, correction success/exhaustion, manual-edit revalidation, model-switch retry, material and prohibited questions, overview, continue, feedback on each artifact, cancellation, resume from each planning boundary)
- [ ] 5.11 Verify Phase 4: a user can run `/specops`; valid standard OpenSpec planning artifacts are produced; invalid artifacts are corrected not immediately failed; exactly one planning checkpoint is presented

## 6. Phase 5 — Implementation and project validation

- [ ] 6.1 Create `src/workflow/implementation.ts` for implementer invocation with full context (goal, exploration, proposal, specs, design, tasks, baseline, accepted validation commands, prompt)
- [ ] 6.2 Implement task-completion tracking through standard OpenSpec `tasks.md`; require required checkboxes complete before review; no second task state
- [ ] 6.3 Implement implementation blocker routing (artifact conflict → planner/designer; material decision → user; genuine blocker → frontier; ordinary failure → retry/blocked)
- [ ] 6.4 Implement frontier consultation: one call per stage attempt, read-only, advice to implementer, no recursion, exhaustion to material question or blocked
- [ ] 6.5 Create `src/validation/commands.ts` for the accepted command set (explicit authoritative; explorer recommendations accepted at the planning checkpoint)
- [ ] 6.6 Implement required validation execution: recalc identity, run all accepted required commands, persist evidence, bind to identity
- [ ] 6.7 Implement the bounded validation-fix loop: on failure return exact evidence to the implementer, bounded correction, recalc identity, rerun stale validation (separate from review repair; no unbounded loop)
- [ ] 6.8 Implement external-mutation detection before/after validation with evidence invalidation and user notification
- [ ] 6.9 Write `tests/implementation-workflow.test.ts` (complete context, checkbox updates, incomplete-task rejection, command selection, all pass, one fails, timeout, mutation after validation, untracked mutation, blocker routing, frontier permitted/rejected/exhausted, resume after interruption and failed validation)
- [ ] 6.10 Verify Phase 5: implementation works from approved artifacts; required tasks must be complete; validation is deterministic and state-bound; failed commands return actionable evidence; success leaves the run ready for review

## 7. Phase 6 — Independent review and bounded repair

- [ ] 7.1 Create `src/review/format.ts` with the required review.md format (Verdict, Reviewed state, Validation, Blocking findings, Non-blocking observations, Conclusion)
- [ ] 7.2 Create `src/review/parser.ts` parsing only verdict, reviewed repository identity, blocking finding identifiers, and required-section presence
- [ ] 7.3 Create `src/workflow/review.ts` to invoke the read-only reviewer with full context (goal, artifacts, diff, changed-file summary, identity, validation evidence, prompt)
- [ ] 7.4 Implement review freshness validation (reject on identity mismatch, stale validation, malformed verdict, missing sections)
- [ ] 7.5 Implement pass behaviour (persist reviewed identity; advance to completion checkpoint)
- [ ] 7.6 Implement repair behaviour (pass all blocking findings to implementer, increment repair count, recalc identity, rerun all required validation, rerun independent review) with default max 2 from `src/workflow/limits.ts`
- [ ] 7.7 Implement repair exhaustion (preserve code/review/evidence, set `blocked`, show remediation options)
- [ ] 7.8 Write `tests/review-workflow.test.ts` (valid pass, valid changes-required, malformed verdict, stale identity, missing sections, blocking parsing, non-blocking observations, repair success/exhaustion, validation failure during repair, mutation after review, reviewer cannot edit, no tribunal roles invoked)
- [ ] 7.9 Verify Phase 6: one reviewer independently assesses the current implementation; pass advances; blocking findings trigger bounded repair; exhaustion yields a clear blocked state; no tribunal remains

## 8. Phase 7 — Completion checkpoint, verified state, and archive

- [ ] 8.1 Create `src/workflow/finalization.ts` for the completion checkpoint (Complete and archive / Request implementation changes / Leave change open / Cancel)
- [ ] 8.2 Implement Request implementation changes (route feedback to implementer, invalidate validation+review, rerun both, re-present checkpoint)
- [ ] 8.3 Implement the verified-but-open state (`verified`; preserve active change and identities; resume later; invalidate verified evidence on repository mutation)
- [ ] 8.4 Implement finalisation checks (supported OpenSpec version, `spec-driven`, OpenSpec-valid change, all required tasks complete, all required validation passed, validated identity == current, review pass, reviewed identity == current, no repair active)
- [ ] 8.5 Implement archive through the adapter (`adapter.archiveChange`); mark `completed` only after success; prevent accidental continuation
- [ ] 8.6 Implement retryable archive failure (persist error, attempt time, identity, change; retry without rerunning when identity unchanged; require fresh validation and review when identity changed)
- [ ] 8.7 Write `tests/completion-workflow.test.ts` (overview, complete and archive, request changes, leave open, resume verified, verified invalidation, cancellation, finalisation rejections, archive success/failure/retry, mutation before retry, terminal completed)
- [ ] 8.8 Verify Phase 7: the full interactive workflow completes; user approval is required before archive; verified-open works; archive failures are recoverable; completed means OpenSpec archive succeeded

## 9. Phase 8 — Commands, status, doctor, and installation migration

- [ ] 9.1 Replace the public command set in `src/commands.ts` with exactly `/specops`, `/specops-status`, `/specops-cancel`, `/specops-doctor`, `/specops-onboard`; remove `/specops-auto` and `/specops-archive`
- [ ] 9.2 Replace `src/protocol.ts` with the exact six-tool catalogue (`specops_start_or_resume`, `specops_reconcile_stage`, `specops_get_status`, `specops_run_validation`, `specops_finalize`, `specops_cancel`); implement `specops_reconcile_stage` as the coarse boundary reconciler (inspect expected stage output, invoke OpenSpec validation where applicable, validate/parse review output where applicable, atomically persist the stage transition, return a bounded outcome); remove all dispatch/scheduler tool IDs
- [ ] 9.3 Implement `/specops-status` output (goal, change, status, stage, OpenSpec artifact status, correction attempts, identity summary, validation results, review verdict, repair count, checkpoint state, blocked/failed reason)
- [ ] 9.4 Rewrite `src/doctor.ts` with the spec §25 checks, distinguishing errors/warnings/info with remediation (legacy schema warning targets user-project installs; absence-of-required-custom-schemas validates the package)
- [ ] 9.5 Implement one-time installation migration in `src/installation.ts`: replace stale multi-agent manifests with the seven-role manifest, preserve obvious model mappings and supported configuration values, remove known obsolete SpecOps fields, report all removed settings through doctor or migration output, atomically persist the migrated V1 configuration, apply strict V1 validation after migration; do not delete legacy schemas automatically, do not resume legacy runs, do not silently rewrite unrelated user config
- [ ] 9.6 Update package exports to refer only to the new architecture; remove old-orchestration-only exports and the `eval:review-fixer` script
- [ ] 9.7 Write tests for exact command set, no auto/archive commands, exact six-tool set, `specops_reconcile_stage` bounded outcomes, status for every state, doctor success/unsupported-OpenSpec/legacy-schema/legacy-state, one-time config migration (obsolete removed and reported, supported preserved, strict validation after, runs once), packed install, plugin registration, command agent targets
- [ ] 9.8 Verify Phase 8: the public surface matches the specification exactly; migration is clear and non-destructive; doctor diagnoses setup and legacy issues; no command or tool references old workflow concepts

## 10. Phase 9 — Legacy architecture removal

- [ ] 10.1 Delete the old workflow engine modules (`src/workflow/{engine,scheduler,actions,directive,contracts,contracts.generated,archive,completion,interactive,questions,reviews,run-start,run-state,writer-guards,artifacts,previews,checkpoints}.ts`) after confirming no residual imports
- [ ] 10.2 Delete `src/capabilities/` only after every retained legacy consumer is removed or migrated, then delete `src/protocol.ts` (replaced) and `scripts/evaluate-review-fixer.mjs`; verify legacy capability modules are absent from packaged output, obsolete IDs remain only where strictly required for one-time V2-to-V3 migration, and no obsolete ID is reachable through the active runtime or public package exports
- [ ] 10.3 Delete `src/escalation/`, `src/frontier/`, `src/routing/`, `src/artifacts/`, and `src/evidence/registry.ts` (folded into `validation/registry.ts`)
- [ ] 10.4 Rewrite `src/types.ts` to remove obsolete concepts (tiers, risk facets, capability IDs, dispatch purposes, frontier tiers, judgments, refutation, escalation claims, old repair modes, artifact invalidation graphs, checkpoint provenance)
- [ ] 10.5 Rewrite `src/config.ts` as `src/config/{defaults,loader,schema,migration}.ts` exposing only the minimal V1 fields (seven-role model mappings and variants, OpenSpec command override, required validation commands, validation timeouts, bounded output capture, MCP integration toggle); keep correction/repair/transient-retry/frontier limits as internal constants in `src/workflow/limits.ts`; delete `src/config/fields.ts` and `src/config/sections.ts` after porting retained fields
- [ ] 10.6 Delete `src/orchestrator.ts` (replaced by `src/plugin.ts` + `src/index.ts`), `src/worker_output.ts`, and `src/manifest.ts` (folded into `src/agents/manifest.ts`)
- [ ] 10.7 Delete `examples/specops.schema.json`, `examples/specops.json`, and `examples/specops.global.json` (document the removed config shape); replace with V1 minimal config examples if needed
- [ ] 10.8 Delete obsolete tests asserting removed behaviour (lean/standard/full routing, specialist selection, correctness/compliance judgments, refutation, typed escalation, dispatch recovery, automatic mode, phase-by-phase checkpoints, custom schema validation, generated contracts); replace with tests for the new product requirements
- [ ] 10.9 Run `npm run deadcode:check` (knip) and remove dead modules, unused exports, stale scripts, unused dependencies, and obsolete generated outputs
- [ ] 10.10 Search for excluded architecture terms (`lean`, `standard`, `full`, `refuter`, `correctness-judge`, `compliance-judge`, `specialist`, `dispatchId`, `nextAction`, `completeAction`, `riskFacet`, `frontier-low`, `frontier-high`, `specops-auto`, `specops-lean`, `specops-standard`); review matches manually; keep legitimate prose, delete active architecture references
- [ ] 10.11 Verify Phase 9: no old scheduler/dispatch engine, custom schemas, obsolete agents, old protocol tools, or dead compatibility layer remain; `deadcode:check` passes; no active references to excluded architecture terms outside migration docs and changelog

## 11. Phase 10 — Documentation, end-to-end validation, and release preparation

- [ ] 11.1 Rewrite documentation (README, architecture, workflows, agents, commands, configuration, artifacts-and-state, troubleshooting, development, security-and-integrations, getting-started, CHANGELOG) to describe only the final architecture
- [ ] 11.2 Document the OpenSpec-first rule prominently, the supported OpenSpec range, the `spec-driven`-only requirement, no custom schemas, normal OpenSpec interoperability, the upgrade policy, and that `openspec/` is tracked
- [ ] 11.3 Document V1 exclusions (interactive only; no automatic mode; no custom schemas; no specialist agents; no required skills; no workflow tiers)
- [ ] 11.4 Create end-to-end fixtures for the 18 required scenarios (trivial bug fix, small feature, multi-file feature, design-heavy change, invalid proposal correction, invalid spec correction, failed project validation, blocking review repair, correction exhaustion, material question, planning feedback, completion feedback, dirty tree, external mutation, interrupted run, archive failure, verified-open resume, successful archive)
- [ ] 11.5 Run real smoke workflows with at least two materially different model families; record prompt-following failures, tool-call failures, invalid artifact rates, correction success, review quality, repair success, and user friction; fix prompts before adding orchestration complexity
- [ ] 11.6 Finalise the package check pipeline: `format` → `typecheck` → `deadcode:check` → unit tests → integration tests → `test:packed` → `test:openspec:compat` → `docs:check` → `smoke:opencode`; remove generation stages no longer serving the final architecture
- [ ] 11.7 Write release migration notes (old runs cannot resume; old custom schemas no longer used and not deleted automatically; model mappings may be migrated; `/specops-auto` removed; automatic mode deferred; users should run `/specops-doctor` after upgrade)
- [ ] 11.8 Verify Phase 10: every required end-to-end scenario has evidence; two model families complete representative workflows; documentation matches runtime; packed installation succeeds; no generated or bundled custom schema remains; the version is ready to become `1.0.0`

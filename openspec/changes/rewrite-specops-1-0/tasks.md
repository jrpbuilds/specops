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

- [x] 4.1 Create `src/state/schema.ts` with the coarse `RunState` (status, stage, identities, correction counters, repair counter, failure); no dispatches/capability IDs/provenance/facets
- [x] 4.2 Create `src/state/paths.ts` for canonical `.specops/runs/<change>/{exploration.md, review.md, run.json, validation/}` with traversal safety
- [x] 4.3 Create `src/state/store.ts` with atomic create/read/update, schema validation, legacy-state detection (clear incompatibility, no translation), cancellation persistence, and terminal-state protection
- [x] 4.4 Create `src/state/recovery.ts` for coarse recovery: on resume, inspect current repository state, OpenSpec change status, and existing artifacts, then resume from the last persisted stage; no reconstruction or replay of individual model actions
- [x] 4.5 Create `src/repository/identity.ts` with the deterministic SHA-256 repository-state identity (tracked mods, staged, deletions, untracked non-ignored; exclude `.git/`, `.specops/`, validation evidence, OpenSpec planning artifacts for the implementation-only identity)
- [x] 4.6 Create `src/repository/baseline.ts` for dirty-tree baseline capture with user warning and no auto-reset
- [x] 4.7 Create `src/repository/changes.ts` for changed-file summary and external-mutation detection at boundaries
- [x] 4.8 Create `src/validation/registry.ts` for required command configuration (explicit authoritative; explorer recommendations separate until accepted)
- [x] 4.9 Create `src/validation/executor.ts` shell-free over `runProcess`; record command id, executable, args, cwd, start/end, duration, exit code, timeout status, bounded stdout/stderr, repository identity, output hash
- [x] 4.10 Create `src/validation/evidence.ts` for evidence persistence and invalidation on repository mutation
- [x] 4.11 Write `tests/state.test.ts`, `tests/repository-identity.test.ts`, and `tests/validation-evidence.test.ts` (schema, atomic writes, interrupted-write safety, legacy rejection, transitions, dirty-tree baseline, deterministic hashing, untracked/deletion inclusion, metadata exclusion, external mutation, evidence persistence/invalidation, timeout, bounded output, shell-free execution, command config)
- [x] 4.12 Verify Phase 3: run state is createable, readable, and resumable; identity is deterministic; evidence is bound to identity; no new code depends on old dispatch/scheduler state

## 5. Phase 4 — Planning workflow vertical slice

- [x] 5.1 Create `src/workflow/coordinator.ts` for run creation (OpenSpec compat + schema check, change creation/identification, baseline capture, exploration start)
- [x] 5.2 Create `src/workflow/stages.ts` for stage transitions
- [x] 5.3 Create `src/workflow/planning.ts` for proposal → specs → design → tasks orchestration with OpenSpec readiness queries and instructions passed to owning agents
- [x] 5.4 Implement exploration: coordinator dispatches explorer read-only; verify `.specops/runs/<change>/exploration.md` exists and is non-empty
- [x] 5.5 Implement the artifact correction loop (initial write + up to two corrections; exact OpenSpec errors returned to the owning agent; exhaustion pause with retry/switch model/edit manually/cancel; TypeScript never rewrites artifact content)
- [x] 5.6 Create `src/workflow/questions.ts` for material-question policy (permitted vs prohibited); route worker blockers to the coordinator; use OpenCode native `question`
- [x] 5.7 Create `src/workflow/checkpoints.ts` for the single planning checkpoint (Continue / Request planning changes / Cancel) with feedback routing and revalidation
- [x] 5.8 Implement the presentation-only planning overview
- [x] 5.9 Update `src/commands.ts` so `/specops` starts/resumes a run via the coordinator
- [x] 5.10 Write `tests/planning-workflow.test.ts` with fake agent runners and fake adapter responses (run creation, exploration, readiness, each artifact, valid first attempt, correction success/exhaustion, manual-edit revalidation, model-switch retry, material and prohibited questions, overview, continue, feedback on each artifact, cancellation, resume from each planning boundary)
- [x] 5.11 Verify Phase 4: a user can run `/specops`; valid standard OpenSpec planning artifacts are produced; invalid artifacts are corrected not immediately failed; exactly one planning checkpoint is presented

## 6. Phase 5 — Implementation and project validation

- [x] 6.1 Create `src/workflow/implementation.ts` for implementer invocation with full context (goal, exploration, proposal, specs, design, tasks, baseline, accepted validation commands, prompt)
- [x] 6.2 Implement task-completion tracking through standard OpenSpec `tasks.md`; require required checkboxes complete before review; no second task state
- [x] 6.3 Implement implementation blocker routing (artifact conflict → planner/designer; material decision → user; genuine blocker → frontier; ordinary failure → retry/blocked)
- [x] 6.4 Implement frontier consultation: one call per stage attempt, read-only, advice to implementer, no recursion, exhaustion to material question or blocked
- [x] 6.5 Create `src/validation/commands.ts` for the accepted command set (explicit authoritative; explorer recommendations accepted at the planning checkpoint)
- [x] 6.6 Implement required validation execution: recalc identity, run all accepted required commands, persist evidence, bind to identity
- [x] 6.7 Implement the bounded validation-fix loop: on failure return exact evidence to the implementer, bounded correction, recalc identity, rerun stale validation (separate from review repair; no unbounded loop)
- [x] 6.8 Implement external-mutation detection before/after validation with evidence invalidation and user notification
- [x] 6.9 Write `tests/implementation-workflow.test.ts` (complete context, checkbox updates, incomplete-task rejection, command selection, all pass, one fails, timeout, mutation after validation, untracked mutation, blocker routing, frontier permitted/rejected/exhausted, resume after interruption and failed validation)
- [x] 6.10 Verify Phase 5: implementation works from approved artifacts; required tasks must be complete; validation is deterministic and state-bound; failed commands return actionable evidence; success leaves the run ready for review

## 7. Phase 6 — Independent review and bounded repair

- [x] 7.1 Create `src/review/format.ts` with the required review.md format (Verdict, Reviewed state, Validation, Blocking findings, Non-blocking observations, Conclusion)
- [x] 7.2 Create `src/review/parser.ts` parsing only verdict, reviewed repository identity, blocking finding identifiers, and required-section presence
- [x] 7.3 Create `src/workflow/review.ts` to invoke the read-only reviewer with full context (goal, artifacts, diff, changed-file summary, identity, validation evidence, prompt)
- [x] 7.4 Implement review freshness validation (reject on identity mismatch, stale validation, malformed verdict, missing sections)
- [x] 7.5 Implement pass behaviour (persist reviewed identity; advance to completion checkpoint)
- [x] 7.6 Implement repair behaviour (pass all blocking findings to implementer, increment repair count, recalc identity, rerun all required validation, rerun independent review) with default max 2 from `src/workflow/limits.ts`
- [x] 7.7 Implement repair exhaustion (preserve code/review/evidence, set `blocked`, show remediation options)
- [x] 7.8 Write `tests/review-workflow.test.ts` (valid pass, valid changes-required, malformed verdict, stale identity, missing sections, blocking parsing, non-blocking observations, repair success/exhaustion, validation failure during repair, mutation after review, reviewer cannot edit, no tribunal roles invoked)
- [x] 7.9 Verify Phase 6: one reviewer independently assesses the current implementation; pass advances; blocking findings trigger bounded repair; exhaustion yields a clear blocked state; no tribunal remains

## 8. Phase 7 — Completion checkpoint, verified state, and archive

- [x] 8.1 Create `src/workflow/finalize.ts` for the completion checkpoint (Complete and archive / Request implementation changes / Leave change open / Cancel)
- [x] 8.2 Implement Request implementation changes (route feedback to implementer, invalidate validation+review, rerun both, re-present checkpoint)
- [x] 8.3 Implement the verified-but-open state (`verified`; preserve active change and identities; resume later; invalidate verified evidence on repository mutation)
- [x] 8.4 Implement finalisation checks (supported OpenSpec version, `spec-driven`, OpenSpec-valid change, all required tasks complete, all required validation passed, validated identity == current, review pass, reviewed identity == current, no repair active)
- [x] 8.5 Implement archive through the adapter (`adapter.archiveChange`); mark `completed` only after success; prevent accidental continuation
- [x] 8.6 Implement retryable archive failure (persist error, attempt time, identity, change; retry without rerunning when identity unchanged; require fresh validation and review when identity changed)
- [x] 8.7 Write `tests/completion-workflow.test.ts` (overview, complete and archive, request changes, leave open, resume verified, verified invalidation, cancellation, finalisation rejections, archive success/failure/retry, mutation before retry, terminal completed)
- [x] 8.8 Verify Phase 7: the full interactive workflow completes; user approval is required before archive; verified-open works; archive failures are recoverable; completed means OpenSpec archive succeeded

## 9. Phase 8 — Commands, status, doctor, and installation migration

- [x] 9.1 Replace the public command set in `src/commands.ts` with exactly `/specops`, `/specops-status`, `/specops-cancel`, `/specops-doctor`, `/specops-onboard`; remove `/specops-auto` and `/specops-archive`
- [x] 9.2 Replace `src/protocol.ts` with the exact six-tool catalogue (`specops_start_or_resume`, `specops_reconcile_stage`, `specops_get_status`, `specops_run_validation`, `specops_finalize`, `specops_cancel`); implement `specops_reconcile_stage` as the coarse boundary reconciler (inspect expected stage output, invoke OpenSpec validation where applicable, validate/parse review output where applicable, atomically persist the stage transition, return a bounded outcome); remove all dispatch/scheduler tool IDs
- [x] 9.3 Implement `/specops-status` output (goal, change, status, stage, OpenSpec artifact status, correction attempts, identity summary, validation results, review verdict, repair count, checkpoint state, blocked/failed reason)
- [x] 9.4 Rewrite `src/doctor.ts` with the spec §25 checks, distinguishing errors/warnings/info with remediation (legacy schema warning targets user-project installs; absence-of-required-custom-schemas validates the package)
- [x] 9.5 Implement one-time installation migration in `src/installation.ts`: replace stale multi-agent manifests with the seven-role manifest, preserve obvious model mappings and supported configuration values, remove known obsolete SpecOps fields, report all removed settings through doctor or migration output, atomically persist the migrated V1 configuration, apply strict V1 validation after migration; do not delete legacy schemas automatically, do not resume legacy runs, do not silently rewrite unrelated user config
- [x] 9.6 Update package exports to refer only to the new architecture; remove old-orchestration-only exports and the `eval:review-fixer` script
- [x] 9.7 Write tests for exact command set, no auto/archive commands, exact six-tool set, `specops_reconcile_stage` bounded outcomes, status for every state, doctor success/unsupported-OpenSpec/legacy-schema/legacy-state, one-time config migration (obsolete removed and reported, supported preserved, strict validation after, runs once), packed install, plugin registration, command agent targets
- [x] 9.8 Verify Phase 8: the public surface matches the specification exactly; migration is clear and non-destructive; doctor diagnoses setup and legacy issues; no command or tool references old workflow concepts

## 10. Phase 9 — Legacy architecture removal

- [x] 10.1 Delete the old workflow engine modules (`src/workflow/{engine,finalization,scheduler,actions,directive,contracts,contracts.generated,archive,completion,interactive,questions,reviews,run-start,run-state,writer-guards,artifacts,previews,checkpoints}.ts`) after confirming no residual imports
- [x] 10.2 Delete `src/capabilities/` only after every retained legacy consumer is removed or migrated, then delete `src/protocol.ts` (replaced) and `scripts/evaluate-review-fixer.mjs`; verify legacy capability modules are absent from packaged output, obsolete IDs remain only where strictly required for one-time V2-to-V3 migration, and no obsolete ID is reachable through the active runtime or public package exports
- [x] 10.3 Delete `src/escalation/`, `src/frontier/`, `src/routing/`, `src/artifacts/`, and `src/evidence/registry.ts` (folded into `validation/registry.ts`)
- [x] 10.4 Rewrite `src/types.ts` to remove obsolete concepts (tiers, risk facets, capability IDs, dispatch purposes, frontier tiers, judgments, refutation, escalation claims, old repair modes, artifact invalidation graphs, checkpoint provenance)
- [x] 10.5 Rewrite `src/config.ts` as `src/config/{defaults,loader,schema,migration}.ts` exposing only the minimal V1 fields (seven-role model mappings and variants, OpenSpec command override, required validation commands, validation timeouts, bounded output capture, MCP integration toggle); keep correction/repair/transient-retry/frontier limits as internal constants in `src/workflow/limits.ts`; delete `src/config/fields.ts` and `src/config/sections.ts` after porting retained fields
- [x] 10.6 Delete `src/orchestrator.ts` (replaced by `src/plugin.ts` + `src/index.ts`), `src/worker_output.ts`, and `src/manifest.ts` (folded into `src/agents/manifest.ts`)
- [x] 10.7 Delete `examples/specops.schema.json`, `examples/specops.json`, and `examples/specops.global.json` (document the removed config shape); replace with V1 minimal config examples if needed
- [x] 10.8 Delete obsolete tests asserting removed behaviour (lean/standard/full routing, specialist selection, correctness/compliance judgments, refutation, typed escalation, dispatch recovery, automatic mode, phase-by-phase checkpoints, custom schema validation, generated contracts); replace with tests for the new product requirements
- [x] 10.9 Run `npm run deadcode:check` (knip) and remove dead modules, unused exports, stale scripts, unused dependencies, and obsolete generated outputs
- [x] 10.10 Search for excluded architecture terms (`lean`, `standard`, `full`, `refuter`, `correctness-judge`, `compliance-judge`, `specialist`, `dispatchId`, `nextAction`, `completeAction`, `riskFacet`, `frontier-low`, `frontier-high`, `specops-auto`, `specops-lean`, `specops-standard`); review matches manually; keep legitimate prose, delete active architecture references
- [x] 10.11 Verify Phase 9: no old scheduler/dispatch engine, custom schemas, obsolete agents, old protocol tools, or dead compatibility layer remain; `deadcode:check` passes; no active references to excluded architecture terms outside migration docs and changelog; legacy `src/workflow/finalization.ts` is deleted and no active V1 runtime imports it; `src/workflow/finalize.ts` remains the canonical V1 finalisation module

## 11. Phase 10 — Documentation, end-to-end validation, and release preparation

- [x] 11.1 Rewrite documentation (README, architecture, workflows, agents, commands, configuration, artifacts-and-state, troubleshooting, development, security-and-integrations, getting-started, CHANGELOG) to describe only the final architecture
- [x] 11.2 Document the OpenSpec-first rule prominently, the supported OpenSpec range, the `spec-driven`-only requirement, no custom schemas, normal OpenSpec interoperability, the upgrade policy, and that `openspec/` is tracked
- [x] 11.3 Document V1 exclusions (interactive only; no automatic mode; no custom schemas; no specialist agents; no required skills; no workflow tiers)
- [x] 11.4 Create end-to-end fixtures for the 18 required scenarios (trivial bug fix, small feature, multi-file feature, design-heavy change, invalid proposal correction, invalid spec correction, failed project validation, blocking review repair, correction exhaustion, material question, planning feedback, completion feedback, dirty tree, external mutation, interrupted run, archive failure, verified-open resume, successful archive)
- [ ] 11.5 Run real smoke workflows with at least two materially different model families; record prompt-following failures, tool-call failures, invalid artifact rates, correction success, review quality, repair success, and user friction; fix prompts before adding orchestration complexity — Phase 10 only produced self-contained surface-count probes (`docs/internal/specops-1.0-model-smoke.md`); the full two-model-family interactive metrics were not recorded, so this checkbox is corrected to incomplete (Phase 11 task 12.4.8)
- [x] 11.6 Finalise the package check pipeline: `format` → `typecheck` → `deadcode:check` → unit tests → integration tests → `test:packed` → `test:openspec:compat` → `docs:check` → `smoke:opencode`; remove generation stages no longer serving the final architecture
- [x] 11.7 Write release migration notes (old runs cannot resume; old custom schemas no longer used and not deleted automatically; model mappings may be migrated; `/specops-auto` removed; automatic mode deferred; users should run `/specops-doctor` after upgrade)
- [ ] 11.8 Verify Phase 10: every required end-to-end scenario has evidence; two model families complete representative workflows; documentation matches runtime; packed installation succeeds; no generated or bundled custom schema remains; the version is ready to become `1.0.0 — blocked by the corrected task 11.5 (real two-model-family interactive smoke metrics)

## 12. Phase 11 — Adversarial remediation and release proof

A cold adversarial review of the completed SpecOps 1.0 implementation produced release-blocking findings B-01 through B-12. These findings are defect evidence against the already-approved proposal, delta specifications, design, and technical specification; they do not authorize a redesign of SpecOps. This phase repairs the approved V1 wiring and adds the integrity, hardening, and release-proof coverage that the approved design already requires. Do not recreate `nextAction`, scheduler directives, dispatch IDs, capability graphs, or a hidden controller protocol. Do not broaden product scope or add deferred 1.1 functionality. Add a regression test reproducing each reproduced defect before applying the fix where practical. Prefer fixes to active V1 code over compatibility layers.

### 12.1 Active runtime integration (B-01, B-08, B-11)

- [x] 12.1.1 Reproduce B-01: add a regression test proving the registered `specops_start_or_resume` tool creates a run but never drives the approved V1 planning workflow (no OpenSpec readiness query, no instructions passed to the planner/designer/explorer through the active runtime); the coordinator planning path is unreachable from the packed six-tool surface
- [x] 12.1.2 Repair B-01: wire the registered `specops_start_or_resume` surface to the approved V1 planning path so OpenSpec readiness queries and artifact instructions reach the correct owning agents through the active runtime; keep the six-tool catalogue; do not add workflow tools; persist a planning-approval marker in `run.json` rather than relying on conversational memory
- [x] 12.1.3 Reproduce B-08: add a regression test proving only one of the four completion actions is reachable through `specops_finalize` (it hardcodes complete-and-archive) and that the registered `specops_reconcile_stage` review path increments the repair counter without enforcing `MAX_REVIEW_REPAIRS`
- [x] 12.1.4 Repair B-08: make all four completion actions (complete-and-archive, request-implementation-changes, leave-change-open, cancel) reachable through the registered finalizer; replace the broken `completionOptions` stub with the real accepted validation command set and reviewer options; enforce the configured review-repair limit (`MAX_REVIEW_REPAIRS`) on the registered reconciliation path so exhaustion yields the blocked state
- [x] 12.1.5 Reproduce B-08: add a regression test proving accepted validation-command selection is persisted in `run.json` but not reachable through `specops_run_validation` (it reads configured commands, ignoring persisted accepted recommendations)
- [x] 12.1.6 Repair B-08: make `specops_run_validation` resolve the accepted validation-command set (configured plus persisted accepted recommendation ids) so the accepted selection is both persisted and reachable
- [x] 12.1.7 Reproduce B-11: add a regression test proving `/specops-doctor` and onboarding build their OpenSpec adapter without the configured OpenSpec command override and a non-deterministic working directory, so doctor behaviour is not deterministic with respect to V1 configuration
- [x] 12.1.8 Repair B-11: make doctor and onboarding deterministic with respect to the V1 configuration (use the configured OpenSpec command override and a repository-root working directory); add a test asserting the configured seven-role manifest mappings drive registered agent model assignment through the actual plugin `config` hook (verify `manifest.agents[id].model`/`variant` appear in `config.agent[id]`)

### 12.2 Freshness and completion integrity (B-02, B-03, B-04, B-06)

- [ ] 12.2.1 Reproduce B-02: add a regression test proving a review's reviewed identity excludes reviewed OpenSpec planning artifacts, so changing a reviewed planning artifact after review does not invalidate the review - STOPPED: B-02 requires an architectural amendment (broadens review parser/identity beyond the approved design); recorded as `it.todo` in `tests/phase11-integrity.test.ts` and left for explicit amendment rather than silently inventing one
- [ ] 12.2.2 Repair B-02: bind the review identity to both the implementation repository state and the exact reviewed OpenSpec planning artifacts (hash the active change's proposal/specs/design/tasks); invalidate the review after any reviewed planning artifact changes; persist the binding in the review artifact and run state - STOPPED: requires architectural amendment (see 12.2.1)
- [x] 12.2.3 Reproduce B-03: add a regression test proving only accepted recommendation ids are persisted and the canonical accepted-validation-command definitions are not, so a configuration change between planning and completion silently changes the validation set
- [x] 12.2.4 Repair B-03: persist the canonical accepted-validation-command definitions (id, executable, args, cwd, timeoutMs, maxOutputBytes) accepted at the planning checkpoint; make completion and validation resolve the accepted set from the persisted canonical definitions
- [x] 12.2.5 Reproduce B-04: add a regression test proving a stale evidence record with the same command id but a different executable/args/cwd/timeout satisfies the finalisation and review gates
- [x] 12.2.6 Repair B-04: bind validation evidence to the complete canonical command definition (hash executable+args+cwd+timeoutMs+maxOutputBytes) rather than command id alone; reject evidence whose command definition hash does not match the accepted canonical definition
- [x] 12.2.7 Reproduce B-06 (parsing): add a regression test proving malformed review Markdown (missing sections, ambiguous verdict, non-hex identity, duplicate findings) is accepted or crashes rather than failing closed
- [x] 12.2.8 Repair B-06 (parsing): make review Markdown parsing fail-closed on any malformed or ambiguous field; add semantic validation requiring a passing review to contain no blocking findings and a changes-required review to contain blocking findings
- [x] 12.2.9 Reproduce B-06 (invariants): add a regression test proving a corrupted `run.json` with illegal status/stage/evidence/archive combinations is accepted
- [x] 12.2.10 Repair B-06 (invariants): add legal run status/stage/evidence/archive cross-invariants to `assertRunState` (e.g. `completed` implies `archivedAt`; `verified` implies stage `archive`; non-null validated identity only after the validation boundary; non-null reviewed identity only after the review boundary); reject corruption on read
- [x] 12.2.11 Reproduce B-06 (crash window): add a regression test simulating a crash after OpenSpec archive succeeds but before local completion state is persisted, proving the run re-attempts archive against an already-archived change
- [x] 12.2.12 Repair B-06 (crash window): add crash-safe recovery for the post-archive window; on resume detect that OpenSpec already archived the change and mark the run `completed` without re-invoking archive; no state may become `completed` unless upstream OpenSpec archival is proven to have succeeded
- [x] 12.2.13 Reproduce B-06 (run creation): add a regression test proving `createV1Run` leaves an abandoned `.<uuid>.create` file on disk and is not exclusive against concurrent creation
- [x] 12.2.14 Repair B-06 (run creation): make run creation exclusive and atomic (single atomic write with an existence precheck, no abandoned `.create` copies; reject concurrent creation deterministically)

### 12.3 Permission, filesystem, process, and repository-state hardening (B-05, B-07, B-09, B-10)

- [x] 12.3.1 Reproduce B-05: add a regression test proving the `permission.ask` hook is constructed with an empty owned-path context, so path-scoped writers fall back to the `*` change wildcard
- [x] 12.3.2 Repair B-05: resolve a trusted active change and stage for each path-scoped writer from persisted run state and the active session, and pass them into `ownedPathPatterns`; never fall back to `*` when an active run exists
- [x] 12.3.3 Reproduce B-07: add a regression test proving any agent (including the implementer) can call any `specops_*` workflow tool, and that the implementer (native `edit: allow`) can write `.specops` managed state and non-owned OpenSpec planning artifacts
- [x] 12.3.4 Repair B-07: authorize workflow tools by caller role/session (only the coordinator may drive `specops_start_or_resume`, `specops_reconcile_stage`, `specops_run_validation`, `specops_finalize`; `specops_cancel`/`specops_get_status` remain broadly callable); protect `.specops` managed state and non-owned OpenSpec artifacts from implementer writes; apply role-appropriate MCP restrictions (coordinator and read-only agents deny MCP tools; only the implementer honours the configured MCP toggle)
- [x] 12.3.5 Reproduce B-09: add a regression test proving a timed-out validation process is only sent SIGTERM with no process-group termination, no grace period, and no forced kill, so descendants survive
- [x] 12.3.6 Repair B-09: run validation (and OpenSpec) processes in their own process group with a hard timeout, SIGTERM to the group, a bounded grace period, then SIGKILL to the group; record the timeout and forced-kill in evidence
- [x] 12.3.7 Reproduce B-10: add a regression test proving the repository identity reads worktree content for staged files (ignoring index blob/mode), follows symlinks, loses the new path on renames, and does not separately capture blob mode
- [x] 12.3.8 Repair B-10: build the canonical repository identity from Git index blob and mode state separately from worktree state using `git ls-files`/`git cat-file` plumbing; correctly handle staged content, mode changes, symlinks (link target, not followed content), renames (both paths), unusual filenames, deletions, and untracked files
- [x] 12.3.9 Reproduce B-07 (symlink containment): add a regression test proving a symlinked managed-state root, validation cwd, or model-readable/writable artifact path can escape its intended root
- [x] 12.3.10 Repair B-07 (symlink containment): add symlink-safe containment for managed state roots, validation cwd, and model-readable/writable artifact paths (resolve and reject any path that escapes its root through a symlink)

### 12.4 Release-proof correction (B-12 and stale release material)

- [x] 12.4.1 Reproduce B-12: add a regression test proving `tests/e2e-v1.test.ts` only asserts source-string containment in other test files, not deterministic packed/runtime workflow execution
- [x] 12.4.2 Repair B-12: replace the source-string "E2E" inventory with actual deterministic packed/runtime workflow tests exercising all 18 required V1 scenarios through the active six-tool surface; each scenario must drive the registered tools with deterministic agent and OpenSpec fakes and assert the bounded outcome
- [x] 12.4.3 Reproduce B-12: add a test proving `test:openspec:compat` only invokes the OpenSpec CLI and does not exercise the `OpenSpecAdapter` TypeScript class against installed OpenSpec 1.7.0 JSON behaviour
- [x] 12.4.4 Repair B-12: add actual `OpenSpecAdapter` compatibility tests against the installed `@fission-ai/openspec@1.7.0` JSON output (version, schemas, status, instructions, validation, archive parsing); keep the CLI compat check as a secondary gate
- [x] 12.4.5 Verify the immutable `pre-specops-1.0-rewrite` tag requirement: confirm the tag exists and document its exact commit; if it cannot sit at the commit immediately before rewrite implementation on this machine, amend task 1.1 truthfully to record the tag's actual placement and why moving an immutable tag is not performed
- [x] 12.4.6 Remove or update stale packed `examples/` material describing `/specops-auto`, deleted `specops.json`/`specops.schema.json`/`specops.global.json` files, and old workflow tiers; replace with V1 minimal configuration examples that match the active configuration surface
- [x] 12.4.7 Remove or update stale `site/` material describing `/specops-auto`, `specops-auto-controller`, `/specops-archive`, old workflow tiers, and deleted config/schema files so the website describes only the final five-command / six-tool V1 surface
- [x] 12.4.8 Correct any Phase 10 task checkbox whose claimed evidence was not actually produced: re-evaluate task 11.5 (real two-model-family smoke with prompt-following, tool-call, invalid-artifact, correction, review, repair, and friction metrics) and either produce the real evidence or amend the checkbox and record truthfully
- [x] 12.4.9 Verify a clean installation actually resolves `@fission-ai/openspec` within the supported `>=1.7.0 <1.8.0` range; record the resolved version in the remediation report

### 12.5 Phase 11 verification and remediation report

- [ ] 12.5.1 Re-run every original audit case and prove it now fails safely; record the reproduction-to-fix mapping
- [ ] 12.5.2 Run the full release-proof pipeline from a clean checkout: `npm ci`, formatting, typecheck, dead-code analysis, full unit/integration tests, real V1 E2E tests, packed-install tests, OpenCode packed-plugin smoke tests, OpenSpec adapter compatibility tests, docs checks, `git diff --check`, and strict OpenSpec validation
- [ ] 12.5.3 Produce the final remediation report mapping every B-01 through B-12 finding to: fix commit, regression test, verification evidence, and final disposition; do not publish, push, archive the OpenSpec change, or mark SpecOps 1.0 release-ready merely because the existing test suite passes

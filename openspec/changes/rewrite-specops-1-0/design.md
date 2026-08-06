## Context

SpecOps 0.x (`@jrpbuilds/specops@0.16.2`) ships a 24-agent capability registry, three custom OpenSpec schemas (`specops`, `specops-lean`, `specops-standard`), a generated wire-contract protocol (`src/prompts.generated.ts`, `scripts/generate-contracts.mjs`), a dispatch scheduler (`src/workflow/scheduler.ts`, `engine.ts`, `directive.ts`, `actions.ts`), and a review tribunal (`src/escalation/`, `src/frontier/`, `src/routing/`, correctness/compliance judges, refuter). See `proposal.md - Why` for motivation.

The rewrite is performed directly on `master`, with the immutable `pre-specops-1.0-rewrite` tag preserving the pre-implementation baseline. The existing 0.x architecture is what is being rewritten; the design is not anchored to any incidental maintenance branch. Reusable, dependency-free utilities to carry forward: `src/git.ts runProcess` (shell-free), `src/security/redact.ts`, the atomic-write primitives inside `src/state/store.ts`, and the model-selection TUI in `src/tui.ts` (after the role list is trimmed to seven). OpenSpec 1.7.0 is already pinned (`@fission-ai/openspec@1.7.0`); its JSON surface has been verified for `--version`, `schemas --json`, `status --change <id> --json`, `instructions <artifact> --change <id> --json`, `validate [item] --json`, `archive <change> --json -y`, and `init --tools opencode`.

The repository's `openspec/` tree was deleted by the user (it contained obsolete testing changes and custom SpecOps schemas) and is no longer gitignored; a fresh standard `spec-driven` project has been initialised and tracked, and the `rewrite-specops-1-0` change exists in it.

## Goals / Non-Goals

**Goals:**
- One bounded interactive workflow driven by a thin OpenSpec 1.7 adapter, delegating readiness, instructions, validation, and archival to OpenSpec.
- Exactly seven agents with least-privilege permissions and editable Markdown prompts.
- Coarse run state, deterministic repository-state identity, and validation/review evidence bound to identity.
- Two user checkpoints (planning, completion) and OpenSpec archival only after explicit approval.
- A minimal V1 configuration surface and an exact, minimal plugin tool catalogue.
- Full removal of legacy workflow machinery and obsolete tests.

**Non-Goals:**
- Automatic, unattended, CI, or non-interactive execution (deferred beyond 1.0).
- Custom OpenSpec schemas, parallel artifact dependency graphs, or duplicated OpenSpec validation.
- Review tribunals, refuters, judges, specialist reviewers, or skills.
- Workflow tiers, capability graphs, dispatch protocols, typed escalation, or artifact invalidation engines.
- Automatic rollback or backward-compatible resumption of old workflow runs.

## Decisions

### Decision: Baseline captured in a separate clone, not the rewrite workspace

The legacy `npm run check` pipeline invokes `validate:openspec` → `npm run onboard`, which regenerates obsolete custom OpenSpec schemas (`specops`, `specops-lean`, `specops-standard`) into `openspec/`. Running it inside the rewrite workspace would re-introduce the very schemas the rewrite deletes and would conflict with the fresh tracked standard `openspec/` project.

**Chosen:** Capture the Phase 0 baseline (`npm install && npm run check && npm run smoke:opencode`) in a **separate temporary worktree or clone** created from `pre-specops-1.0-rewrite` (`docs/internal/specops-1.0-baseline.txt`). The active `master` workspace never runs the legacy `check` pipeline; it adopts the new pipeline as it lands.

**Alternatives considered:** Disable `validate:openspec` before baseline (rejected — would not capture the true legacy state); run baseline then delete regenerated `openspec/` (rejected — risks leaving stale artifacts in the rewrite workspace).

### Decision: The `rewrite-specops-1-0` change is created immediately at Phase 0

The standard OpenSpec change that tracks the rewrite is created **immediately** after the fresh standard project is initialised, not deferred to a later phase. This makes the OpenSpec artifacts the authoritative implementation plan from the start and lets every subsequent phase reference them.

**Chosen:** Phase 0 runs `openspec init --tools opencode`, then `openspec new change rewrite-specops-1-0 --schema spec-driven`, then authors and validates `proposal.md`, the capability delta specs, `design.md`, and the complete phased `tasks.md`. Implementation begins only after the full change validates.

### Decision: Thin OpenSpec adapter, one module per operation

All OpenSpec invocations flow through `src/openspec/adapter.ts` wrapping `runProcess` (shell-free, narrow env). One typed method per operation; typed result modules (`version.ts`, `status.ts`, `instructions.ts`, `validation.ts`, `archive.ts`, `schema.ts`) own JSON parsing and normalisation. Operational failures (spawn error, non-zero exit for operational reasons, malformed JSON) are distinct from artifact validation failures and are never sent to an agent for correction.

**Alternatives considered:** Spread OpenSpec calls across workflow modules (rejected — violates minimal coupling and the spec's adapter requirement); build a heavier abstraction with caching/retries (rejected — V1 keeps it deliberately boring; transient retries handled by the provider-retry policy).

### Decision: Coarse run state, no event sourcing

`run.json` is the single persisted state, written atomically (temp file + `rename`, sync). Statuses: `active`, `awaiting-user`, `verified`, `completed`, `blocked`, `failed`, `cancelled`. Stages: `exploration`, `proposal`, `specs`, `design`, `tasks`, `implementation`, `validation`, `review`, `repair`, `archive`. Recovery is coarse: on resume SpecOps inspects the current repository state, the OpenSpec change status, and the existing artifacts, then resumes from the last persisted stage. SpecOps never reconstructs or replays individual model actions. There is no concept of resumable work bound to an originating capability, purpose, or phase.

**Alternatives considered:** Event-sourced model activity log (explicitly excluded by the spec); fine-grained per-action checkpoints (rejected — recreates the old scheduler); provenance-bound resume tokens (rejected — recreates dispatch provenance).

### Decision: Repository-state identity via SHA-256 over a canonical, sorted, line-normalised input

The identity hashes: tracked modifications, staged changes, deletions, and relevant untracked non-ignored files. It excludes `.git/`, `.specops/` run metadata, generated validation evidence, and (for the implementation-only identity) OpenSpec planning artifacts. Implementation: capture `git status --porcelain=v1 -z` plus the content hashes of changed blobs, build a canonical sorted input, SHA-256 it. Validation and review evidence record the identity they evaluated; completion rejects when current ≠ validated or current ≠ reviewed.

**Alternatives considered:** Pure `git rev-parse HEAD` (rejected — does not cover dirty trees, which V1 must support); include OpenSpec planning artifacts in the implementation identity (rejected — would invalidate validation whenever `tasks.md` checkboxes toggle).

### Decision: Bounded correction and repair as internal constants

Artifact correction limit = **2** attempts after the initial write. Review repair limit = **2** attempts. Transient provider retry limit = **1** automatic retry. Frontier consultation limit = **1** per stage attempt. All four are internal bounded constants in `src/workflow/limits.ts`; none is exposed as a configuration field. Doctor reports the active values informationally.

**Alternatives considered:** Expose any of them as configuration (rejected — invites unbounded loops, contradicts bounded autonomy, and none is a genuine project/user choice); make the repair limit configurable with a small allowed range (deferred — revisit only if a concrete V1 need emerges).

### Decision: Minimal V1 configuration shape

The configuration exposes only genuine project or user choices: seven-role model mappings and optional variants, the OpenSpec command override (which binary to invoke), required validation commands, validation timeouts, and bounded output capture settings. An MCP integration toggle is exposed. Legacy configuration files are migrated **once** (see the migration decision below): supported values are preserved, known obsolete fields are removed (not ignored forever), all removed fields are reported through doctor or migration output, the migrated V1 configuration is atomically persisted, and strict V1 validation is applied after migration. `examples/specops.schema.json`, `examples/specops.json`, and `examples/specops.global.json` are deleted (they document the removed shape).

### Decision: Exact final plugin tool catalogue (6 tools)

The final SpecOps-registered plugin tools are exactly six. Native OpenCode functionality is used wherever it satisfies a need; a SpecOps tool is registered only where native functionality cannot replace it. The workflow does not "stage dispatch deterministically in TypeScript" — the coordinator drives stages by invoking the appropriate agent via native `task` and then calling `specops_reconcile_stage` to reconcile the boundary.

| # | Tool ID | Caller | Purpose | Why native OpenCode cannot replace it |
|---|---|---|---|---|
| 1 | `specops_start_or_resume` | Coordinator (via `/specops`) | Start a new run or resume the active run for the current change; performs OpenSpec compatibility/schema checks and baseline capture, then advances to the first stage. | Native tools have no concept of a SpecOps run, OpenSpec compatibility gate, or baseline capture; the coordinator must not perform these as free-form reasoning. |
| 2 | `specops_reconcile_stage` | Coordinator (after each stage's agent returns) | Reconcile a coarse stage boundary: inspect the expected output for the current stage, invoke OpenSpec artifact validation where applicable, validate and parse review output where applicable, atomically persist the resulting coarse stage transition, and return a bounded outcome (success, correction required, user input required, or blocked). | Native tools cannot perform the deterministic, identity-aware stage boundary check or the atomic coarse stage transition; this is the TypeScript-owned gate between stages. |
| 3 | `specops_get_status` | Any command/agent | Read bounded run context and persisted artifacts for the active change; powers `/specops-status` and agent context retrieval. | Native `read` could read files but cannot enforce the bounded, identity-aware, redacted view consistently. |
| 4 | `specops_run_validation` | Coordinator (implementation/validation stages) | Execute one registered required validation command shell-free, capture bounded stdout/stderr/exit/timing, and persist evidence bound to the current repository identity. | Native `bash` would let the model run arbitrary commands and could not bind evidence to repository identity or enforce the bounded-capture/timeout contract; the spec owns validation execution in TypeScript. |
| 5 | `specops_finalize` | Coordinator (completion stage) | Run finalisation checks (OpenSpec validity, tasks complete, validation/review fresh, identities match) and invoke OpenSpec archival; mark completed only after archive success. | Native tools cannot perform the deterministic finalisation gate or atomic state transition to `completed`. |
| 6 | `specops_cancel` | Coordinator (via `/specops-cancel`) | Persist a safe cancellation outcome for an active run; preserves artifacts, repository changes, and diagnostics; never resets user work. | Native tools cannot atomically transition run state to `cancelled` with terminal-state protection. |

`specops_reconcile_stage` is the coarse boundary reconciler. It does not dispatch workers, expose scheduler directives, use dispatch IDs, or recreate `nextAction`/`completeAction`. Worker dispatch itself uses native OpenCode `task`; material user questions use native `question`.

**Deliberately removed (no V1 replacement):** `specops_start_run`, `specops_next_action`, `specops_complete_action`, `specops_recover_dispatch`, `specops_answer_question`, `specops_answer_questions`, `specops_dismiss_question`, `specops_resume_checkpoint`, `specops_request_context`, `specops_archive_run`, `specops_openspec`. The old 17-tool dispatch protocol is gone.

**Not registered as SpecOps tools (use native OpenCode):** onboarding (`/specops-onboard` calls `openspec init` directly), doctor (`/specops-doctor` runs diagnostics directly), material questions (coordinator uses native `question`), artifact writing (agents use native `edit` scoped by the `permission.ask` hook — see the guarded-writer decision below), frontier consultation (coordinator uses native `task` to dispatch the read-only frontier subagent).

The final workflow-specific tool count is **6**, at the spec's "SHOULD NOT exceed six" ceiling.

### Decision: Guarded artifact writing via the OpenCode `permission.ask` hook

Repository inspection of the installed `@opencode-ai/plugin` API confirms the `permission.ask` hook `(input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>`, where `Permission` carries `type`, `pattern?: string | Array<string>`, `metadata`, `sessionID`, and `callID`. The agent `permission` config is tool-level (`edit: "allow" | "deny" | "ask"`); there is no native per-path allow-list per agent, and `permission.ask` does not fire for tools already pre-`allow`ed.

**Chosen:** Native edit is retained; no guarded-writer tool is registered. For the four path-scoped writers (planner, designer, explorer, reviewer) native `edit` is set to `"ask"` (not `"allow"`), so every edit raises a `permission.ask` request. SpecOps registers a `permission.ask` hook that, for edit requests, resolves the active agent from the session, resolves that agent's owned-path set from OpenSpec/SpecOps state for the active change and stage, and returns `"allow"` when the requested path pattern is within the owned set and `"deny"` otherwise. The implementer keeps `edit: "allow"` (full source edit); the coordinator and frontier keep `edit: "deny"`. This enforces path ownership technically and keeps the six-tool catalogue.

**Fallback (documented, not chosen):** If implementation proves the `permission.ask` hook cannot reliably expose the requested path pattern for edit tools in a packed install, native `edit` is set to `"deny"` for the four path-scoped writers and a seventh tool `specops_write_artifact` is registered, which would move the catalogue to seven and require noting the catalogue change in the changelog. This fallback exists only to keep the design honest; the chosen path is the `permission.ask` hook.

**Rejected:** An internal library helper that agents have no mechanism to invoke (agents cannot call arbitrary TypeScript functions; only registered tools or native OpenCode tools).

### Decision: Archive retry as a resume path through `/specops`

`/specops-archive` is removed. A failed archive enters a retryable `failed` state; resuming via `/specops` retries archive without rerunning implementation/validation/review when the repository identity is unchanged, and requires fresh validation and review first if the identity changed.

## Risks / Trade-offs

- **Risk:** OpenSpec 1.7 JSON output shapes change in a 1.7.x patch. → **Mitigation:** Adapter isolates parsing; typed result modules are the only consumers; `test:openspec:compat` runs against the installed binary in CI.
- **Risk:** Repository-state identity collides across materially different trees. → **Mitigation:** SHA-256 over a canonical sorted input including blob hashes makes accidental collision infeasible; deterministic and independently testable.
- **Risk:** Dirty-tree baseline confuses "SpecOps changes" vs "pre-existing changes". → **Mitigation:** Baseline capture records pre-existing changed files and warns the user; SpecOps never claims all current changes are its own and never auto-resets.
- **Risk:** Removing the dispatch protocol breaks in-flight users. → **Mitigation:** Old runs are detected as legacy and rejected clearly; `/specops-doctor` explains the migration; release notes document that old runs cannot resume.
- **Trade-off:** Fixed correction/repair limits may be too tight for hard artifacts. → Accepted; exhaustion pauses for user action (retry / switch model / edit manually / cancel), which is the spec's intended bounded-autonomy behaviour.
- **Trade-off:** Five tools is minimal but means `specops_get_status` is overloaded for both `/specops-status` and agent context retrieval. → Accepted; the bounded, identity-aware view is the same concern in both cases.

## Migration Plan

1. Verify `master` is clean and create the immutable local `pre-specops-1.0-rewrite` tag before implementation.
2. Capture legacy baseline in a separate clone or worktree from `pre-specops-1.0-rewrite`; commit `docs/specops-1.0-technical-spec.md` verbatim and the legacy inventory.
3. Initialise the fresh standard `openspec/` and author the `rewrite-specops-1-0` change (this document and its siblings).
4. Land phases incrementally; each phase ends with formatting, typecheck, relevant tests, and a reviewable commit.
5. Temporary adapters inside the branch are allowed to keep tests compiling, but the final product exposes only the V1 workflow.
   Deletion sequencing is not a compatibility architecture: `src/agents/` is the sole V1 agent architecture. `src/capabilities/` remains temporarily unchanged only for legacy modules scheduled for replacement, no V1 module may import or extend it, and Phase 9 deletes it after its old consumers are gone.
6. After Phase 9, the repository contains only SpecOps 1.0.
7. Configuration migration runs once on plugin load (or explicit migration): supported values preserved, known obsolete SpecOps fields removed, all removed fields reported through doctor or migration output, the migrated V1 configuration atomically persisted, and strict V1 validation applied after migration. Legacy custom schemas on disk are not deleted automatically. Stale multi-agent manifests are replaced with the seven-role manifest. Old runs are not resumable.
8. Users upgrade by running `/specops-doctor`; release notes document that old runs cannot resume, old custom schemas are not deleted automatically, model mappings are migrated where unambiguous, `/specops-auto` is removed, and automatic mode is deferred.

**Rollback:** The default branch retains the pre-rewrite implementation until the replacement is accepted; the rewrite branch is not force-pushed and history is not rewritten.

## Open Questions

None. The seven corrections from the planning review (configuration contradiction, recovery language, tool boundary gap, guarded-writing concreteness, migration semantics, bootstrap task completion, and branch-anchoring) are resolved by the decisions above.

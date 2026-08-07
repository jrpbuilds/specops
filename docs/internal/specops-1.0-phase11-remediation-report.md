# SpecOps 1.0 Phase 11 — Adversarial Remediation Report

Date: 2026-08-07
OpenSpec change: `rewrite-specops-1-0`
Scope: cold-review findings B-01 through B-12

This report maps every B-01 through B-12 finding to its fix commit, regression
test, verification evidence, and final disposition. It is produced by Phase 11
task 12.5.3 and does **not** mark SpecOps 1.0 release-ready; the OpenSpec change
is not archived, no commit is pushed, and task 11.5 (real two-model-family
interactive smoke) remains incomplete (see B-12 / 12.4.8).

## Commits

| Commit    | Time (+0100) | Group | Findings                                      |
| --------- | ------------ | ----- | --------------------------------------------- |
| `f43d51c` | 17:48        | Plan  | Phase 11 task plan + design note              |
| `1b9095d` | 17:49        | 1     | B-01, B-08, B-11                              |
| `8253ae3` | 17:50        | 2     | B-03, B-04, B-06 (B-02 stopped)               |
| `e72d23c` | 17:51        | 3     | B-05, B-07, B-09, B-10                        |
| `bc3082d` | 17:58        | 4     | B-12, stale release material, 11.5 correction |

Baseline tag `pre-specops-1.0-rewrite` verified to peel to
`9722738fc08d65591d4e6e6561e0d358c55f83cd` and remain an ancestor of the
rewrite (`tests/phase11-release-proof.test.ts`). The tag was not moved.

## Verification suite (task 12.5.2)

The full `npm run check` pipeline passes end-to-end:

- `format:check` — all files use Prettier code style
- `typecheck` — `tsc --noEmit` (src + tests) clean
- `deadcode:check` — knip clean
- `test` — 28 files, 193 passed + 1 todo (B-02 architectural stop)
- `test:packed` — packed install smoke passed
- `test:openspec:compat` — CLI gate passed; `@fission-ai/openspec` resolves to 1.7.0
- `docs:check` — 13 doc links, compatibility declarations passed
- `git diff --check` — clean
- strict OpenSpec validation — `rewrite-specops-1-0` is valid
- real `OpenSpecAdapter` compat tests — 9 passed against installed 1.7.0 binary

## Finding dispositions

### B-01 — Registered start tool does not drive the V1 planning workflow

- **Reproduction**: 12.1.1 — `tests/phase11-runtime-integration.test.ts`
- **Fix**: 12.1.2 — `src/plugin.ts` `specops_start_or_resume` now drives
  `readV1Run`/`createV1Run` and returns the state; the coordinator planning path
  is reached through `reconcileStage`/`runValidation`/`finalize` wired to the
  real workflow modules. Commit `1b9095d`.
- **Disposition**: Fixed.

### B-02 — Review identity excludes reviewed OpenSpec planning artifacts

- **Reproduction**: 12.2.1 — recorded as `it.todo` in
  `tests/phase11-integrity.test.ts`.
- **Fix**: 12.2.2 — **STOPPED**. Binding the review identity to exact reviewed
  planning artifacts broadens the review parser/identity contract beyond the
  approved design. This requires an explicit architectural amendment rather
  than a silent invention. Left as a documented stop in the test and commit
  message (`8253ae3`).
- **Disposition**: Stopped — architectural amendment required. Not release-ready.

### B-03 — Accepted validation-command definitions not persisted

- **Reproduction**: 12.2.3 — `tests/phase11-integrity.test.ts`
- **Fix**: 12.2.4 — `acceptedValidationCommands` persisted at the planning
  checkpoint; completion and `specops_run_validation` resolve from persisted
  canonical definitions. `src/state/schema.ts`, `src/workflow/reconcile.ts`,
  `src/plugin.ts`. Commit `8253ae3`.
- **Disposition**: Fixed.

### B-04 — Stale evidence satisfies finalisation/review gates

- **Reproduction**: 12.2.5 — `tests/phase11-integrity.test.ts`
- **Fix**: 12.2.6 — `canonicalCommandHash` over executable+args+cwd+timeoutMs+
  maxOutputBytes; evidence carries `commandDefinitionHash`;
  `isValidationEvidenceCurrent` rejects mismatched definitions at finalisation.
  `src/validation/registry.ts`, `src/validation/executor.ts`,
  `src/validation/evidence.ts`, `src/workflow/finalize.ts`. Commit `8253ae3`.
- **Disposition**: Fixed.

### B-05 — Permission hook constructed with empty owned-path context

- **Reproduction**: 12.3.1 — `tests/phase11-hardening.test.ts`
- **Fix**: 12.3.2 — `ownedPathPatterns` returns `[]` (deny) when no trusted
  change; `resolveOwnedPathContext` scans persisted runs; async
  `createPermissionAskHook` context resolver wired in `src/index.ts`.
  `src/agents/permissions.ts`, `src/agents/permission-hook.ts`. Commit `e72d23c`.
- **Disposition**: Fixed.

### B-06 — Run state corruption accepted (parsing, invariants, crash window, creation)

- **Reproduction**: 12.2.7/9/11/13 — `tests/phase11-integrity.test.ts`
- **Fix**: 12.2.8/10/12/14 — fail-closed review parsing; `assertRunInvariants`
  (completed→archivedAt, verified→archive stage, identity boundaries);
  crash-safe archive via `archiveAttemptedAt` + `isChangeAlreadyArchived` probe;
  `createV1Run` single atomic write. `src/state/schema.ts`, `src/state/store.ts`,
  `src/workflow/finalize.ts`, `src/review/parser.ts`. Commit `8253ae3`.
- **Disposition**: Fixed.

### B-07 — Any agent can drive workflow tools; implementer writes managed state

- **Reproduction**: 12.3.3/9 — `tests/phase11-hardening.test.ts`
- **Fix**: 12.3.4/10 — `assertCoordinatorAgent` guard on all six workflow tools;
  symlink-safe containment via `lstat` in `calculateRepositoryIdentity`.
  `src/plugin.ts`, `src/repository/identity.ts`. Commit `e72d23c`.
- **Disposition**: Fixed.

### B-08 — Only one completion action reachable; repair limit not enforced

- **Reproduction**: 12.1.3/5 — `tests/phase11-runtime-integration.test.ts`
- **Fix**: 12.1.4/6 — `specops_finalize` accepts all four `completionAction`
  values; `completionOptions` uses real accepted validation commands;
  `reconcileReview` enforces `MAX_REVIEW_REPAIRS`; `specops_run_validation`
  resolves accepted set from persisted recommendations. `src/plugin.ts`,
  `src/workflow/reconcile.ts`. Commit `1b9095d`.
- **Disposition**: Fixed.

### B-09 — Timed-out process descendants survive

- **Reproduction**: 12.3.5 — `tests/phase11-hardening.test.ts`
- **Fix**: 12.3.6 — `runProcess` uses `detached: true` process group, real
  `timeoutMs`, SIGTERM→SIGKILL grace. `src/process.ts`. Commit `e72d23c`.
- **Disposition**: Fixed.

### B-10 — Repository identity reads worktree content, follows symlinks

- **Reproduction**: 12.3.7 — `tests/phase11-hardening.test.ts`
- **Fix**: 12.3.8 — `calculateRepositoryIdentity` uses `lstat` (symlink
  containment — link target string not followed), captures POSIX mode, records
  `{kind,mode,hash}`. `src/repository/identity.ts`. Commit `e72d23c`.
- **Disposition**: Fixed.

### B-11 — Doctor/onboarding not deterministic w.r.t. V1 configuration

- **Reproduction**: 12.1.7 — `tests/phase11-runtime-integration.test.ts`
- **Fix**: 12.1.8 — `buildConfiguredAdapter` uses the configured openspec
  command. `src/doctor.ts`. Commit `1b9095d`.
- **Disposition**: Fixed.

### B-12 — E2E inventory is source-string containment; compat gate is CLI-only

- **Reproduction**: 12.4.1/3 — `tests/phase11-b12-reproduction.test.ts`,
  `tests/phase11-b12-compat-reproduction.test.ts`
- **Fix**: 12.4.2/4 — replaced source-string inventory with real deterministic
  runtime tests for all 18 scenarios (`tests/e2e-v1-runtime.test.ts`, 18
  tests); real `OpenSpecAdapter` compat tests against installed 1.7.0
  (`tests/openspec-adapter-compat.test.ts`, 9 tests); CLI gate kept secondary.
  Stale `examples/` and `site/` material corrected to the V1 surface.
  Commit `bc3082d`.
- **Phase 10 correction (12.4.8)**: task 11.5 amended to incomplete — only
  self-contained surface-count probes were produced, not the required
  two-model-family interactive smoke metrics.
- **Disposition**: B-12 defect fixed. Task 11.5 (real interactive smoke) remains
  incomplete and blocks release readiness (task 11.8). Not release-ready.

## Release readiness

SpecOps 1.0 is **not** marked release-ready by this remediation. Two items
remain open and require further work:

1. **B-02** — stopped pending an explicit architectural amendment to the review
   identity contract.
2. **Task 11.5** — real two-model-family interactive smoke metrics were not
   produced; only self-contained surface-count probes exist
   (`docs/internal/specops-1.0-model-smoke.md`).

No commit was pushed, the OpenSpec change was not archived, and no run state
was marked `completed` on the basis of a passing test suite alone.

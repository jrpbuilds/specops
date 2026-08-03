# Artifacts and persisted state

Each run lives beneath `openspec/changes/<change>/`. Human-readable OpenSpec artifacts and
machine-owned control records are kept together while retaining distinct responsibilities.

## Human and structured artifacts

Depending on scope, a change may contain:

- `routing.md`;
- `exploration.md`;
- `proposal.md`;
- `specs/<capability>/spec.md`;
- `design.md`;
- `tasks.md`;
- `verification.md`;
- `judgment-correctness.json`;
- `judgment-compliance.json`;
- `review-ledger.json`;
- `specops-receipt.json`.

SpecOps validates these records before saving them and can recover an interrupted update
automatically. Users should not edit the files in a change directory by hand; use the normal
status, doctor, and workflow commands to inspect or continue a run.

## Machine records

| File                     | Purpose                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `specops-run.json`       | Sole final run state, requirements, budgets, dispatches, repairs, and terminal status. |
| `specops-context.json`   | Bounded repository context and decisions for workers.                                  |
| `specops-evidence.json`  | Controller-recorded command invocations and immutable result hashes.                   |
| `specops-artifacts.json` | Artifact provenance, input/output hashes, and validity.                                |
| `specops-progress.json`  | Compact UI projection; not a second run-state format.                                  |
| `specops-frontier.json`  | Bounded frontier policy, usage counters, and escalation episode history.               |

Only the current run-state format is accepted. Start a fresh run after a SpecOps upgrade.

The current state also retains review submissions and repair-task history. Review
submissions are immutable, source-id-addressable inputs to refutation; repair tasks record the
selected target, evidence, acceptance criteria, semantic finding fingerprints, source ledger/diff
hashes, and observed before/after diff hashes. Only submissions whose originating dispatch
completed successfully remain eligible for refutation. These are orchestration records rather than
additional OpenSpec workflow artifacts.

## Provenance

Every artifact records:

- producer and dispatch purpose;
- generation time;
- policy and implementation input hashes;
- output hash;
- scope tier and required capabilities;
- validity and invalidation reason.

Dispatch records separately capture the chosen agent, capability, purpose, independence, input
hash, output hash, status, and completion time. If a run is interrupted, SpecOps records the
interruption and either resumes safely or reports a bounded failure instead of inventing a result.

Frontier-assisted dispatches additionally retain the escalation episode,
selected low/high tier, advice hash, and originating dispatch. The completion
receipt includes compact frontier usage and episode history.

## Dependency invalidation

Artifact dependencies form a directed graph. Replacing an upstream artifact marks every dependent
artifact stale. Important examples:

- proposal replacement stales specifications, design, tasks, implementation, and assurance;
- design replacement stales tasks and everything derived from implementation;
- implementation mutation stales verification, judgments, review ledger, and receipt.
- implementation mutation also invalidates command evidence through its diff binding; the
  controller barrier reruns missing validations before issuing downstream verification work.

The replacement artifact itself is recorded as valid after invalidation. Finalization checks every
required artifact and refuses stale provenance.

## Archiving

Archival is part of finalization, governed by `openspec.autoArchive` (default `true`). After a run
passes verification, `specops_finalize` transitions it to `completed` and, when auto-archive is
enabled, runs `openspec archive` first:

- The change directory moves to `openspec/changes/archive/<date>-<change>/`.
- For **standard** and **full** tiers, OpenSpec merges any specification deltas under `specs/`
  into the main `openspec/specs/<capability>/spec.md` files.
- For the **lean** tier, `--skip-specs` is used so archive only moves the directory without touching
  main specs (lean runs have no spec deltas).
- The `completed` state (carrying `archivedAt`) moves with the archived directory.

When `openspec.autoArchive` is `false`, `specops_finalize` transitions `passed` → `completed`
without archiving; the change stays in `openspec/changes/<change>/` and `archivedAt` is unset.

If `openspec archive` fails (re-validation drift, incomplete tasks, artifact drift, or a filesystem
error), the run transitions to `archive_failed` with a retryable, structured `archiveError` (`kind`,
`attempt`, `message`). Retry via `specops_finalize` or `/specops-archive`.

### Crash recovery

Before archiving, SpecOps writes a recovery sidecar at
`openspec/.specops-archive-attempt/<change>.json` recording the run identity (revision, createdAt,
baseline), persists the `archiving` state, runs the archive command, and finally writes `completed`
at the archived path. The sidecar lives outside the change directory, so it survives the move and
lets recovery select the archived candidate by verifying run identity from the moved
`specops-run.json` — never by filename alone. Missing or mismatched sidecars never authorize
recovery; a controlled diagnostic is raised instead. Run locks live under
`openspec/.specops-run-locks/`, and in-flight transactions under `specops-transaction/` are
recovered before the directory move.

## Machine-readable outcomes

`specops-run.json` exposes one stable outcome category for humans and CI:

- `completed` with terminal status `completed` (archived when `archivedAt` is set, otherwise
  unarchived because auto-archive was disabled);
- `policy-blocked` with terminal status `blocked`;
- `validation-failed`, `review-failed`, or `internal-error` with terminal status `failed`;
- `cancelled` with terminal status `cancelled`.

`passed`, `archiving`, and `archive_failed` are intermediate/retryable states. OpenCode owns the
CLI process exit code, so a CI job using `--format json` must require outcome `completed` rather
than treating exit `0` alone as workflow success.

## Completion receipt

The receipt contains baseline commit, current diff hash, requirements hash, dispatches, artifacts,
invalidations, normalized review submissions, repair tasks, repairs, and escalation decisions. It is produced only after scheduler, artifact,
registered command-evidence, and OpenSpec validation gates pass.

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

After a run passes, the change directory remains in `openspec/changes/<change>/` until a user
confirms archival through `/specops-archive`. The interactive controller presents a native
question, and the persisted confirmation id binds the user's decision to exactly one archive
operation:

- The change directory moves to `openspec/changes/archive/<date>-<change>/`.
- For **standard** and **full** tiers, OpenSpec merges any specification deltas under `specs/`
  into the main `openspec/specs/<capability>/spec.md` files.
- For the **lean** tier, `--skip-specs` is used so archive only moves the directory without touching
  main specs (lean runs have no spec deltas).
- The terminal `passed` state moves with the archived directory.

If `openspec archive` fails (e.g., re-validation detects drift, incomplete tasks, or a filesystem
error), the run stays `passed` and a retryable `archiveError` is recorded. The user may re-run
`/specops-archive` to retry the operation after addressing the failure. A declined confirmation
clears the gate and leaves the run passed without archiving.

## Machine-readable outcomes

`specops-run.json` exposes one stable outcome category for humans and CI:

- `completed` with terminal status `passed`;
- `policy-blocked` with terminal status `blocked`;
- `validation-failed`, `review-failed`, or `internal-error` with terminal status `failed`;
- `cancelled` with terminal status `cancelled`.

OpenCode owns the CLI process exit code, so a CI job using `--format json` must require outcome
`completed` rather than treating exit `0` alone as workflow success.

## Completion receipt

The receipt contains baseline commit, current diff hash, requirements hash, dispatches, artifacts,
invalidations, normalized review submissions, repair tasks, repairs, and escalation decisions. It is produced only after scheduler, artifact,
registered command-evidence, and OpenSpec validation gates pass.

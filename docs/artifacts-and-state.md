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

The controller writes these files atomically after validating complete worker output.

## Machine records

| File                     | Purpose                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `specops-run.json`       | Sole final run state, requirements, budgets, dispatches, repairs, and terminal status. |
| `specops-context.json`   | Bounded repository context and decisions for workers.                                  |
| `specops-evidence.json`  | Registered command invocations and immutable result hashes.                            |
| `specops-artifacts.json` | Artifact provenance, input/output hashes, and validity.                                |
| `specops-progress.json`  | Compact UI projection; not a second run-state format.                                  |
| `specops-frontier.json`  | Bounded frontier policy, usage counters, and escalation episode history.               |

State format version 2 is current. Earlier supported state is normalized when
safe defaults can be supplied; incompatible paused legacy state is rejected.

## Provenance

Every artifact records:

- producer and dispatch purpose;
- generation time;
- policy and implementation input hashes;
- output hash;
- scope tier and required capabilities;
- validity and invalidation reason.

Dispatch records separately capture the chosen agent, capability, purpose, independence, input
hash, output hash, and status.

Frontier-assisted dispatches additionally retain the escalation episode,
selected low/high tier, advice hash, and originating dispatch. The completion
receipt includes compact frontier usage and episode history.

## Dependency invalidation

Artifact dependencies form a directed graph. Replacing an upstream artifact marks every dependent
artifact stale. Important examples:

- proposal replacement stales specifications, design, tasks, implementation, and assurance;
- design replacement stales tasks and everything derived from implementation;
- implementation mutation stales verification, judgments, review ledger, and receipt.

The replacement artifact itself is recorded as valid after invalidation. Finalization checks every
required artifact and refuses stale provenance.

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
invalidations, repairs, and escalation decisions. It is produced only after scheduler, artifact,
registered command-evidence, and OpenSpec validation gates pass.

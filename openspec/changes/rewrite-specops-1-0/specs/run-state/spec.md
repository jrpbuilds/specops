## Purpose

Persists coarse SpecOps run state atomically, tracks a deterministic repository-state identity, and binds validation and review evidence to that identity so stale evidence cannot satisfy completion.

## ADDED Requirements

### Requirement: Coarse run-state schema

`run.json` SHALL persist a versioned, coarse run state containing at minimum: schema version, change name, user goal, status, stage, timestamps, baseline repository identity, current repository identity, validated repository identity, reviewed repository identity, artifact correction counters, repair counter, and terminal failure details. It SHALL NOT include dispatches, capability IDs, purpose/provenance tuples, artifact dependency graphs, specialist facets, escalation claims, reviewer source ledgers, or refutation results.

#### Scenario: Persist a new run

- **WHEN** a run is created
- **THEN** `run.json` exists with status `active`, a captured baseline identity, and the initial stage

#### Scenario: Resume a persisted run

- **WHEN** a run is resumed after interruption
- **THEN** the loaded state matches the last atomically written `run.json`

### Requirement: Atomic state persistence

Run-state writes SHALL be atomic. A process interruption SHALL NOT leave a partially written `run.json`. Completed artifacts and repository work SHALL be preserved after failure. Terminal states SHALL be protected from accidental continuation.

#### Scenario: Interrupted write safety

- **WHEN** a write is interrupted mid-flush
- **THEN** the destination `run.json` is either the previous complete state or the new complete state, never a partial file

#### Scenario: Terminal-state protection

- **WHEN** a run is in a terminal status and continuation is requested
- **THEN** the request is rejected

### Requirement: Legacy run-state rejection

SpecOps SHALL detect old SpecOps run files and SHALL return a clear incompatibility result. It SHALL NOT automatically translate or reinterpret old active runs.

#### Scenario: Legacy state detected

- **WHEN** an old-format run file is found for a change
- **THEN** SpecOps reports the run as incompatible and refuses to resume it

### Requirement: Deterministic repository-state identity

SpecOps SHALL calculate a deterministic repository-state identity over tracked modifications, staged changes, deleted files, and relevant untracked non-ignored files. The identity SHALL exclude `.git/`, SpecOps run metadata, generated validation evidence, and (for the implementation-only identity) OpenSpec planning artifacts. The same tree SHALL always produce the same identity.

#### Scenario: Deterministic hashing

- **WHEN** the same repository state is hashed twice
- **THEN** both identities are equal

#### Scenario: Untracked file inclusion

- **WHEN** a new non-ignored untracked file is added
- **THEN** the repository-state identity changes

#### Scenario: Metadata exclusion

- **WHEN** only `.git/` or `.specops/` content changes
- **THEN** the implementation-only repository-state identity does not change

### Requirement: Dirty-tree baseline capture

At run start SpecOps SHALL capture a baseline identity, record pre-existing changed and untracked files, warn the user that pre-existing changes are present, and SHALL NOT claim all current changes were created by SpecOps. SpecOps SHALL NOT automatically reset or discard repository changes.

#### Scenario: Dirty start

- **WHEN** a run starts in a dirty working tree
- **THEN** the baseline identity and pre-existing changed files are recorded and the user is warned

### Requirement: External-mutation detection

At each major boundary SpecOps SHALL recalculate the repository identity, SHALL detect external mutation, and SHALL invalidate stale validation and review evidence.

#### Scenario: Invalidate after mutation

- **WHEN** the repository changes externally after validation evidence is recorded
- **THEN** the evidence is marked stale at the next boundary

### Requirement: Validation evidence binding

Each required validation command result SHALL record a stable command id, executable, arguments, working directory, start and end time, duration, exit code, timeout status, bounded stdout and stderr, and the repository-state identity it evaluated. Evidence SHALL be invalidated when the repository identity changes.

#### Scenario: Bound captured output

- **WHEN** a validation command produces output exceeding the configured bound
- **THEN** the recorded stdout and stderr are truncated and the truncation is flagged

#### Scenario: Timeout recording

- **WHEN** a validation command exceeds its timeout
- **THEN** the evidence records the timeout status and the exit code is not treated as a normal failure

### Requirement: Coarse recovery boundaries

SpecOps SHALL recover at coarse persisted stage boundaries. On resume it SHALL inspect the current repository state, the OpenSpec change status, and the existing artifacts, then resume from the last persisted stage. SpecOps SHALL NOT reconstruct or replay individual model actions.

#### Scenario: Resume after interrupted implementation

- **WHEN** an implementation stage is interrupted and resumed
- **THEN** SpecOps inspects the current repository state, OpenSpec status, and existing artifacts, and resumes implementation from the last persisted stage

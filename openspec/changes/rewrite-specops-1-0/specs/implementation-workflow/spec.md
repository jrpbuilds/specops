## Purpose

Mutates source and tests from approved OpenSpec artifacts, runs required project validation bound to repository state, and consults the frontier agent for genuine blockers.

## ADDED Requirements

### Requirement: Implementer invocation context

The coordinator SHALL invoke the implementer with the goal, exploration, validated proposal, specs, design, tasks, repository baseline, accepted validation commands, and the implementer prompt. The implementer MAY edit source and tests, run development commands, and update task checkboxes.

#### Scenario: Complete context provided

- **WHEN** the implementer is invoked
- **THEN** it receives every approved planning artifact and the accepted validation command set

### Requirement: Task completion tracking

SpecOps SHALL track task completion through standard OpenSpec `tasks.md`. Before moving to review SpecOps SHALL confirm required task checkboxes are complete. SpecOps SHALL use OpenSpec-supported status where available and SHALL NOT invent a second task state.

#### Scenario: Incomplete tasks block review

- **WHEN** required task checkboxes are not all complete
- **THEN** the workflow does not advance to review

#### Scenario: Checkbox updates

- **WHEN** the implementer completes a task
- **THEN** the corresponding checkbox in `tasks.md` is updated

### Requirement: Implementation blocker routing

The implementer SHALL report requirement conflicts, design conflicts, repository constraints, material missing decisions, and ordinary implementation failures. The coordinator SHALL route artifact conflicts back to the planner or designer, material decisions to the user, genuine difficult blockers to the frontier when policy permits, and ordinary failures to retry or a blocked state.

#### Scenario: Artifact conflict returns to owner

- **WHEN** the implementer reports a design conflict
- **THEN** the coordinator routes it back to the designer

#### Scenario: Material decision to user

- **WHEN** the implementer reports a material missing decision
- **THEN** the coordinator presents a material user question

### Requirement: One frontier consultation per stage attempt

The coordinator MAY invoke the frontier only when the originating agent inspected relevant evidence, made a concrete attempt, a substantial blocker remains, and ordinary retrying is unlikely to help. Only one frontier consultation is allowed for a single stage attempt. The frontier is read-only, returns advice to the originating agent for a fresh attempt, cannot write code or artifacts, cannot approve completion, and cannot recursively invoke itself. If the blocker remains after frontier-assisted retry, the run SHALL ask a material user question or become blocked.

#### Scenario: Frontier permitted with a concrete attempt

- **WHEN** the implementer made a concrete attempt and reports a substantial blocker
- **THEN** the coordinator invokes the frontier exactly once for that stage attempt

#### Scenario: Frontier rejected without an attempt

- **WHEN** the implementer requests frontier without a concrete attempt
- **THEN** the coordinator does not invoke the frontier

#### Scenario: Frontier exhaustion

- **WHEN** the blocker remains after frontier-assisted retry
- **THEN** the run asks a material question or becomes blocked

### Requirement: Required validation execution

After implementation the workflow SHALL calculate the current repository identity, run every accepted required command, persist evidence, and bind evidence to that identity. Validation command execution is TypeScript-owned; the implementer may run development commands while working but completion gates depend on recorded SpecOps validation evidence.

#### Scenario: All commands pass

- **WHEN** every accepted required command succeeds against the current repository state
- **THEN** evidence is persisted and the run is eligible for review

#### Scenario: One command fails

- **WHEN** one accepted required command fails
- **THEN** the run returns to the implementer with the exact command evidence

### Requirement: Bounded validation-fix loop

When a required command fails the workflow SHALL return exact evidence to the implementer, permit bounded correction, recalculate the repository identity, and rerun stale required validation. This loop is separate from review repair and SHALL be bounded; it SHALL NOT run unboundedly.

#### Scenario: Mutation after validation

- **WHEN** the repository changes after successful validation
- **THEN** stale evidence is invalidated and required commands rerun against the new state

#### Scenario: Timeout returns evidence

- **WHEN** a required command times out
- **THEN** the timeout is recorded as evidence and returned to the implementer

### Requirement: Explorer recommendations separate from accepted commands

Validation commands from explicit SpecOps configuration SHALL be authoritative. Explorer-discovered commands SHALL be recommendations until accepted at the planning checkpoint.

#### Scenario: Recommendation becomes authoritative

- **WHEN** the user continues past the planning checkpoint
- **THEN** the accepted explorer recommendations become part of the required command set

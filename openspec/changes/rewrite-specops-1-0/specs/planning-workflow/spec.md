## Purpose

Drives the interactive planning path from a user goal to validated standard OpenSpec proposal, specs, design, and tasks, with bounded artifact correction and exactly one planning checkpoint.

## ADDED Requirements

### Requirement: Run creation

`/specops <goal>` SHALL verify OpenSpec compatibility, verify the standard `spec-driven` schema, create or identify the OpenSpec change, create SpecOps run metadata, capture the repository baseline, and begin exploration.

#### Scenario: Start a new run

- **WHEN** the user runs `/specops` with a goal in a supported repository
- **THEN** a SpecOps run is created, the baseline identity is captured, and the exploration stage begins

#### Scenario: Reject an unsupported schema

- **WHEN** the active change uses a non-`spec-driven` schema
- **THEN** the run is not started and the user is told the schema is unsupported

### Requirement: Exploration artifact

The coordinator SHALL invoke the explorer read-only with the goal, repository root, and existing OpenSpec project context. The explorer SHALL write `.specops/runs/<change>/exploration.md`. The coordinator SHALL verify the file exists and is non-empty.

#### Scenario: Exploration written

- **WHEN** the explorer completes
- **THEN** `exploration.md` exists and is non-empty

### Requirement: OpenSpec readiness queries

Before requesting each standard artifact the coordinator SHALL query OpenSpec for the artifact's readiness, SHALL retrieve the artifact's current instructions, and SHALL pass those instructions to the owning agent. SpecOps SHALL NOT duplicate OpenSpec readiness rules or artifact templates in TypeScript.

#### Scenario: Respect readiness

- **WHEN** an artifact's dependency is not yet satisfied
- **THEN** the coordinator does not request that artifact

#### Scenario: Use upstream instructions

- **WHEN** an owning agent is invoked for an artifact
- **THEN** it receives the OpenSpec-returned instructions for that artifact

### Requirement: Preferred orchestration order

The coordinator SHALL create planning artifacts in the order proposal, specs, design, tasks, querying OpenSpec readiness before each. Specs and design SHALL NOT be authored concurrently.

#### Scenario: Sequential artifact creation

- **WHEN** planning is in progress
- **THEN** proposal is validated before specs begins, specs before design, and both before tasks

### Requirement: Artifact correction budget

Each artifact SHALL receive one initial creation attempt followed by up to two automatic correction attempts. When validation fails the owning agent SHALL receive the artifact path, the current artifact, the exact OpenSpec validation errors, and the correction attempt number, and SHALL correct the artifact in place. TypeScript SHALL NOT rewrite model-authored artifact content.

#### Scenario: First correction succeeds

- **WHEN** an artifact fails validation on the first attempt
- **THEN** the owning agent receives the exact errors and corrects the artifact, and validation succeeds on the second attempt

#### Scenario: Correction exhaustion

- **WHEN** an artifact remains invalid after two corrections
- **THEN** the run pauses and presents the user the options to retry, switch model and retry, edit manually and revalidate, or cancel

### Requirement: Operational failure separation

OpenSpec execution failures (missing binary, unsupported version, process launch failure, filesystem permission failure, malformed JSON) SHALL produce a clear operational failure rather than being sent to an agent for artifact correction.

#### Scenario: Operational failure is not a correction

- **WHEN** OpenSpec fails to spawn
- **THEN** the run fails operationally and the owning agent is not asked to correct the artifact

### Requirement: Material user questions

A user question SHALL be permitted only when repository inspection cannot resolve it, at least two materially different outcomes remain, an incorrect choice would affect behaviour, compatibility, safety, data, architecture, or task scope, and a reversible low-risk assumption is insufficient. Agents SHALL NOT ask the user for routine naming, formatting, minor implementation details, permission to continue, progress confirmation, repository-inspectable answers, or low-risk reversible choices. Only the coordinator presents a question, using OpenCode's native question mechanism.

#### Scenario: Permitted material question

- **WHEN** a worker reports a decision with two material outcomes not resolvable from the repository
- **THEN** the coordinator presents the question to the user and resumes from the answer

#### Scenario: Prohibited trivial question

- **WHEN** a worker requests a question answerable by repository inspection
- **THEN** the coordinator does not present the question

### Requirement: Single planning checkpoint

SpecOps SHALL present exactly one planning checkpoint after the proposal, specs, design, and tasks are all valid and OpenSpec reports the required planning artifacts complete. The checkpoint SHALL offer Continue to implementation, Request planning changes, and Cancel. The planning overview is presentation-only.

#### Scenario: Continue

- **WHEN** the user chooses Continue
- **THEN** the displayed plan, design, and accepted validation command set are approved for the run and implementation begins

#### Scenario: Request planning changes

- **WHEN** the user requests changes with feedback
- **THEN** the coordinator routes feedback to the affected artifact owners, revalidates every changed artifact, and re-presents the checkpoint

### Requirement: No per-artifact checkpoints

SpecOps SHALL NOT add a user checkpoint after each individual planning artifact. Material questions and exhausted correction are pauses, not additional phase checkpoints.

#### Scenario: No checkpoint between artifacts

- **WHEN** proposal validates and specs begins
- **THEN** no user checkpoint is presented between them

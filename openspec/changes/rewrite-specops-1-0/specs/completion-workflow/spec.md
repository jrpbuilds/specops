## Purpose

Completes the interactive workflow with a completion checkpoint, a verified-but-open state, finalisation checks, and OpenSpec archival only after explicit user approval.

## ADDED Requirements

### Requirement: Completion checkpoint

After implementation tasks are complete, required validation passes, review passes with no blocking findings, and the current repository identity matches both validation and review evidence, the coordinator SHALL present a completion checkpoint offering Complete and archive, Request implementation changes, Leave change open, and Cancel.

#### Scenario: Complete and archive

- **WHEN** the user chooses Complete and archive
- **THEN** finalisation checks run and OpenSpec archival is invoked

#### Scenario: Request implementation changes

- **WHEN** the user requests implementation changes with feedback
- **THEN** feedback returns to the implementer, validation and review are invalidated and rerun, and the checkpoint is re-presented

#### Scenario: Cancel

- **WHEN** the user cancels
- **THEN** the run is cancelled and artifacts and repository changes are preserved

### Requirement: Verified-but-open state

When the user chooses Leave change open, SpecOps SHALL set the run status to `verified`, preserve the active OpenSpec change, and preserve validation and review identities. The run MAY be resumed later to complete the archive step. `verified` is not equivalent to `completed`. If the repository state changes before later completion, verified evidence SHALL be invalidated and the run SHALL return to validation and review.

#### Scenario: Leave open

- **WHEN** the user leaves the change open
- **THEN** the status becomes `verified` and the OpenSpec change remains active and unarchived

#### Scenario: Resume verified

- **WHEN** the user resumes a verified run whose repository state is unchanged
- **THEN** the completion checkpoint is offered again without rerunning validation or review

#### Scenario: Verified evidence invalidation

- **WHEN** the repository state changes while a run is verified
- **THEN** the verified evidence is invalidated and the run returns to validation and review

### Requirement: Finalisation checks

Before archive TypeScript SHALL confirm a supported OpenSpec version, the standard schema, an OpenSpec-valid change, all required tasks complete, all required validation passed, a validated identity matching the current identity, a review verdict of pass, a reviewed identity matching the current identity, and no repair active.

#### Scenario: Finalisation rejects incomplete tasks

- **WHEN** required tasks are not all complete at finalisation
- **THEN** archive is rejected

#### Scenario: Finalisation rejects stale validation

- **WHEN** the validated identity does not match the current identity
- **THEN** archive is rejected

#### Scenario: Finalisation rejects stale review

- **WHEN** the reviewed identity does not match the current identity
- **THEN** archive is rejected

### Requirement: Archive through OpenSpec

SpecOps SHALL archive by invoking standard OpenSpec archival and SHALL NOT reproduce archive semantics. Only after successful archive SHALL SpecOps persist archive information, set status `completed`, and prevent accidental workflow continuation.

#### Scenario: Archive success marks completed

- **WHEN** OpenSpec archival succeeds
- **THEN** the run status becomes `completed` and continuation is prevented

#### Scenario: Completed means archive succeeded

- **WHEN** the run is marked completed
- **THEN** OpenSpec archival has succeeded

### Requirement: Retryable archive failure

Archive failure SHALL preserve the verified implementation and all evidence and SHALL enter a retryable failed state recording the OpenSpec error, the attempted change, the current repository identity, and the archive attempt timestamp. Retrying archive SHALL NOT rerun implementation, validation, or review when the repository state remains unchanged. If the state changed, SpecOps SHALL require fresh validation and review first.

#### Scenario: Archive failure is retryable

- **WHEN** OpenSpec archive fails
- **THEN** the run enters a retryable failed state preserving all evidence

#### Scenario: Archive retry without rerunning

- **WHEN** the user retries archive and the repository identity is unchanged
- **THEN** implementation, validation, and review are not rerun

#### Scenario: Mutation before retry requires revalidation

- **WHEN** the repository identity changed since the failed archive attempt
- **THEN** fresh validation and review are required before retrying archive

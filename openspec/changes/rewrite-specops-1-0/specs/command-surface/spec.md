## Purpose

Exposes the final five public commands and a minimal workflow tool surface, plus status output, doctor diagnostics, and non-destructive installation migration.

## ADDED Requirements

### Requirement: Final public command set

SpecOps SHALL expose exactly `/specops`, `/specops-status`, `/specops-cancel`, `/specops-doctor`, and `/specops-onboard`. `/specops-auto` and `/specops-archive` SHALL NOT be exposed; archive retry is handled as a resume path through `/specops`.

#### Scenario: Exact command set

- **WHEN** the registered commands are inspected
- **THEN** the set equals exactly the five final commands

#### Scenario: No automatic command

- **WHEN** the registered commands are inspected
- **THEN** no `/specops-auto` command exists

### Requirement: Minimal workflow tool surface

The workflow-specific tool surface SHALL provide exactly six tools: `specops_start_or_resume`, `specops_reconcile_stage`, `specops_get_status`, `specops_run_validation`, `specops_finalize`, and `specops_cancel`. `specops_reconcile_stage` SHALL inspect the expected output for the current stage, invoke OpenSpec artifact validation where applicable, validate and parse review output where applicable, atomically persist the resulting coarse stage transition, and return a bounded outcome (success, correction required, user input required, or blocked). It SHALL NOT dispatch workers, expose scheduler directives, use dispatch IDs, or recreate `nextAction`/`completeAction`. No tool SHALL expose dispatch IDs, capability graphs, artifact dependency graphs, provenance tuples, review tribunals, escalation episodes, or scheduler internals.

#### Scenario: Minimal tool set

- **WHEN** the workflow tool surface is inspected
- **THEN** it exposes exactly the six listed tools and no others

#### Scenario: No dispatch protocol remains

- **WHEN** the workflow tool surface is inspected
- **THEN** no tool id references dispatch IDs, next-action scheduler directives, complete-action envelopes, capability IDs, or recovery dispatches

### Requirement: Status output

`/specops-status` SHALL show the goal, change, status, current stage, OpenSpec artifact status, artifact correction attempts, repository identity summary, validation results, review verdict, repair count, checkpoint state, and blocked or failed reason.

#### Scenario: Status for an active run

- **WHEN** `/specops-status` is run during an active implementation stage
- **THEN** the output includes the status, stage, validation results, and any blocking reason

### Requirement: Doctor diagnostics

`/specops-doctor` SHALL validate OpenCode compatibility, OpenSpec version, `spec-driven` schema availability, absence of required custom SpecOps schemas, prompt-file presence, prompt placeholder validity, the seven-agent catalogue, model mappings, permissions, configuration validity, writable SpecOps and OpenSpec paths, validation command configuration, and supported OpenSpec JSON interfaces. Output SHALL distinguish errors, warnings, and informational findings, and each error SHOULD provide concrete remediation.

#### Scenario: Doctor success

- **WHEN** the installation is healthy
- **THEN** `/specops-doctor` reports no errors

#### Scenario: Doctor unsupported OpenSpec

- **WHEN** the installed OpenSpec is outside the supported range
- **THEN** `/specops-doctor` reports an error with remediation

#### Scenario: Doctor legacy schema warning

- **WHEN** a legacy SpecOps custom schema is detected on disk in a user project
- **THEN** `/specops-doctor` reports a warning explaining that SpecOps 1.0 uses the standard schema

#### Scenario: Doctor legacy state warning

- **WHEN** an old-format run state is detected
- **THEN** `/specops-doctor` reports a warning that legacy runs are not resumable

### Requirement: Standard onboarding

`/specops-onboard` SHALL use upstream OpenSpec setup behaviour, SHALL confirm `openspec/config.yaml`, SHALL confirm the `spec-driven` schema, SHALL create SpecOps metadata directories only where required, and SHALL NOT copy bundled custom schema files.

#### Scenario: Standard onboarding

- **WHEN** `/specops-onboard` runs in a new project
- **THEN** `openspec/config.yaml` exists and no custom SpecOps schemas are copied

### Requirement: Non-destructive installation migration

On plugin load or explicit migration SpecOps SHALL migrate a legacy configuration exactly once: replace stale multi-agent manifests with the seven-role manifest, preserve obvious model mappings and supported configuration values, remove known obsolete SpecOps fields, report all removed settings through doctor or migration output, atomically persist the migrated V1 configuration, and apply strict V1 validation after migration. SpecOps SHALL NOT delete legacy custom schemas automatically, SHALL NOT resume legacy runs, and SHALL NOT silently rewrite unrelated user configuration.

#### Scenario: Manifest migration preserves models

- **WHEN** migration runs against a legacy manifest
- **THEN** obvious model mappings are preserved and obsolete settings are reported

#### Scenario: Legacy schemas preserved

- **WHEN** migration runs in a project with legacy custom schemas on disk
- **THEN** the schemas are not deleted and are reported through doctor

#### Scenario: Obsolete config fields removed and reported

- **WHEN** migration runs against a legacy configuration with obsolete fields
- **THEN** the fields are removed from the persisted V1 file and reported

## Purpose

Lets SpecOps invoke OpenSpec 1.7 through one typed, shell-free adapter so artifact readiness, instructions, validation, and archival stay owned by OpenSpec rather than duplicated inside SpecOps.

## ADDED Requirements

### Requirement: OpenSpec version compatibility gate

The adapter SHALL detect the installed OpenSpec version and SHALL accept only `>=1.7.0 <1.8.0`. It SHALL reject versions below 1.7, versions at or above 1.8, and malformed or unavailable version output with an error that names the detected version, the supported range, and a remediation step.

#### Scenario: Accept a compatible patch release

- **WHEN** `openspec --version` reports `1.7.x` where x is a non-negative integer
- **THEN** the adapter returns the detected version and does not raise

#### Scenario: Reject an unsupported major

- **WHEN** `openspec --version` reports `1.8.0` or higher
- **THEN** the adapter raises a compatibility error and refuses to continue the workflow

#### Scenario: Reject a malformed version

- **WHEN** `openspec --version` produces output that is not a parseable semver string
- **THEN** the adapter raises a compatibility error and does not attempt the workflow

### Requirement: Standard schema enforcement

The adapter SHALL query OpenSpec for the active project and change schema and SHALL support only the standard `spec-driven` schema. When a project or change uses any other schema, the adapter SHALL preserve the existing project, SHALL NOT overwrite or replace the schema, and SHALL return an unsupported-schema error.

#### Scenario: Detect the standard schema

- **WHEN** OpenSpec reports `schemaName` of `spec-driven` for the change
- **THEN** the adapter returns success and exposes the schema name to callers

#### Scenario: Reject a custom schema without mutation

- **WHEN** OpenSpec reports a schema other than `spec-driven`
- **THEN** the adapter returns an unsupported-schema error and leaves all schema files on disk unchanged

### Requirement: Machine-readable OpenSpec operations

The adapter SHALL invoke OpenSpec subcommands with their `--json` output flag for schemas, status, instructions, validation, and archive, and SHALL parse `openspec --version` stdout. It SHALL NOT parse human-oriented colour output when JSON is available. It SHALL normalize responses into typed results and SHALL report unsupported or malformed responses as operational failures distinct from artifact validation failures.

#### Scenario: Parse change status

- **WHEN** the adapter calls `openspec status --change <id> --json`
- **THEN** it returns a typed change status including per-artifact readiness and existing output paths

#### Scenario: Parse artifact instructions

- **WHEN** the adapter calls `openspec instructions <artifact> --change <id> --json`
- **THEN** it returns the artifact description, instruction, rules, template, dependencies, and resolved output path

#### Scenario: Report an operational failure

- **WHEN** an OpenSpec process fails to spawn, exits non-zero for an operational reason, or returns malformed JSON
- **THEN** the adapter raises an operational failure distinct from an artifact validation failure

### Requirement: Shell-free execution

The adapter SHALL execute OpenSpec through a shell-free process spawn with a deliberately narrow environment and SHALL NOT use a shell to interpolate arguments.

#### Scenario: No shell interpolation

- **WHEN** the adapter runs an OpenSpec command with a change name containing shell metacharacters
- **THEN** the change name is passed as a single argv element and is never interpreted by a shell

### Requirement: Archival through OpenSpec

The adapter SHALL archive a completed change by invoking standard OpenSpec archival and SHALL return a typed archive result. It SHALL NOT reproduce OpenSpec archive semantics.

#### Scenario: Successful archive

- **WHEN** the adapter invokes `openspec archive <change> --json -y` and OpenSpec succeeds
- **THEN** the adapter returns a success archive result

#### Scenario: Archive failure

- **WHEN** OpenSpec archive exits non-zero
- **THEN** the adapter returns a typed failure result preserving the error output

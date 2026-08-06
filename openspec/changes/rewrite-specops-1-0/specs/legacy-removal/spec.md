## Purpose

Removes all legacy workflow machinery so the repository contains only the SpecOps 1.0 workflow, preferring deletion over compatibility wrappers where the old abstraction has no place in V1.

## ADDED Requirements

### Requirement: Legacy scheduler and dispatch removal

SpecOps SHALL delete the old workflow scheduler, dispatch engine, action catalogue, directive engine, generated wire contracts, and protocol tools exposing dispatch IDs, next-action directives, complete-action envelopes, capability IDs, and recovery dispatches. No dead compatibility layer for the old scheduler or dispatch protocol SHALL remain.

#### Scenario: No scheduler remains

- **WHEN** the source tree is searched for the old scheduler module
- **THEN** no active scheduler implementation remains

#### Scenario: No dispatch protocol remains

- **WHEN** the packaged tool surface is inspected
- **THEN** no tool exposes a dispatch ID or next-action directive

### Requirement: Custom schema removal

SpecOps SHALL delete the bundled `specops`, `specops-lean`, and `specops-standard` schemas from `schemas/`, from package files, from build scripts, from generated checks, from validation scripts, from onboarding, from documentation, and from tests. No generated or bundled custom schema SHALL remain in the release.

#### Scenario: No custom schemas packaged

- **WHEN** the release package is inspected
- **THEN** no `specops`, `specops-lean`, or `specops-standard` schema directory or file is included

### Requirement: Obsolete agent removal

SpecOps SHALL delete the obsolete agent registry, capability IDs, generated prompt machinery, contract-generation scripts, and enum-to-prompt generators tied to the old registry.

#### Scenario: No obsolete agent references

- **WHEN** the source is searched for obsolete agent ids
- **THEN** none remain outside migration documentation and changelog history

### Requirement: Obsolete type removal

SpecOps SHALL remove obsolete types including tiers, risk facets, capability IDs, dispatch purposes, frontier tiers, judgments, refutation, escalation claims, old repair modes, artifact invalidation graphs, and checkpoint provenance.

#### Scenario: No excluded architecture types

- **WHEN** the type definitions are inspected
- **THEN** none of the excluded architecture concepts are defined

### Requirement: Obsolete test removal and replacement

SpecOps SHALL delete tests that solely assert removed behaviour, including suites for lean routing, standard/full routing, specialist selection, correctness/compliance judgments, refutation, typed escalation, dispatch recovery, automatic mode, phase-by-phase checkpoints, custom schema validation, and generated contracts. Tests SHALL NOT be made green by rewriting assertions to match removed behaviour; they SHALL be replaced by tests for the new product requirements.

#### Scenario: No tests for removed behaviour

- **WHEN** the test suite is inspected
- **THEN** no test asserts lean, standard, or full tier routing behaviour

### Requirement: Dead-code cleanup

SpecOps SHALL run dead-code analysis and SHALL remove dead modules, unused exports, stale scripts, unused dependencies, old package files, and obsolete generated outputs. The dead-code check SHALL pass.

#### Scenario: Dead-code check passes

- **WHEN** the dead-code analysis runs
- **THEN** it reports no violations

### Requirement: No active references to excluded architecture

After removal, the repository SHALL contain no active references to excluded architecture terms except in migration documentation or changelog history. Matches SHALL be reviewed manually and legitimate prose using common words SHALL be preserved.

#### Scenario: Excluded terms absent from active code

- **WHEN** the active source is searched for `specops-auto`, `specops-lean`, `specops-standard`, `dispatchId`, `nextAction`, `completeAction`, `frontier-low`, or `frontier-high`
- **THEN** no active architecture references remain

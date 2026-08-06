## Purpose

Adds one independent read-only review of the current implementation and one bounded repair loop, with no review tribunal.

## ADDED Requirements

### Requirement: Single independent reviewer

SpecOps SHALL invoke exactly one reviewer to independently examine the original user goal, current OpenSpec artifacts, completed task state, the current implementation diff, changed-file summary, repository identity, current validation evidence, and relevant repository context. The reviewer SHALL be read-only and SHALL assess correctness, requirement compliance, regression risk, test adequacy, and maintainability, plus security, data integrity, migration safety, concurrency, resilience, performance, public contracts, infrastructure, and usability where the change makes them material.

#### Scenario: Reviewer is read-only

- **WHEN** the reviewer's permission policy is inspected
- **THEN** source-edit and dispatch permissions are disabled

#### Scenario: Reviewer cannot approve without inspecting

- **WHEN** the reviewer returns a verdict without inspecting the implementation
- **THEN** the verdict is rejected

### Requirement: Review artifact format

The reviewer SHALL write `.specops/runs/<change>/review.md` containing the sections Verdict, Reviewed state, Validation, Blocking findings, Non-blocking observations, and Conclusion. The verdict SHALL be exactly `pass` or `changes-required`. TypeScript SHALL parse only the verdict, the reviewed repository-state identity, the blocking finding identifiers, and the presence of the required sections.

#### Scenario: Valid pass review

- **WHEN** the reviewer writes a review with verdict `pass` and no blocking findings
- **THEN** the review is accepted and the run advances to the completion checkpoint

#### Scenario: Valid changes-required review

- **WHEN** the reviewer writes a review with verdict `changes-required` and blocking findings
- **THEN** the review is accepted and repair begins

#### Scenario: Malformed verdict rejected

- **WHEN** the verdict is not `pass` or `changes-required`
- **THEN** the review is rejected

#### Scenario: Missing required sections rejected

- **WHEN** a required section is absent
- **THEN** the review is rejected

### Requirement: Blocking finding content

Each blocking finding SHALL include a stable identifier, severity, affected file or component, concrete evidence, expected behaviour, observed problem, and required correction. A finding SHALL NOT be blocking merely because another valid design might be preferred.

#### Scenario: Blocking finding parsed

- **WHEN** the review contains blocking findings
- **THEN** the coordinator extracts each finding's identifier and passes them to the implementer

### Requirement: Review freshness

The reviewer SHALL review the current repository state. The review SHALL be rejected when the recorded reviewed repository-state identity does not match the current identity, required validation is missing or stale, the verdict is malformed, or required sections are absent.

#### Scenario: Stale reviewed identity rejected

- **WHEN** the reviewed identity does not match the current repository identity
- **THEN** the review is rejected as stale

#### Scenario: Mutation after review

- **WHEN** the repository changes after review
- **THEN** the review is invalidated

### Requirement: Bounded repair

When review returns `changes-required` the coordinator SHALL send all blocking findings to the implementer, increment the repair count, invoke the implementer, recalculate the identity, rerun all required validation, and rerun independent review. The default maximum repair attempts SHALL be two. After exhaustion SpecOps SHALL preserve code, review, and validation evidence, set a blocked status, and show clear remediation options.

#### Scenario: First repair succeeds

- **WHEN** repair attempt one resolves all blocking findings and validation passes
- **THEN** review reruns and the run advances on pass

#### Scenario: Repair exhaustion

- **WHEN** repair attempts reach the configured maximum without resolution
- **THEN** the run becomes blocked and remediation options are shown

#### Scenario: Validation failure during repair

- **WHEN** a required command fails during a repair attempt
- **THEN** the failure is returned to the implementer before review reruns

### Requirement: No review tribunal

SpecOps SHALL NOT implement a separate repairer agent, review refutation, finding voting, semantic finding fingerprints, finding supersession graphs, grouped repair tribunals, or correctness or compliance judges.

#### Scenario: No tribunal roles invoked

- **WHEN** the review and repair workflow runs
- **THEN** no correctness judge, compliance judge, risk reviewer, specialist reviewer, or refuter is invoked

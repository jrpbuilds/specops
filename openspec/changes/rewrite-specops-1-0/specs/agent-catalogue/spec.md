## Purpose

Registers exactly seven SpecOps agents with least-privilege permissions and editable Markdown prompts, and migrates user model selections to the seven-role manifest without preserving obsolete workflow policy.

## ADDED Requirements

### Requirement: Exactly seven agents

SpecOps SHALL register exactly the agents `specops-coordinator`, `specops-explorer`, `specops-planner`, `specops-designer`, `specops-implementer`, `specops-reviewer`, and `specops-frontier`. No automatic controller, assessor, verifier, repairer, risk reviewer, correctness judge, compliance judge, refuter, frontier-low/high split, or specialist agent SHALL be registered.

#### Scenario: Packaged agent catalogue

- **WHEN** the plugin registers agents in a clean install
- **THEN** the registered agent id set equals exactly the seven final ids

#### Scenario: No obsolete agents remain

- **WHEN** active V1 catalogues, registered agents, manifest defaults, prompts, TUI, permission policies, command surfaces, and runtime dispatch surfaces are inspected
- **THEN** none of `specops-auto-controller`, `specops-assessor`, `specops-verifier`, `specops-repairer`, `specops-risk-reviewer`, `specops-correctness-judge`, `specops-compliance-judge`, `specops-review-refuter`, `specops-frontier-low`, `specops-frontier-high`, or any `specops-*-specialist` id are present

Legacy identifiers MAY remain only in explicit V2-to-V3 migration mapping code and tests, untouched Phase 9 legacy modules, and historical migration documentation. They SHALL NOT be imported, registered, exposed, or executed through the V1 runtime.

### Requirement: Least-privilege permissions

Each agent SHALL have least-privilege permissions. Only the coordinator MAY delegate work and MAY ask the user a question. Only the implementer MAY edit source code and tests. The planner MAY write proposal, specs, and tasks; the designer MAY write design; the reviewer MAY write the review artifact; the explorer MAY write the exploration artifact; the frontier is read-only. No subagent MAY dispatch another subagent.

#### Scenario: Coordinator-only delegation

- **WHEN** agent permission policies are inspected
- **THEN** only `specops-coordinator` has the dispatch permission enabled and every other agent has it disabled

#### Scenario: Implementer-only source edit

- **WHEN** agent permission policies are inspected
- **THEN** only `specops-implementer` has source-edit permission enabled and the coordinator and reviewer have it disabled

#### Scenario: No recursive dispatch

- **WHEN** any subagent permission policy is inspected
- **THEN** the dispatch permission is disabled

### Requirement: Editable Markdown prompts

Agent prompts SHALL be stored as separate Markdown files under `prompts/` and SHALL be loaded at runtime from source and packed installations. Prompt bodies SHALL NOT be constructed from TypeScript string constants. The prompt loader SHALL fail on missing files.

#### Scenario: Prompt files present

- **WHEN** the package is inspected
- **THEN** exactly seven Markdown prompt files exist, one per agent

#### Scenario: Packed prompt loading

- **WHEN** the plugin loads in a packed installation
- **THEN** all seven prompt files are resolved and loaded

### Requirement: Fail-strict prompt rendering

The prompt renderer SHALL support simple named placeholders, SHALL reject missing required values, SHALL reject unresolved placeholders after substitution, and SHALL NOT provide loops, conditionals, macros, or template inheritance. It SHALL delimit trusted instructions from untrusted goal and repository content.

#### Scenario: Render with all values

- **WHEN** the renderer is called with every required named value
- **THEN** it returns the prompt with all placeholders substituted and no residual placeholder markers

#### Scenario: Reject an unresolved placeholder

- **WHEN** the renderer is called with a missing required value
- **THEN** it raises an error and returns no prompt

### Requirement: Path-scoped artifact writes enforced

Native edit SHALL be set to `"ask"` for the planner, designer, explorer, and reviewer, `"allow"` for the implementer, and `"deny"` for the coordinator and frontier. SpecOps SHALL register the OpenCode `permission.ask` hook and, for edit permission requests, SHALL inspect the requested path pattern against the active agent's owned-path set, returning `"allow"` for owned paths and `"deny"` otherwise. The owned-path set SHALL be resolved from OpenSpec or SpecOps state for the active change and stage.

#### Scenario: Owned-path edit allowed

- **WHEN** the planner requests to edit `openspec/changes/<change>/proposal.md`
- **THEN** the `permission.ask` hook returns `"allow"`

#### Scenario: Out-of-scope edit denied

- **WHEN** the planner requests to edit a source file outside its owned paths
- **THEN** the `permission.ask` hook returns `"deny"`

#### Scenario: Implementer may edit source

- **WHEN** the implementer requests to edit a source file
- **THEN** native edit is allowed without a path check

### Requirement: Seven-role model manifest

The model manifest SHALL contain exactly the seven roles and SHALL migrate an older multi-agent manifest by preserving obvious model mappings, mapping an interactive controller to the coordinator, selecting one frontier model from any legacy frontier entry, discarding obsolete role mappings, and reporting ambiguous mappings through doctor output. The manifest SHALL NOT preserve old permissions or step policy.

#### Scenario: Migrate obvious mappings

- **WHEN** a legacy 24-agent manifest is migrated
- **THEN** the seven-role manifest preserves model selections for roles with unambiguous legacy equivalents

#### Scenario: Report ambiguous mappings

- **WHEN** a legacy role mapping is ambiguous
- **THEN** the migration leaves the role at the configured default and reports the ambiguity through `/specops-doctor`

#### Scenario: Reject a stale catalogue

- **WHEN** a manifest with an agent catalogue that is not exactly the seven roles is loaded
- **THEN** the manifest is rejected as invalid

## Purpose

Defines the minimal SpecOps V1 configuration that exposes only genuine project or user choices, excluding tiers, routing, automation, escalation budgets, frontier dispatch budgets, reviewer policy knobs, and automatic archival, and migrating legacy configuration once.

## ADDED Requirements

### Requirement: Minimal V1 configuration shape

SpecOps configuration SHALL expose only genuine project or user choices: seven-role model mappings and optional variants, the OpenSpec command override, required validation commands, validation timeouts, and bounded output capture settings. An MCP integration toggle MAY be exposed. Defaults SHALL allow the plugin to run with minimal setup once OpenSpec is available.

#### Scenario: Defaults run with OpenSpec only

- **WHEN** the plugin loads with no user configuration file and OpenSpec is available
- **THEN** the plugin runs using built-in defaults without error

### Requirement: No excluded configuration fields

Configuration SHALL NOT expose workflow tiers, scope thresholds, routing, automation, escalation budgets, frontier dispatch budgets, reviewer policy knobs, custom OpenSpec schema installation, capability graphs, artifact dependency overrides, artifact correction limits, review repair limits, transient provider retry limits, or automatic archival.

#### Scenario: Excluded field absent from V1 schema

- **WHEN** the V1 configuration schema is inspected
- **THEN** none of the excluded fields are present as configurable fields

### Requirement: Internal bounded constants for retry and consultation limits

The artifact correction limit (default two attempts after the initial write), the review repair limit (default two attempts), the transient provider retry limit (default one automatic retry), and the frontier consultation limit (default one per stage attempt) SHALL be internal bounded constants. They SHALL NOT be exposed as configuration fields.

#### Scenario: Correction limit is not configurable

- **WHEN** the configuration schema is inspected
- **THEN** the artifact correction limit is not a configurable field

#### Scenario: Repair limit is not configurable

- **WHEN** the configuration schema is inspected
- **THEN** the repair limit is not a configurable field

#### Scenario: Frontier consultation limit is not configurable

- **WHEN** the configuration schema is inspected
- **THEN** the frontier consultation limit is not a configurable field

### Requirement: Model mapping by role only

Model configuration SHALL map a model and optional variant to each of the seven roles. Model configuration SHALL NOT alter agent permissions, agent ownership, the OpenSpec workflow, completion conditions, or retry limits. V1 SHALL NOT implement automatic model escalation.

#### Scenario: Role to model mapping

- **WHEN** the configuration is loaded
- **THEN** each of the seven roles resolves to a model or the configured OpenCode default

#### Scenario: No automatic escalation

- **WHEN** the configuration is inspected
- **THEN** no automatic model escalation field is present

### Requirement: One-time legacy configuration migration

On plugin load or explicit migration, SpecOps SHALL migrate a legacy configuration exactly once: preserve supported values, remove known obsolete SpecOps fields, report all removed fields through doctor or migration output, atomically persist the migrated V1 configuration, and apply strict V1 validation after migration. SpecOps SHALL NOT silently ignore obsolete fields forever; fields removed from the persisted file SHALL NOT reappear as configuration.

#### Scenario: Obsolete fields removed and reported

- **WHEN** migration runs against a legacy configuration containing `workflow.defaultTier`, `escalation.budgets`, `frontier.mode`, `review.blockingSeverities`, or `openspec.autoArchive`
- **THEN** those fields are removed from the persisted V1 file and reported through doctor or migration output

#### Scenario: Supported values preserved

- **WHEN** migration runs against a legacy configuration with a model mapping for a role that still exists
- **THEN** the supported model mapping is preserved in the migrated V1 file

#### Scenario: Strict validation after migration

- **WHEN** the migrated V1 configuration is loaded
- **THEN** strict V1 validation is applied and any unsupported remaining value fails loudly

#### Scenario: Migration runs once

- **WHEN** the plugin loads after migration has already persisted a V1 file
- **THEN** migration does not re-run and the V1 file is validated as-is

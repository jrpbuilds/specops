# Agent catalogue

This file is generated from the typed capability registry. Run `npm run generate`
after an intentional catalogue change; `npm run generated:check` rejects drift.

The 2 controllers are primary agents. All capability
workers are subagents and have recursive task dispatch disabled. Model and provider
options are user-tunable through the materialised manifest; mode, prompts, tools,
and permissions remain registry-controlled.

A _Default_ model means the agent inherits OpenCode's configured global default
model until the user selects a provider/model mapping.

| Agent ID                             | Mode     | Distinct role                                                                                          | Maximum authority   | Default model |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------ | ------------------- | ------------- |
| `specops-auto-controller`            | primary  | Automatic OpenCode controller shared by visible TUI and non-interactive run adapters.                  | Scheduler only      | _Default_     |
| `specops-interactive-controller`     | primary  | Primary controller with user checkpoints.                                                              | Scheduler only      | _Default_     |
| `specops-assessor`                   | subagent | Produces the strict initial scope and risk assessment.                                                 | Read-only reasoning | _Default_     |
| `specops-explorer`                   | subagent | Collects repository-grounded planning evidence.                                                        | Read-only reasoning | _Default_     |
| `specops-planner`                    | subagent | Produces requirements bundles and refined tasks.                                                       | Read-only reasoning | _Default_     |
| `specops-designer`                   | subagent | Produces an independent Full-tier technical design.                                                    | Read-only reasoning | _Default_     |
| `specops-implementer`                | subagent | Mutates repository code from approved artifacts.                                                       | Code mutation       | _Default_     |
| `specops-verifier`                   | subagent | Builds traceability from registered command evidence.                                                  | Command execution   | _Default_     |
| `specops-repairer`                   | subagent | Mutates code during bounded remediation cycles.                                                        | Code mutation       | _Default_     |
| `specops-risk-reviewer`              | subagent | Detects cross-cutting risk facets without replacing specialists; may run verification commands.        | Command execution   | _Default_     |
| `specops-correctness-judge`          | subagent | Independently judges implementation correctness; may run verification commands against the repository. | Command execution   | _Default_     |
| `specops-compliance-judge`           | subagent | Independently judges specification compliance; may run verification commands against the repository.   | Command execution   | _Default_     |
| `specops-review-refuter`             | subagent | Deduplicates and challenges unsupported review findings.                                               | Read-only reasoning | _Default_     |
| `specops-frontier-low`               | subagent | Provides bounded low-tier frontier advice for evidence-backed workflow blockers.                       | Read-only reasoning | _Default_     |
| `specops-frontier-high`              | subagent | Provides bounded high-tier frontier adjudication for critical workflow blockers.                       | Read-only reasoning | _Default_     |
| `specops-security-specialist`        | subagent | Reviews authentication, authorization, secrecy, and abuse risk.                                        | Read-only reasoning | _Default_     |
| `specops-data-migration-specialist`  | subagent | Reviews persistent data and migration safety.                                                          | Read-only reasoning | _Default_     |
| `specops-contract-specialist`        | subagent | Reviews public API and compatibility contracts.                                                        | Read-only reasoning | _Default_     |
| `specops-concurrency-specialist`     | subagent | Reviews ordering, races, locking, and atomicity.                                                       | Read-only reasoning | _Default_     |
| `specops-resilience-specialist`      | subagent | Reviews failure handling, recovery, and degradation.                                                   | Read-only reasoning | _Default_     |
| `specops-performance-specialist`     | subagent | Reviews resource and latency regressions.                                                              | Read-only reasoning | _Default_     |
| `specops-infrastructure-specialist`  | subagent | Reviews deployment and operational changes.                                                            | Read-only reasoning | _Default_     |
| `specops-usability-specialist`       | subagent | Reviews user-facing interaction quality.                                                               | Read-only reasoning | _Default_     |
| `specops-maintainability-specialist` | subagent | Reviews clarity, structure, and long-term change cost.                                                 | Read-only reasoning | _Default_     |

Consultation and independent-review dispatches use the same specialist identity
but different recorded purposes. A consultation therefore cannot satisfy the
independent post-implementation review gate.

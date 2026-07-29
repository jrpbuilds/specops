# Agent catalogue

This file is generated from the typed capability registry. Run `npm run generate`
after an intentional catalogue change; `npm run generated:check` rejects drift.

The 2 controllers are primary agents. All capability
workers are subagents and have recursive task dispatch disabled. Model and provider
options are user-tunable through the materialised manifest; mode, prompts, tools,
and permissions remain registry-controlled.

| Agent ID                             | Mode     | Distinct role                                                                                          | Maximum authority   | Default model                     |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------ | ------------------- | --------------------------------- |
| `specops-auto-controller`            | primary  | Automatic OpenCode controller shared by visible TUI and non-interactive run adapters.                  | Read-only reasoning | `opencode/deepseek-v4-flash-free` |
| `specops-interactive-controller`     | primary  | Primary controller with user checkpoints.                                                              | Read-only reasoning | `opencode/deepseek-v4-flash-free` |
| `specops-assessor`                   | subagent | Produces the strict initial scope and risk assessment.                                                 | Read-only reasoning | `opencode/deepseek-v4-flash-free` |
| `specops-explorer`                   | subagent | Collects repository-grounded planning evidence.                                                        | Read-only reasoning | `opencode/ling-3.0-flash-free`    |
| `specops-planner`                    | subagent | Produces requirements bundles and refined tasks.                                                       | Read-only reasoning | `opencode/nemotron-3-ultra-free`  |
| `specops-designer`                   | subagent | Produces an independent Full-tier technical design.                                                    | Read-only reasoning | `opencode/nemotron-3-ultra-free`  |
| `specops-implementer`                | subagent | Mutates repository code from approved artifacts.                                                       | Code mutation       | `opencode/north-mini-code-free`   |
| `specops-verifier`                   | subagent | Builds traceability from registered command evidence.                                                  | Command execution   | `opencode/mimo-v2.5-free`         |
| `specops-repairer`                   | subagent | Mutates code during bounded remediation cycles.                                                        | Code mutation       | `opencode/north-mini-code-free`   |
| `specops-risk-reviewer`              | subagent | Detects cross-cutting risk facets without replacing specialists; may run verification commands.        | Command execution   | `opencode/mimo-v2.5-free`         |
| `specops-correctness-judge`          | subagent | Independently judges implementation correctness; may run verification commands against the repository. | Command execution   | `opencode/nemotron-3-ultra-free`  |
| `specops-compliance-judge`           | subagent | Independently judges specification compliance; may run verification commands against the repository.   | Command execution   | `opencode/mimo-v2.5-free`         |
| `specops-review-refuter`             | subagent | Deduplicates and challenges unsupported review findings.                                               | Read-only reasoning | `opencode/nemotron-3-ultra-free`  |
| `specops-frontier-low`               | subagent | Provides bounded low-tier frontier advice for evidence-backed workflow blockers.                       | Read-only reasoning | `openai/gpt-5.6-luna`             |
| `specops-frontier-high`              | subagent | Provides bounded high-tier frontier adjudication for critical workflow blockers.                       | Read-only reasoning | `openai/gpt-5.6-sol`              |
| `specops-security-specialist`        | subagent | Reviews authentication, authorization, secrecy, and abuse risk.                                        | Read-only reasoning | `opencode/mimo-v2.5-free`         |
| `specops-data-migration-specialist`  | subagent | Reviews persistent data and migration safety.                                                          | Read-only reasoning | `opencode/nemotron-3-ultra-free`  |
| `specops-contract-specialist`        | subagent | Reviews public API and compatibility contracts.                                                        | Read-only reasoning | `opencode/mimo-v2.5-free`         |
| `specops-concurrency-specialist`     | subagent | Reviews ordering, races, locking, and atomicity.                                                       | Read-only reasoning | `opencode/mimo-v2.5-free`         |
| `specops-resilience-specialist`      | subagent | Reviews failure handling, recovery, and degradation.                                                   | Read-only reasoning | `opencode/ling-3.0-flash-free`    |
| `specops-performance-specialist`     | subagent | Reviews resource and latency regressions.                                                              | Read-only reasoning | `opencode/laguna-s-2.1-free`      |
| `specops-infrastructure-specialist`  | subagent | Reviews deployment and operational changes.                                                            | Read-only reasoning | `opencode/nemotron-3-ultra-free`  |
| `specops-usability-specialist`       | subagent | Reviews user-facing interaction quality.                                                               | Read-only reasoning | `opencode/laguna-s-2.1-free`      |
| `specops-maintainability-specialist` | subagent | Reviews clarity, structure, and long-term change cost.                                                 | Read-only reasoning | `opencode/laguna-s-2.1-free`      |

Consultation and independent-review dispatches use the same specialist identity
but different recorded purposes. A consultation therefore cannot satisfy the
independent post-implementation review gate.

# Configuration

Project policy is read from `.opencode/specops.json`. Copy
`examples/specops.json` and keep its `$schema` reference for editor validation.

Configuration version 1 is strict and camelCase. Unknown or missing fields fail startup.

## OpenSpec

`openspec.command` is either `null` for the bundled OpenSpec executable or a non-empty executable
and argument array, for example:

```json
{
    "openspec": {
        "command": ["node", "./tools/openspec.js"]
    }
}
```

No shell interpolation is performed.

## Workflow routing

| Field                            | Meaning                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| `workflow.defaultTier`           | Minimum configured tier: `auto`, `lean`, `standard`, or `full`. |
| `workflow.onboarding`            | Onboarding policy: `if-missing` or `always`.                    |
| `scopeThresholds.leanMaxFiles`   | Maximum expected files eligible for Lean.                       |
| `scopeThresholds.leanMaxModules` | Maximum expected modules eligible for Lean.                     |
| `scopeThresholds.fullMinFiles`   | File count that forces Full.                                    |
| `scopeThresholds.fullMinModules` | Module count that forces Full.                                  |
| `routing.forceFullForFacets`     | Risk facets that impose a Full floor for this project.          |

Threshold relationships are validated: Full limits must exceed Lean limits.

## Automation

`automation.requireCleanWorktree` prevents a run from starting when implementation files already
contain changes. Controller-owned OpenSpec metadata is excluded from that check.

## Escalation budgets

| Field                            | Bound                                                           |
| -------------------------------- | --------------------------------------------------------------- |
| `maxScopeEscalations`            | Monotonic tier raises accepted during one run.                  |
| `maxSpecialistDispatches`        | Additional specialist capabilities accepted through escalation. |
| `maxRepairCycles`                | Blocking remediation cycles.                                    |
| `maxRepeatedFailureFingerprints` | Repetition of the same escalation/failure fingerprint.          |

Budgets are run-state requirements, not advisory prompt text.

## Review and execution limits

| Field                   | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| `blockingSeverities`    | Finding severities treated as completion blockers. |
| `maxDiffBytes`          | Maximum implementation diff admitted to review.    |
| `maxContextBytes`       | Maximum controller context returned to a worker.   |
| `transientRetries`      | Provider retries for transient failures.           |
| `agentTimeoutSeconds`   | Worker response deadline.                          |
| `commandTimeoutSeconds` | Registered validation command deadline.            |
| `commandOutputBytes`    | Combined bounded stdout/stderr capture.            |

## Command evidence

The assessment registers arbitrary legitimate project executables, argument arrays, and optional
project-relative working directories. Execution enforces:

- direct process spawning with `shell: false`;
- exact executable and arguments from run requirements;
- a working directory confined to the project root;
- a deliberately narrow environment;
- configured timeout;
- bounded output and immutable hashes.

This is not a command allowlist. It is a run-specific evidence registry.

## MCP integration

`integrations.mcp` is `inherit` or `disabled`. Disabled mode adds an explicit instruction to
automatic and interactive workers; it does not alter deterministic scheduler state.

The non-interactive CLI adapter uses this same project configuration. Set
`workflow.defaultTier` when CI requires a minimum tier; there is deliberately no separate CLI tier
flag or second configuration source.

# Configuration

Project policy is read from `.opencode/specops.json`. Copy
`examples/specops.json` and keep its `$schema` reference for editor validation. On first plugin
load, SpecOps also creates a complete editable global file at
`$XDG_CONFIG_HOME/opencode/specops.json` (or `~/.config/opencode/specops.json`). Existing global
files are never overwritten.

Configuration version 2 is strict and camelCase. Unknown fields fail validation; missing fields
in a global or project source are filled by the merged defaults.

## Configuration sources and precedence

SpecOps merges configuration from three sources, in order of increasing precedence:

1. Built-in defaults (`DEFAULT_CONFIG`).
2. Global user configuration at `~/.config/opencode/specops.json` (or
   `$XDG_CONFIG_HOME/opencode/specops.json` when the environment variable is set).
3. Project `.opencode/specops.json`.

Either file may omit any section. The merge starts from defaults, applies the global file,
then applies the project file. Plain objects are combined recursively; arrays, primitives,
and explicit `null` replace earlier values. A project key set to the same value as the
global file is not reported as an override.

Each file is independently validated with a relaxed partial validator that allows missing
required sections but rejects unknown keys. Error messages include the offending file path.
The merged result is then validated with the strict complete validator used before a run
starts.

The first-run global file contains every supported field and current default value, so it can be
edited directly as a user-wide policy template. The project-over-global override warning is
emitted only when both the global and project files exist. A project-only file that changes
defaults is not flagged.

`$schema` is preserved as a local, relative reference in the project file and is ignored by
the runtime merge. A global file may also contain a `$schema` value; it does not affect
precedence.

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
| `scopeThresholds.leanMaxFiles`   | Maximum expected files eligible for Lean.                       |
| `scopeThresholds.leanMaxModules` | Maximum expected modules eligible for Lean.                     |
| `scopeThresholds.fullMinFiles`   | File count that forces Full.                                    |
| `scopeThresholds.fullMinModules` | Module count that forces Full.                                  |
| `routing.forceFullForFacets`     | Risk facets that impose a Full floor for this project.          |

Threshold relationships are validated: Full limits must exceed Lean limits.
`defaultTier: "auto"` uses Lean unless the initial assessment establishes a
Standard or Full safety floor. After implementation, the controller applies
the same thresholds to actual changed paths and upgrades oversized runs before
final assurance. Interactive and automatic modes share this routing policy.

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

## Adaptive frontier escalation

The optional `frontier` section enables evidence-backed assistance without
adding a mandatory model pass to every run. `mode` is `disabled` or `adaptive`;
missing configuration remains disabled.

| Field                     | Purpose                                                  |
| ------------------------- | -------------------------------------------------------- |
| `maxEscalationsPerRun`    | Distinct blocked problems admitted during one run.       |
| `maxDispatchesPerRun`     | Combined Luna/Sol subagent dispatches.                   |
| `maxHighDispatchesPerRun` | Sol-class dispatches allowed within the combined budget. |

The manifest entries `specops-frontier-low` and `specops-frontier-high`
select the actual Luna- and Sol-class models. Workers may suggest a tier, but
the controller validates critical-impact evidence and may downgrade high to
low. Frontier workers are read-only; validated advice is hashed into a fresh
dispatch of the original phase.

## Review and execution limits

| Field                   | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| `blockingSeverities`    | Finding severities treated as completion blockers. |
| `maxDiffBytes`          | Maximum implementation diff admitted to review.    |
| `maxContextBytes`       | Maximum controller context returned to a worker.   |
| `transientRetries`      | Provider retries for transient failures.           |
| `commandTimeoutSeconds` | Registered validation command deadline.            |
| `commandOutputBytes`    | Combined bounded stdout/stderr capture.            |

The default `maxDiffBytes` is 1,000,000 bytes. The limit remains a hard safety
bound and may be raised for unusually large changes. SpecOps never stashes,
resets, commits, or pushes to work around this limit. When the limit is reached,
the error reports the measured size and changed-path count.

Implementation workers must produce a real repository diff. A status-only
response or a changed local stash list is rejected by the writer guard.

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

`integrations.mcp` is `inherit` or `disabled` and defaults to `inherit`.

`inherit` leaves the host OpenCode MCP configuration unchanged. `disabled`
adds OpenCode's `mcp_*: false` tool rule to every SpecOps subagent, preventing
those workers from invoking MCP tools while leaving MCP server definitions and
primary controller agents unchanged. This policy does not alter deterministic
scheduler state.

The non-interactive CLI adapter uses this same project configuration. Set
`workflow.defaultTier` when CI requires a minimum tier; there is deliberately no separate CLI tier
flag or second configuration source.

## Worker-raised questions

A worker that hits a genuinely unresolved material decision may emit a `<!-- specops-question: ... -->`
marker. Interactive runs present validated options through OpenCode's native question UI; automatic
runs pause as a resumable block so a CLI/CI consumer can answer and resume.

| Field        | Purpose                                                   |
| ------------ | --------------------------------------------------------- |
| `prompt`     | Non-empty material decision prompt.                       |
| `options`    | One or more options with unique non-empty ids and labels. |
| `allowOther` | Whether the native UI may collect a custom answer.        |

Each marker must contain a non-empty `prompt`. It must contain at least one option unless
`allowOther` is true; custom-only questions are valid. Option ids and labels must be non-empty and
unique. In the native UI the option `label` is the canonical option id (the value the backend
validates against), and recommendation guidance is shown in the description, so the user's
selected value can be passed back unchanged as `selectedOption`.

Multiple markers in one worker output register as a multi-question batch. The run stays paused
until every question in the batch is answered; `specops_answer_questions` accepts one
transaction containing exactly one answer per pending question (no partial, duplicate, or extra
answers). Each answer supplies exactly one of `selectedOption` or `otherText`. Dismissing the
native UI records a dismissal per question id and leaves the run paused and resumable.

Answers are hashed into dispatch provenance, invalidate affected downstream artifacts, and cause
a fresh dispatch for the interrupted phase with all recorded answers replayed as untrusted user
content. Question budgets prevent unbounded loops.

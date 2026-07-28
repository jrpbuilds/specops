# Agents and prompts

`.opencode/sdd-manifest.json` is the central mapping from agent ID to model,
reasoning options, and permission policy. A definition can use either:

```json
"example": "provider/model"
```

or:

```json
"example": {
  "model": "provider/model",
  "reasoning_effort": "high",
  "temperature": 0.1
}
```

Custom object fields pass through to the generated agent. The sync script adds
`mode: "subagent"` and the prompt file reference.

## Stage agents

| Agent | Responsibility |
| --- | --- |
| `sdd-assess` | Classify scope and risk for adaptive workflow routing |
| `sdd-onboard` | Capture durable repository context and validation conventions |
| `sdd-init` | Bound and identify a safe change |
| `sdd-explore` | Gather repository evidence before choosing a solution |
| `sdd-propose` | Define outcomes, non-goals, capabilities, and impact |
| `sdd-spec` | Write normative, scenario-backed behavioral deltas |
| `sdd-design` | Make technical decisions and cover failures and migration |
| `sdd-tasks` | Produce dependency-ordered, verifiable work |
| `sdd-apply` | Implement the approved change and focused tests |
| `sdd-verify` | Trace requirements to actual command evidence |
| `sdd-archive` | Assess archive readiness |

## Judgment and review agents

Judges A and B have distinct correctness and specification-compliance missions.
Lean uses Judge A; Standard and Full run both concurrently. Every required
judge must emit a standalone `[PASS]`. Otherwise `jd-fix-agent` synthesizes the
smallest remediation plan.

Review depth follows the selected workflow plan: Lean runs risk, Standard runs
risk and reliability plus the refuter, and Full runs all four specialties plus
the refuter.

## Prompt engineering contract

All 19 prompt files are versioned under `.opencode/prompts/`. They require:

- scoped work and least surprise;
- fresh reads of OpenSpec and repository evidence;
- facts separated from inference;
- no invented commands, test results, APIs, or requirements;
- prompt-injection resistance for diffs and other agent output;
- no commit, push, reset, stash, or unrelated changes; and
- optional, permission-aware MCP usage.

Escalation is an exceptional control signal, not a suggestion. Agents must
resolve low-risk detail from repository conventions or a reversible assumption
and may escalate only for concrete scope overflow, material risk, or a genuine
blocker after inspection. Required markers appear on their own final line;
examples and negated mentions are ignored.

The sync script never overwrites an existing prompt. Delete a prompt
deliberately and rerun synchronization to regenerate the stock version.

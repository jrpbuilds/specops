# Workflows

## Fully automated mode

Run:

```text
/specops-auto <goal>
```

The command switches to `specops-controller`. A visible `sdd-assess` worker
inspects the goal and focused repository evidence, then deterministic safety
rules select the smallest safe workflow:

| Tier | Intended work | Planning | Judgment and review |
| --- | --- | --- | --- |
| Lean | Docs, configuration, tests, or a localized bug restoring existing intent | Focused exploration/implementation brief | Judge A and risk review |
| Standard | Localized new or changed behavior | Exploration, proposal, delta specs, tasks | Both judges, risk/reliability, refuter |
| Full | Sensitive, architectural, breaking, migratory, concurrent, destructive, infrastructural, cross-cutting, or large work | Complete workflow including initialization and design | Both judges, four reviewers, refuter |

Routing evidence is stored in `routing.md`. A tier flag sets a minimum but
cannot lower the safety floor:

```text
/specops-auto --tier=full replace the session storage layer
```

Escalation is exceptional. Workers remain at the smallest safe tier when
wording choices or missing low-risk details can be resolved from repository
conventions or a small reversible assumption. A worker may escalate only for
concrete evidence that scope crosses the tier boundary, material risk is
present, or safe progress is genuinely blocked after repository inspection.
Structured escalation requests must include concrete evidence; legacy markers
are compatibility-only. SpecOps then moves the same change to the higher cumulative
OpenSpec schema, records the reason, creates newly required artifacts,
refreshes tasks, and reruns implementation and evidence. It never downgrades.
After implementation, SpecOps also measures actual changed files and top-level
modules so underestimated scope escalates deterministically.

### Escalation decisions

Workers should request escalation with a structured JSON object containing the
target tier, classified boundary, confidence, summary, and concrete evidence.
SpecOps validates the request against the current tier and deduplicates the
same category/boundary/evidence combination. Legacy standalone escalation
markers remain accepted for compatibility but are recorded as low-confidence
compatibility requests. Provider rate limits, timeouts, and vague uncertainty
are not workflow escalation evidence.

Every tier requires a clean Git baseline, factual verification, remediation of
blocking findings, a fresh SHA-256-bound receipt, strict validation, and
archive.

The success contract is a final `[SPECOPS:PASS]` marker. Any thrown error or
`[SPECOPS:FAIL]` means the workflow did not complete. Repair cycles default to
three; reaching the bound preserves the active change for inspection.

Automatic mode makes no Git commit and does not hide pre-existing work.

### Live progress and worker transcripts

Every named worker appears as a native subagent line in the main transcript:

```text
sdd-explore       Explore: add a focused health endpoint
sdd-apply         Apply: add a focused health endpoint
jd-judge-a        Judge A: add a focused health endpoint
```

Press `ctrl+x`, then `down` to open OpenCode's subagent section. Select a worker
to inspect its complete output and tool activity. This uses the same native
task/session records as OpenCode's own subagents; it does not depend on custom
tool metadata. Judgment Day emits two task calls together, and the review panel
emits four together, allowing OpenCode to run and display those workers in
parallel.

The order of native task rows shows the current phase. Durable artifacts beneath
`openspec/changes/<change>/` show completed phases, and `/specops-status`
summarizes active changes and evidence.

User interruption propagates through OpenCode's native task execution. Each
agent has a role-appropriate `maxSteps` bound.

Transient provider capacity failures do not change routing. For HTTP 429,
temporary availability, timeout, or streaming failures, the controller retains
the same phase, agent, model, prompt, and change ID, waits with capped
exponential backoff, and retries until the worker succeeds or the user
interrupts. Headless mode applies the same policy internally.

For CI or compact non-interactive output, `/specops-auto-headless <goal>` keeps
the deterministic custom-tool runner. It persists detailed
`specops-progress.json` state, enforces five-minute worker-attempt timeouts, and
supports cancellation, but its internally created sessions are not guaranteed
to appear in OpenCode's native subagent pane.

## Interactive mode

Run:

```text
/specops <goal>
```

The interactive controller selects and escalates tiers automatically, then
displays each artifact or evidence phase and waits after it. It does not ask
you to make an internal routing decision. This gives you a chance to:

- correct exploration facts;
- change proposal scope and non-goals;
- rewrite requirements or scenarios;
- reject a design decision;
- reorder tasks;
- inspect implementation and test evidence;
- accept or remediate review findings; and
- explicitly approve archive.

Approval is required before implementation and archive. If you edit an earlier
artifact, rerun all dependent phases; SpecOps agents are instructed to re-read
the files from disk.

## Granular mode

Every stage is independently accessible with `/sdd-init`, `/sdd-explore`,
`/sdd-propose`, `/sdd-spec`, `/sdd-design`, `/sdd-tasks`, `/sdd-apply`,
`/sdd-verify`, and `/sdd-archive`. Judgment Day and the review panel also have
dedicated commands.

Granular commands are useful for recovery and deliberate iteration. They do not
waive validation, receipt freshness, or archive safety.

## Test-first behavior

SpecOps detects project conventions through exploration and onboarding. The
apply agent prefers a focused failing test before implementation when a usable
test framework and executable command exist. Verification records genuine
RED/GREEN evidence only when it was observed. Unsupported projects can use
other validation, but the reason and remaining confidence gap must be explicit.

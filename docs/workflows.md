# Workflows and scope tiers

Interactive, visible automatic, and non-interactive CLI entrypoints use the
same scheduler. Execution mode changes only how unresolved questions are
presented or paused; it does not change routing, stages, or assurance.

Scope tier, risk facets, and uncertainty are separate dimensions. A small security-sensitive change
may require a specialist while remaining Standard; a large low-risk refactor may require Full
because of size and design uncertainty.

## Lean

Lean is the default for small, bounded work with no requirement change,
public-contract change, or identified risk facet. Its successful normal path
uses four total subagent calls:

1. the assessor inspects and routes the change;
2. the planner returns a compact task plan;
3. the implementer applies it;
4. the verifier returns one validated bundle containing verification,
   correctness judgment, and the final review ledger.

The controller renders `exploration.md` deterministically from the assessor's
evidence. Bundling Lean assurance reduces model calls without removing its
artifacts, hashes, blocking findings, repair policy, or receipt gates.

Known risk applies the Standard/Full floor immediately. Newly discovered risk
or an actual diff above configured file/module limits upgrades the run,
invalidates downstream Lean work, and continues through the complete higher
tier workflow.

## Standard

Standard covers features, behavioral changes, bounded refactors, compatible public-contract work,
or any detected risk facet that does not force Full.

The planner returns one validated JSON bundle containing:

- proposal;
- one or more normative specifications;
- implementation tasks.

The controller validates the complete bundle before writing any member. Selected specialists may
then consult on planning. After implementation, consultation records do not count toward
independent review.

## Full

Full applies to broad changes, migrations, infrastructure work, breaking contracts, configured
high-risk facets, or low requirements/design confidence.

Planning is explicitly staged:

1. The planner returns proposal and specifications only.
2. The designer independently produces the technical design from persisted requirements.
3. The planner returns refined tasks using persisted proposal, specifications, and design.

The designer does not inherit planning consultation as an independent conclusion, and tasks cannot
be produced before design is persisted.

## Risk facets

The assessor may select security, data, public-contract, concurrency, resilience, performance,
infrastructure, migration, usability, or maintainability. Each selected facet adds:

- a focused planning consultation when useful;
- a distinct post-implementation independent review;
- provenance identifying purpose and independence.

The general risk reviewer performs a cross-cutting scan after implementation. It may request a new
facet through typed escalation but does not replace the corresponding specialist.

## Escalation

Workers may attach an explicit typed escalation claim when current requirements are insufficient.
The controller fingerprints and narrows the request, rejects duplicates or exhausted budgets, and
may:

- raise scope monotonically;
- add capabilities or review facets;
- add command validations;
- invalidate affected artifacts.

Worker prose cannot silently change routing. Every accepted or rejected claim is retained in run
state.

## Reviews and repair

Verification is followed by independent correctness judgment, compliance judgment when required,
general risk review, selected specialist review, and refutation.

The refuter returns a structured ledger. A blocking finding selects one repair mode:

- implementation defect;
- specification mismatch;
- test deficiency;
- review finding;
- design revision.

Specification/design repair is reasoned about by planner or designer and persisted by the
controller. Code repair is performed only by implementer or repairer. Downstream evidence is then
invalidated and regenerated against the new diff.

## Adaptive frontier escalation

When enabled, a worker that remains materially blocked after repository
inspection and a concrete attempt may emit one `specops-frontier` marker. The
marker names the blocked task, suggested low/high tier, workflow impact,
evidence, and prior attempts. It is mutually exclusive with question and
requirements-escalation markers.

The controller normally routes accepted requests to the low-tier frontier
subagent. High-tier routing is limited to critical security, data/migration,
breaking-contract, irreversible-design, or repeated-blocker evidence. Advice
does not mutate the repository: the originating planner, designer,
implementer, verifier, or repairer is freshly dispatched with the advice bound
into its provenance.

If the same blocker recurs after low-tier advice, the controller may promote
that episode to the high tier once. Further repeats follow the existing
bounded blocked/failure outcome. Failed judgments and blocking review-ledger
findings may enter the same adjudication path before repair. A frontier
reviewer cannot uphold or dismiss a blocker without concrete repository or
recorded command evidence.

## Worker questions

A worker may raise a structured question when a genuinely unresolved user decision is required and
repository inspection cannot resolve it. The question is carried by a machine-readable marker
separate from worker prose:

```text
<!-- specops-question: {
  "prompt": "Which authentication boundary should this change preserve?",
  "options": [
    {"id": "session", "label": "Existing session model"},
    {"id": "token", "label": "Token-based model"}
  ],
  "allowOther": true,
  "impact": "requirements"
} -->
```

A worker may raise a question only when all of the following hold:

- the choice cannot be resolved by inspecting the repository or repository conventions;
- at least two remaining outcomes are materially different;
- choosing incorrectly would alter requirements, public behaviour, safety, validation, or an
  irreversible design decision;
- a reversible low-risk assumption is insufficient.

Questions are never permitted for naming, formatting, minor implementation preferences, progress
updates, permission to continue, ordinary uncertainty, or anything resolvable from repository
conventions. Use the typed escalation marker for requirement changes that do not require a human
decision. A worker output must not contain both an escalation marker and a question marker.

### Impact and invalidation

Each question carries a constrained impact category that determines which artifacts become stale
when the answer is recorded:

| Impact           | Stale roots (downstream propagated)                            |
| ---------------- | -------------------------------------------------------------- |
| `requirements`   | `proposal` (full tier: `proposal`, `specs`, `design`, `tasks`) |
| `design`         | `design`                                                       |
| `implementation` | `implementation`                                               |
| `validation`     | `verification`                                                 |

The worker may suggest the impact, but deterministic policy validates it against the originating
phase and rejects out-of-bounds suggestions. The answer hash enters dispatch and context provenance
immediately, so a changed answer makes dependent artifacts stale.

### Interactive flow

1. A worker dispatch returns normal output plus a question marker.
2. The controller persists the question through `specops_complete_action`; no phase artefact is
   published.
3. `specops_next_action` returns an `ask-question` directive.
4. The interactive controller presents the prompt and options through OpenCode's native question
   tool, adding an "Other / provide details" option when `allowOther` is true.
5. The controller calls `specops_answer_question` with exactly one of `selectedOption` or
   `otherText`.
6. The scheduler issues a fresh dispatch for the same phase/capability with the answer included in
   its context, wrapped as untrusted user content.
7. Invalidated artifacts are regenerated against the new answer.

### Automatic and CLI execution

Automatic and CLI runs cannot answer questions. When a worker raises a question, the run pauses
with `status: "paused"`, `pauseReason: "pending-question"`, and `resumable: true`. The process
returns a dedicated `PendingQuestionResult` DTO, but the persisted change remains paused and can
be resumed interactively:

```bash
opencode run --command specops --dir /path/to/project "resume"
```

A later interactive invocation loads the paused state and immediately returns `ask-question`
without rerunning the original worker.

### Dismissal and cancellation

Dismissing the native question UI pauses the run with `pauseReason: "question-dismissed"` and
retains the pending question for re-presentation. No budget is consumed. To abandon the change,
cancel the run through `specops_cancel_run`; the pending question is flushed into history with
`outcome: "cancelled"`.

### Question budgets

Configured budgets prevent unbounded question loops:

- `maxQuestionsPerRun`: total questions raised across the run.
- `maxQuestionsPerDispatch`: questions per single dispatch (structurally one).
- `maxRepeatedQuestionFingerprints`: repeated identical questions in the same binding context.

Fingerprints include the normalised prompt, option ids and labels, phase, capability, and binding
hash. Budget exhaustion produces a non-resumable `blocked` outcome with
`blockReason: "budget-exhausted"`.

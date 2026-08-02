# Workflows and scope tiers

Interactive, visible automatic, and non-interactive CLI entrypoints use the
same scheduler. Execution mode changes only how unresolved questions are
presented or paused, and whether phase-boundary checkpoints are emitted; it
does not change routing, stages, or assurance.

Scope tier, risk facets, and confidence are separate dimensions. A small security-sensitive change
may require a specialist while remaining Standard; a large low-risk refactor may require Full
because of size and low design confidence.

Assessment confidence values are explicit: `low` means low confidence and high uncertainty,
`medium` means partial confidence, and `high` means high confidence and low uncertainty. The
assessor's suggested tier is advisory; deterministic scope and safety floors may raise it.

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

After a valid implementation diff is bound and before verification is dispatched, the controller
executes every missing registered command validation through the evidence registry. Each result is
bound to the current implementation diff and requirements policy. A failed, timed-out, or malformed
required command terminates the run with `validation-failed`; direct worker shell output does not
replace controller-recorded evidence.

## Standard

Standard covers features, behavioral changes, bounded refactors, compatible public-contract work,
or any detected risk facet that does not force Full.

The planner returns one validated JSON bundle containing:

- proposal;
- one or more normative specifications;
- implementation tasks.

Each specification must follow the spec template at submission time: at least one
`## ADDED`, `## MODIFIED`, or `## REMOVED Requirements` section, at least one
`### Requirement:` block, and every requirement must have at least one
`#### Scenario:` with both `- **WHEN**` and `- **THEN**` clauses. File-operation
prose (e.g. "DELETE <path>") is rejected as spec content.

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
infrastructure, migration, usability, or maintainability. A facet must represent a concrete,
material risk that warrants additional planning or specialist review. Generic concerns such as
ordinary documentation drift or routine maintainability do not count as a facet. Each selected
facet adds:

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

## Archiving

After a run passes its final validation gates, the change directory persists in
`openspec/changes/<change>/` until an explicit archive is confirmed. `/specops-archive` raises a
native user confirmation on the interactive controller; the resulting decision is consumed once
against the persisted confirmation id. On confirmation, OpenSpec moves the change directory to
`openspec/changes/archive/<date>-<change>/` and, for standard and full tiers, merges the specification
deltas into `openspec/specs/<capability>/spec.md`. The lean tier archives with `--skip-specs` so only
the directory is moved. Archive failures leave the run `passed` with a retryable `archiveError`; a
decline clears the gate without archiving. The automatic workflow never initiates or confirms this
mutating user-controlled operation.

## Reviews and repair

Verification is followed by independent correctness judgment, compliance judgment when required,
general risk review, selected specialist review, and refutation.

Judgments and reviewers return the same evidence-backed finding shape. The controller verifies
repository paths and registered command evidence, assigns source ids, and retains each normalized
submission against the exact implementation diff, policy, and artifact inputs it reviewed. The
refuter receives only submissions for the current binding and accounts for every source finding as
either sustained or dismissed.

The refuter returns the OpenSpec `review-ledger.json`. A blocking sustained finding selects one
repair mode:

- implementation defect;
- specification mismatch;
- test deficiency;
- review finding;
- design revision.

A blocking finding may also intentionally omit a repair mode when no bounded
repair applies. In that case the run terminates with a `review-failed`
outcome rather than entering a repair cycle.

Specification/design repair is reasoned about by planner or designer and persisted by the
controller. Compatible findings are grouped by target, with specification work before design and
code/test work. Code repair is performed only by implementer or repairer. The repairer receives a
controller-built task containing the exact finding ids, evidence, and acceptance criteria; it
cannot close its own findings.

Downstream command evidence, judgments, general-risk review, specialist review, and refutation are
then regenerated against the new diff. Historical successful commands or completed reviews cannot
satisfy a repaired implementation. A repair that produces no implementation diff is a terminal
validation failure; a repair task is marked verified only after a fresh ledger no longer sustains
its semantic findings. Finalization rejects any repair task that is not verified or explicitly
superseded, and the controller refuses to issue a second dispatch while another is still active.

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
retains the pending question for re-presentation. To abandon the change, cancel the run through
`specops_cancel_run`; the pending question is flushed into history with `outcome: "cancelled"`.

### Question validation

Question markers are structurally validated without artificial count, size, or repetition limits.
Prompts, option ids, and option labels must be non-empty; option ids must be unique. A question
must provide at least one option unless `allowOther` is true. Malformed markers are rejected and do
not mutate persisted run state.

## Phase checkpoints

Interactive runs pause once after each checkpoint-eligible phase artifact group
is produced, so the user may continue, re-run the phase with feedback, or apply
current verification findings through the implementer when they target
implementation work before the next phase.
Automatic runs never checkpoint and run start to finish.

### Checkpoint boundaries

A checkpoint is queued when a completed dispatch produces one of the following
artifact groups and it remains valid after any scope escalation:

| Dispatch                             | Checkpoint artifacts |
| ------------------------------------ | -------------------- |
| Lean planner (`lean-plan`)           | `tasks`              |
| Standard planner (`standard-bundle`) | `proposal`, `tasks`  |
| Full planner (`requirements-bundle`) | `proposal`           |
| Full designer                        | `design`             |
| Full planner (`task-refinement`)     | `tasks`              |
| Implementer                          | `implementation`     |
| Verifier                             | `verification`       |

Exploration, specs alone, judgments, reviews, refutation, repairs, and frontier
work are never checkpoint boundaries.

### Interactive flow

1. A worker dispatch completes and its phase artifacts are persisted.
2. The engine queues a pending checkpoint and moves the run to `paused` with
   `pauseReason: "checkpoint"` and `resumable: true`.
3. `specops_next_action` returns a `checkpoint` directive naming the completed
   artifacts.
4. The controller formats structured planning and Lean assurance envelopes into
   presentation-ready Markdown and presents that preview before the native
   question. It may add concise transition commentary, but copies the complete
   preview unchanged, including JSON examples and internal code fences; it must
   not wrap the complete preview in an additional code fence or transport
   container. The underlying artifact files remain the authoritative persisted
   outputs.
5. The interactive controller presents a native question with a `Continue`
   option and an `Other / provide feedback` option. Verification checkpoints
   also provide `Apply implementation fixes` only when current, diff-bound
   assurance findings target implementation work.
6. On Continue (or dismissal) the controller calls `specops_resume_checkpoint`
   with no feedback; the run resumes scheduling.
7. On Other text the controller calls `specops_resume_checkpoint` with the
   user's feedback. The checkpoint artifact group and its downstream closure are
   invalidated, and the phase is re-dispatched with the feedback injected as
   untrusted task content.
8. When the implementation-fix option is present, the controller calls
   `specops_resume_checkpoint` with `resolution: "apply-implementation-fixes"`.
   The implementation dispatch receives the feedback, and verification and all
   downstream assurance are re-run after the diff changes.
9. A regenerated phase produces a fresh checkpoint for its new output, even if
   it is the same phase as before.

### Automatic and CLI execution

Automatic runs never queue checkpoints. A persisted checkpoint-paused state in
an automatic run indicates a mode mismatch and is surfaced as a non-resumable
block for diagnosis.

### Feedback invalidation

Checkpoint feedback invalidates the just-completed artifact group and every
transitively dependent artifact via the shared dependency graph. For example,
feeding back on `proposal` invalidates `specs`, `design`, `tasks`,
`implementation`, and all assurance artifacts, exactly like a worker-question
answer with `requirements` impact.

Implementation-phase feedback re-dispatches the implementer under a fresh
writer guard. Verification-fix feedback uses the same path explicitly, rather
than being routed through planning consultations. The new diff is measured
against the post-first-implementation state, and `implementationDiffHash` is
recomputed so verification and review phases are correctly invalidated and
re-run.

### Resume provenance

Checkpoint feedback is recorded in `checkpointHistory` with a `feedbackHash`
that enters dispatch hashes, artifact `inputHashes`, and the final receipt, so
a changed feedback makes dependent artifacts stale exactly like a changed
question answer. The resume target's `origin: "checkpoint"` distinguishes it
from a worker-question resume (`origin: "question"`).

### Exact replay routing

Checkpoint feedback and worker-question answers are injected only into a
dispatch whose capability, purpose, and action mode exactly match the
targeted replay. Implementation-fix feedback intentionally targets the
implementation workflow action. Resume targets are consumed only after that
exact action is issued, preventing consultations from consuming feedback meant
for a prior phase.

### Stale checkpoint fallback

When a checkpoint is resolved (Continue or feedback) after the authoritative
run inputs have changed (policy hash, implementation diff, or artifact output
hashes), the checkpoint is recorded with `outcome: "stale"` and the run
resumes normal scheduling without applying the feedback. The user's feedback
is retained in the record for audit but is not replayed against invalidated
outputs.

### Repair exclusion

Checkpoint detection requires `purpose: "workflow"`. Repair dispatches
(`purpose: "repair"`) never checkpoint, even when they share a capability and
mode with a workflow dispatch (e.g. `planning/repair/lean-plan` or
`design/repair/artifact-repair`).

### Checkpoint outcomes

Each resolved checkpoint is recorded in `checkpointHistory` with one of:

- `continued`: the user chose Continue or dismissed the native UI.
- `feedback`: the user provided feedback that invalidated and re-ran the phase.
- `cancelled`: the run was cancelled while the checkpoint was pending.
- `stale`: the checkpoint binding no longer matched the authoritative inputs.

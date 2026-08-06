# SpecOps 1.0 Technical Specification

**Status:** Final specification
**Version:** 1.0
**Target release:** SpecOps 1.0.0
**Target platform:** OpenCode
**OpenSpec compatibility:** `>=1.7.0 <1.8.0`
**Workflow mode:** Interactive only

---

## 1. Purpose

SpecOps is an OpenCode plugin that automates the standard OpenSpec workflow using specialised language-model agents.

A user provides a software engineering goal. SpecOps investigates the repository, creates and validates the standard OpenSpec planning artifacts, implements the change, runs project validation, independently reviews the result, repairs blocking findings when possible, and presents the completed work for user approval.

SpecOps does not replace OpenSpec.

OpenSpec defines the specification workflow, artifact semantics, dependencies, validation rules, and archival lifecycle. SpecOps coordinates models and repository work around that workflow inside OpenCode.

The primary objective of SpecOps 1.0 is:

> Provide a reliable, understandable, and bounded OpenSpec-driven development workflow without attempting to deterministically control every reasoning step performed by language models.

---

## 2. Core principles

### 2.1 OpenSpec-first

OpenSpec is the authoritative specification system.

SpecOps MUST use the standard OpenSpec 1.7 `spec-driven` workflow and standard upstream artifacts.

SpecOps MUST NOT create or require:

* custom OpenSpec schemas;
* replacement artifact formats;
* parallel artifact dependency graphs;
* duplicated OpenSpec validation;
* SpecOps-specific fields inside standard OpenSpec artifacts;
* an alternative interpretation of OpenSpec artifact readiness.

A change created by SpecOps MUST remain a valid standard OpenSpec change.

Users MUST be able to inspect, update, apply, validate, and archive the change using ordinary OpenSpec tooling without SpecOps.

Removing or disabling SpecOps MUST NOT make the OpenSpec change unusable.

### 2.2 Minimal coupling

SpecOps MUST integrate with OpenSpec through a small adapter around supported public interfaces.

The OpenSpec adapter is responsible for:

* detecting the installed version;
* confirming compatibility;
* querying change status;
* retrieving artifact instructions;
* invoking validation;
* invoking archival;
* normalising supported machine-readable output;
* reporting unsupported or malformed responses clearly.

OpenSpec-specific command formats and result parsing MUST NOT be spread throughout the plugin.

SpecOps MUST NOT emulate unsupported OpenSpec behaviour or silently guess around incompatible versions.

### 2.3 One workflow

SpecOps 1.0 has one workflow.

It MUST NOT include Lean, Standard, Full, or other workflow tiers.

The amount of detail within an artifact may vary according to the change, but the workflow structure and completion rules remain the same.

### 2.4 Models own reasoning

Language models own:

* repository interpretation;
* requirement discovery;
* planning depth;
* design decisions;
* implementation decisions;
* risk identification;
* review reasoning;
* repair decisions.

TypeScript MUST NOT attempt to encode every reasoning decision as scheduler policy.

### 2.5 TypeScript owns safety and gates

TypeScript owns:

* plugin and agent registration;
* model routing;
* permissions;
* run persistence;
* path safety;
* OpenSpec invocation;
* OpenSpec validation enforcement;
* project validation execution;
* repository-state identity;
* retry and repair limits;
* cancellation;
* completion checks;
* archival initiation;
* terminal outcomes.

### 2.6 Validation gates are corrective

When model-authored work fails validation, SpecOps MUST attempt bounded correction before stopping.

A failed validation gate means:

> The current output cannot progress yet.

It does not automatically mean:

> The entire run has failed.

### 2.7 Bounded autonomy

All automated loops MUST be bounded.

SpecOps MUST NOT enter an unbounded:

* artifact correction loop;
* implementation loop;
* validation loop;
* review loop;
* repair loop;
* provider retry loop;
* frontier consultation loop.

### 2.8 Evidence over ceremony

Completion is determined by current evidence, not workflow pageantry.

A run may complete only when:

* required OpenSpec artifacts are valid;
* implementation tasks are complete;
* required project validation passes;
* the current repository state has been independently reviewed;
* no blocking findings remain;
* the user approves completion;
* OpenSpec archival succeeds.

Additional reviewers, judges, refuters, or consultations do not inherently improve this guarantee and are not part of V1.

### 2.9 Simplicity is an architectural requirement

New agents, tools, stages, protocols, state fields, and review layers MUST require a demonstrated product need.

Potential future usefulness is not sufficient justification.

---

## 3. OpenSpec compatibility

### 3.1 Supported version

SpecOps 1.0 targets:

```text
OpenSpec >=1.7.0 <1.8.0
```

The OpenSpec `v1.7.0` release identifies itself as package version `1.7.0`.

SpecOps MUST reject unsupported versions with a clear compatibility error.

SpecOps MUST NOT silently continue against OpenSpec 1.8 or later.

Future OpenSpec releases may be supported through deliberate adapter updates and compatibility testing.

### 3.2 Supported schema

SpecOps 1.0 supports only the standard upstream:

```text
spec-driven
```

schema.

If the active OpenSpec project or change uses a custom schema, SpecOps MUST:

1. preserve the existing project;
2. report that the schema is unsupported by SpecOps 1.0;
3. avoid modifying or replacing the schema;
4. refuse to start the automated workflow.

SpecOps MUST NOT override a project’s custom schema merely to make the run work.

### 3.3 Standard artifact dependencies

OpenSpec 1.7’s standard `spec-driven` schema defines:

* `proposal` with no artifact dependencies;
* `specs` requiring `proposal`;
* `design` requiring `proposal`;
* `tasks` requiring both `specs` and `design`;
* implementation requiring `tasks`.

This means `specs` and `design` become available as sibling artifacts after the proposal.

OpenSpec treats dependencies as readiness enablers rather than rigid product phases.

SpecOps MUST query OpenSpec for readiness rather than independently reproducing this dependency graph.

### 3.4 Preferred V1 orchestration order

For predictability, SpecOps 1.0 SHOULD normally create planning artifacts in this order:

```text
proposal
specs
design
tasks
```

This is a SpecOps orchestration preference, not a replacement OpenSpec dependency rule.

The coordinator MUST still confirm readiness through OpenSpec before requesting each artifact.

Specs are created before design so that the designer can reason from validated behavioural requirements.

SpecOps 1.0 MUST NOT create `specs` and `design` concurrently.

---

## 4. Scope

### 4.1 Included in SpecOps 1.0

SpecOps 1.0 includes:

* interactive OpenCode execution;
* repository exploration;
* standard OpenSpec proposal creation;
* standard OpenSpec specification creation;
* standard OpenSpec design creation;
* standard OpenSpec task creation;
* OpenSpec validation and bounded artifact correction;
* implementation;
* project validation;
* independent review;
* bounded repair;
* material user questions;
* two user checkpoints;
* coarse run persistence and recovery;
* model configuration by agent role;
* OpenSpec archival after user approval;
* diagnostics and compatibility checks.

### 4.2 Deferred beyond SpecOps 1.0

The following are deferred:

* automatic or unattended execution;
* non-interactive CLI execution;
* CI execution;
* custom OpenSpec schema support;
* specialist review skills;
* optional agent skills;
* parallel planning agents;
* adaptive model routing;
* multi-reviewer voting;
* advanced partial artifact invalidation;
* automatic adoption of unknown OpenSpec versions.

Automatic mode may be considered for SpecOps 1.1 after the interactive workflow is proven reliable.

---

## 5. User workflow

The normal SpecOps 1.0 workflow is:

```text
Start
  ↓
Explore repository
  ↓
Create and validate proposal
  ↓
Create and validate specs
  ↓
Create and validate design
  ↓
Create and validate tasks
  ↓
Planning checkpoint
  ↓
Implement
  ↓
Run required project validation
  ↓
Review current implementation
  ↓
Repair when required
  ↓
Revalidate and rereview
  ↓
Completion checkpoint
  ↓
Archive through OpenSpec
  ↓
Complete
```

Material user questions may pause the workflow at any point.

Artifact validation correction loops occur within the owning artifact stage and do not create additional user checkpoints unless automatic correction is exhausted.

---

## 6. Agents

SpecOps 1.0 defines seven agents.

```text
specops-coordinator
specops-explorer
specops-planner
specops-designer
specops-implementer
specops-reviewer
specops-frontier
```

No additional workflow agents are included in V1.

### 6.1 SpecOps coordinator

The coordinator owns high-level orchestration.

Responsibilities:

* receive the user goal;
* create or resume a run;
* coordinate the standard OpenSpec workflow;
* query OpenSpec readiness;
* delegate work to the correct agent;
* provide required context and artifact paths;
* present material questions;
* present the two checkpoints;
* invoke validation capabilities;
* initiate repair;
* enforce retry limits;
* invoke frontier consultation when justified;
* request finalisation and archival.

The coordinator MUST NOT:

* edit source code;
* author OpenSpec artifacts itself;
* perform deep repository exploration;
* approve implementation;
* override failed validation;
* bypass review;
* mark a run completed directly;
* create new workflow stages.

### 6.2 SpecOps explorer

The explorer investigates the repository.

Responsibilities:

* inspect repository structure;
* locate relevant source files;
* identify architectural conventions;
* locate relevant tests;
* inspect project configuration;
* identify likely validation commands;
* identify affected modules;
* identify material risks and constraints;
* identify questions that cannot be resolved from repository evidence;
* produce an exploration report.

The explorer is read-only.

It MUST NOT:

* edit repository files;
* produce the final OpenSpec proposal;
* produce implementation tasks;
* ask questions answerable through repository inspection;
* invent architecture unsupported by evidence.

### 6.3 SpecOps planner

The planner owns:

* `proposal.md`;
* delta specifications under `specs/`;
* `tasks.md`;
* correction of those artifacts when OpenSpec validation fails;
* revision of those artifacts after checkpoint feedback.

The planner MUST use the artifact instructions returned by OpenSpec for the active change and artifact.

It MUST NOT rely solely on hard-coded SpecOps copies of upstream templates.

The planner MUST NOT:

* edit source code;
* produce `design.md`;
* bypass OpenSpec validation;
* invent unrelated requirements;
* treat implementation details as behavioural specifications;
* silently expand scope.

### 6.4 SpecOps designer

The designer owns:

* `design.md`;
* correction of `design.md` after OpenSpec validation failures;
* design revisions requested through checkpoint feedback;
* design revisions required by implementation discoveries.

The designer MUST consume the validated proposal and specifications.

It MUST NOT:

* edit source code;
* edit proposal, specifications, or tasks directly;
* redesign unrelated repository areas;
* introduce speculative future architecture.

If the change is simple, the design may be concise, but it MUST remain a valid standard OpenSpec design artifact.

### 6.5 SpecOps implementer

The implementer owns all source-code and test mutation.

Responsibilities:

* consume the validated OpenSpec artifacts;
* implement pending tasks;
* update task checkboxes as work completes;
* add or update tests;
* follow repository conventions;
* run useful development checks;
* report material conflicts between implementation reality and the planning artifacts;
* perform review-driven repairs.

The implementer MUST NOT:

* silently rewrite requirements;
* weaken tests merely to obtain a pass;
* mark review findings resolved;
* approve completion;
* archive the change.

There is no separate repairer agent.

### 6.6 SpecOps reviewer

The reviewer independently examines:

* the original user goal;
* current OpenSpec artifacts;
* completed task state;
* the current implementation diff;
* current project validation evidence;
* relevant repository context.

The reviewer MUST assess:

* correctness;
* requirement compliance;
* regression risk;
* test adequacy;
* maintainability.

It MUST additionally assess relevant concerns where the change makes them material, including:

* security;
* data integrity;
* migration safety;
* concurrency;
* resilience;
* performance;
* public contracts;
* infrastructure;
* usability.

The reviewer MUST NOT:

* edit source code;
* invent findings to populate categories;
* block completion solely over stylistic preference;
* review an outdated repository state;
* treat successful commands as proof of semantic correctness;
* approve without inspecting the implementation.

### 6.7 SpecOps frontier

The frontier agent provides high-capability advice for genuine blockers.

The coordinator may invoke it only when:

* the originating agent inspected relevant evidence;
* a concrete attempt was made;
* a substantial blocker remains;
* ordinary retrying is unlikely to help.

The frontier agent:

* is read-only;
* provides advice to the originating agent;
* does not modify artifacts;
* does not modify source code;
* does not approve completion;
* does not replace review;
* cannot recursively invoke itself.

Only one frontier consultation is allowed for a single stage attempt.

If the blocker remains after frontier-assisted retry, the run MUST either ask a material user question or become blocked.

---

## 7. Agent prompts

### 7.1 Storage

Agent prompts MUST be stored as separate Markdown files:

```text
prompts/
├── coordinator.md
├── explorer.md
├── planner.md
├── designer.md
├── implementer.md
├── reviewer.md
└── frontier.md
```

Large prompt bodies MUST NOT be constructed from TypeScript string constants.

### 7.2 Rendering

TypeScript may inject explicit named values into prompt templates.

The renderer MUST:

* support simple named placeholders;
* reject missing required values;
* reject unresolved placeholders;
* avoid executable template logic;
* avoid loops, conditionals, macros, and inheritance;
* delimit trusted instructions from untrusted goal and repository content.

Prompt construction SHOULD remain deliberately boring.

### 7.3 Upstream OpenSpec instructions

For each standard OpenSpec artifact, the coordinator MUST retrieve current artifact instructions from the supported OpenSpec interface.

These instructions MUST be provided to the owning agent.

SpecOps prompts may explain role behaviour and quality expectations, but MUST NOT replace or contradict upstream artifact instructions.

### 7.4 Skills

SpecOps 1.0 MUST NOT ship or require agent skills.

Core behaviour is defined through agent prompts.

Skills may be reconsidered only after V1 demonstrates a concrete need that prompts cannot address cleanly.

---

## 8. File ownership

### 8.1 OpenSpec-owned files

Standard OpenSpec files remain in:

```text
openspec/changes/<change>/
├── .openspec.yaml
├── proposal.md
├── specs/
│   └── <capability>/
│       └── spec.md
├── design.md
└── tasks.md
```

The exact standard structure is determined by OpenSpec 1.7.

SpecOps MUST NOT add custom fields or sections solely for its own state management.

### 8.2 SpecOps-owned files

SpecOps metadata MUST be stored separately:

```text
.specops/runs/<change>/
├── exploration.md
├── review.md
├── run.json
└── validation/
```

This separation prevents SpecOps metadata from becoming part of OpenSpec artifact semantics.

### 8.3 Artifact writing

Agents write their owned files directly.

Planner and designer write standard OpenSpec artifacts.

The reviewer writes the SpecOps review artifact.

The explorer writes the SpecOps exploration artifact.

TypeScript MUST NOT rewrite model-authored artifact content merely to satisfy validation.

### 8.4 Write restrictions

Agent write permissions MUST be constrained to their owned paths.

Where OpenCode can enforce path-scoped editing, native edit tools SHOULD be used.

If OpenCode cannot safely enforce path-scoped edits, SpecOps MAY expose a minimal guarded write tool that:

* accepts a known artifact identifier;
* resolves the output path from OpenSpec or SpecOps state;
* prevents path traversal;
* performs atomic writes;
* does not require the model to return a large structured workflow payload.

This guarded writer is a safety boundary, not a replacement artifact protocol.

---

## 9. Artifact validation and correction

### 9.1 Validation rule

After an agent writes or updates an OpenSpec artifact, TypeScript MUST invoke OpenSpec validation before the workflow progresses past that artifact.

Model-authored claims that an artifact is valid do not satisfy this gate.

### 9.2 Correction loop

When validation fails:

1. TypeScript captures the exact OpenSpec validation output.
2. The owning agent receives:

   * the artifact path;
   * the current artifact;
   * the validation errors;
   * the correction attempt number.
3. The owning agent corrects the artifact in place.
4. TypeScript reruns validation.
5. The workflow continues only when validation succeeds.

### 9.3 Correction budget

Each artifact receives:

* one initial creation attempt;
* up to two automatic correction attempts.

The default correction budget is therefore two corrections after the initial write.

### 9.4 Exhausted correction

If the artifact remains invalid, the run enters an interactive pause.

The user MUST be shown:

* the artifact that failed;
* the OpenSpec validation errors;
* the correction attempts made;
* the current model assignment.

The user may:

* retry the same agent;
* switch the agent model and retry;
* edit the artifact manually and revalidate;
* cancel the run.

SpecOps MUST NOT reduce or bypass OpenSpec validation to continue.

### 9.5 Operational failures

OpenSpec execution failures are not artifact reasoning failures.

Examples include:

* OpenSpec not installed;
* unsupported version;
* process launch failure;
* filesystem permission failure;
* malformed machine-readable output.

These MUST produce a clear operational failure rather than being sent to an agent for correction.

---

## 10. Planning checkpoint

SpecOps 1.0 has one checkpoint before implementation.

It occurs only after:

* proposal is valid;
* specifications are valid;
* design is valid;
* tasks are valid;
* OpenSpec reports the required planning artifacts complete.

### 10.1 Planning overview

The coordinator presents a concise overview containing:

* user goal;
* proposal summary;
* behavioural requirements;
* technical approach;
* task summary;
* relevant risks;
* assumptions;
* proposed required validation commands;
* unresolved non-blocking considerations.

The overview is presentation-only.

The standard OpenSpec artifacts remain authoritative.

### 10.2 User actions

The user may choose:

* **Continue to implementation**
* **Request planning changes**
* **Cancel**

Continuing implicitly approves the displayed plan, design, and required validation command set for the run.

### 10.3 Planning feedback

When changes are requested, the coordinator determines the affected planning artifacts and routes feedback to their owners.

Typical revision scope:

* proposal intent or scope changed:

  * proposal;
  * specs;
  * design;
  * tasks;
* behavioural requirements changed:

  * specs;
  * design where affected;
  * tasks;
* technical approach changed:

  * design;
  * tasks;
* task breakdown changed:

  * tasks.

OpenSpec validation MUST rerun for every changed artifact.

The planning checkpoint is then presented again.

SpecOps 1.0 MUST NOT implement a generic transitive artifact invalidation engine.

---

## 11. Material questions

### 11.1 Permitted questions

A user question is permitted only when:

* repository inspection cannot resolve it;
* at least two materially different outcomes remain;
* choosing incorrectly would affect behaviour, compatibility, safety, data, architecture, or task scope;
* a reversible low-risk assumption is insufficient.

### 11.2 Prohibited questions

Agents MUST NOT ask the user for:

* routine naming choices covered by repository conventions;
* formatting preferences;
* minor implementation details;
* permission to continue;
* progress confirmation;
* answers available from repository inspection;
* low-risk reversible choices.

### 11.3 Question presentation

Workers report the unresolved decision to the coordinator.

Only the coordinator presents the question to the user.

SpecOps 1.0 does not require a complex typed question protocol or artifact-impact graph.

After the answer, the coordinator revises the affected artifacts or reattempts the affected stage.

---

## 12. Project validation

### 12.1 Ownership

Project validation command execution is TypeScript-owned.

The implementer may run development commands while working, but completion gates depend on recorded SpecOps validation evidence.

### 12.2 Validation command sources

Validation commands may come from:

1. explicit SpecOps project configuration;
2. repository conventions discovered by the explorer;
3. existing package, build, or CI configuration.

Explicitly configured commands are authoritative.

Explorer-discovered commands are recommendations until accepted at the planning checkpoint.

### 12.3 Command safety

Required validation commands MUST:

* use an explicit executable and arguments;
* use a known repository working directory;
* avoid unrestricted shell interpolation where practical;
* have a timeout;
* capture exit code;
* capture bounded stdout and stderr;
* record start and completion timestamps;
* associate results with the current repository-state identity.

### 12.4 Validation outcomes

A required command that:

* fails;
* times out;
* cannot execute;
* produces an invalid result;

prevents review and completion.

Validation failure normally returns the workflow to the implementer with the command evidence.

### 12.5 Validation freshness

Repository mutation after successful validation invalidates validation evidence.

Required commands MUST rerun against the new repository state.

---

## 13. Repository-state identity

SpecOps MUST calculate a deterministic identity for the implementation state.

The identity MUST include relevant:

* tracked modifications;
* staged changes;
* newly created non-ignored files;
* deleted files.

The identity MUST exclude:

* `.git/`;
* SpecOps run metadata;
* OpenSpec planning metadata when calculating the implementation-only identity;
* ignored build artifacts unless explicitly relevant.

The exact hashing algorithm is an implementation-plan concern, but it MUST be deterministic and independently testable.

Validation and review evidence MUST record the repository-state identity they evaluated.

Completion MUST be rejected when:

```text
currentRepositoryState != reviewedRepositoryState
```

or:

```text
currentRepositoryState != validatedRepositoryState
```

---

## 14. Dirty working trees

SpecOps 1.0 permits a dirty working tree.

At run start, SpecOps MUST:

* capture a baseline repository-state identity;
* record existing changed and untracked files;
* warn the user that pre-existing changes are present;
* avoid claiming all current changes were created by SpecOps.

SpecOps MUST NOT automatically reset or discard repository changes.

If files change externally during the run, SpecOps MUST:

* detect the state change at the next boundary;
* invalidate stale validation and review evidence;
* notify the user;
* reevaluate the affected stage.

Automatic rollback is out of scope for V1.

---

## 15. Review

### 15.1 Review artifact

The reviewer produces:

```text
.specops/runs/<change>/review.md
```

The review format MUST contain:

```markdown
# Review

## Verdict

pass | changes-required

## Reviewed state

<repository-state identity>

## Validation

<summary>

## Blocking findings

<findings or None>

## Non-blocking observations

<observations or None>

## Conclusion

<summary>
```

### 15.2 Findings

Each blocking finding MUST include:

* stable identifier;
* severity;
* affected file or component;
* concrete evidence;
* expected behaviour;
* observed problem;
* required correction.

A finding MUST NOT be blocking merely because another valid design might be preferred.

### 15.3 Verdict

The verdict is one of:

```text
pass
changes-required
```

A review passes only when no blocking findings remain.

### 15.4 Review freshness

The reviewer MUST review the current repository state.

Repository mutation after review invalidates the review.

---

## 16. Repair

### 16.1 Repair workflow

When review returns `changes-required`:

1. the coordinator sends all blocking findings to the implementer;
2. the implementer repairs the repository;
3. required project validation reruns;
4. the reviewer reviews the new state;
5. the run passes, repeats within budget, or becomes blocked.

### 16.2 Repair budget

The default maximum repair attempts is two.

A repair attempt is counted when the implementer is invoked against blocking review findings.

The allowed configuration range SHOULD remain small.

### 16.3 Repair exhaustion

The run becomes blocked when:

* repair attempts are exhausted;
* the implementer cannot safely resolve the findings;
* requirements conflict with repository constraints;
* a material user decision is required;
* the same blocking problem remains unresolved after frontier assistance.

The latest artifacts, source changes, validation evidence, and review MUST be preserved.

### 16.4 Prohibited repair machinery

SpecOps 1.0 MUST NOT implement:

* a separate repairer agent;
* review refutation;
* finding voting;
* semantic finding fingerprints;
* finding supersession graphs;
* grouped repair tribunals;
* correctness or compliance judges.

---

## 17. Completion checkpoint

The second and final normal checkpoint occurs after:

* implementation tasks are complete;
* required validation passes;
* review passes;
* no blocking findings remain;
* the current repository identity matches both validation and review evidence.

### 17.1 Implementation overview

The coordinator presents:

* implementation summary;
* changed areas;
* completed task summary;
* validation results;
* review verdict;
* non-blocking observations;
* OpenSpec change status;
* archive readiness.

### 17.2 User actions

The user may choose:

* **Complete and archive**
* **Request implementation changes**
* **Leave change open**
* **Cancel**

### 17.3 Request implementation changes

User feedback returns to the implementer.

After mutation:

* required validation reruns;
* review reruns;
* the completion checkpoint is presented again.

### 17.4 Leave change open

Leaving the change open sets the SpecOps run status to:

```text
verified
```

The OpenSpec change remains active and unarchived.

The user may later resume `/specops` and complete the archive step.

`verified` is not equivalent to `completed`.

### 17.5 Complete and archive

When selected, TypeScript MUST:

1. confirm current OpenSpec validity;
2. confirm all tasks are complete;
3. confirm current validation evidence;
4. confirm current review evidence;
5. invoke standard OpenSpec archival;
6. persist the archive result;
7. mark the run completed only after archive success.

### 17.6 Archive failure

Archive failure MUST preserve the verified implementation and all evidence.

The run enters a retryable failed state with:

* the OpenSpec error;
* the attempted change;
* the current repository identity;
* the archive attempt timestamp.

Retrying archive MUST NOT rerun implementation when repository state remains unchanged.

---

## 18. Run state

### 18.1 Separation from OpenSpec state

SpecOps MUST NOT duplicate OpenSpec artifact readiness or validation state.

When OpenSpec state is needed, SpecOps queries OpenSpec.

### 18.2 Status values

```text
active
awaiting-user
verified
completed
blocked
failed
cancelled
```

### 18.3 Stage values

```text
exploration
proposal
specs
design
tasks
implementation
validation
review
repair
archive
```

### 18.4 Minimum persisted state

`run.json` contains only information required to operate, resume, diagnose, and finalise the run.

Representative fields:

```json
{
  "version": 1,
  "change": "change-name",
  "goal": "user goal",
  "status": "active",
  "stage": "implementation",
  "startedAt": "timestamp",
  "updatedAt": "timestamp",
  "baselineRepositoryState": "hash",
  "currentRepositoryState": "hash",
  "validatedRepositoryState": null,
  "reviewedRepositoryState": null,
  "artifactCorrectionAttempts": {},
  "repairAttempts": 0,
  "failure": null
}
```

The final schema will be defined during implementation planning.

### 18.5 Persistence

Run-state writes MUST be atomic.

A process interruption MUST NOT leave partially written JSON.

Completed artifacts and repository work MUST be preserved after failure.

---

## 19. Recovery and retries

### 19.1 Recovery boundaries

SpecOps recovers at coarse persisted boundaries.

Examples:

* interrupted exploration:

  * retry exploration;
* invalid proposal:

  * resume proposal correction;
* interrupted implementation:

  * inspect current repository state and resume implementation;
* failed validation:

  * resume implementation with validation evidence;
* failed reviewer invocation:

  * retry review;
* failed archive:

  * retry archive when state remains unchanged.

SpecOps MUST NOT attempt to reconstruct every interrupted model action.

### 19.2 Provider retries

Transient provider failures may receive one automatic retry.

Examples:

* temporary rate limit;
* transient connection failure;
* provider service error.

Malformed or semantically incorrect output MUST NOT be blindly retried as a transient error.

The user may manually retry a stage or switch the configured model.

### 19.3 Cancellation

Cancellation MUST:

* stop further orchestration;
* mark the run cancelled;
* preserve artifacts;
* preserve repository changes;
* preserve diagnostics.

Cancellation MUST NOT delete or reset user work.

---

## 20. Permissions

Permissions follow least privilege.

| Agent       | Repository read |  Commands | Source edit |             Artifact edit | Delegate | Ask user |
| ----------- | --------------: | --------: | ----------: | ------------------------: | -------: | -------: |
| Coordinator |         Limited |        No |          No |                        No |      Yes |      Yes |
| Explorer    |             Yes | Read-only |          No |          Exploration only |       No |       No |
| Planner     |             Yes | Read-only |          No | Proposal/specs/tasks only |       No |       No |
| Designer    |             Yes | Read-only |          No |               Design only |       No |       No |
| Implementer |             Yes |       Yes |         Yes | Tasks only where required |       No |       No |
| Reviewer    |             Yes | Read-only |          No |               Review only |       No |       No |
| Frontier    |             Yes | Read-only |          No |                        No |       No |       No |

No subagent may dispatch another subagent.

Only the coordinator may delegate work.

---

## 21. Plugin tool surface

The workflow protocol tool surface MUST remain small.

The final workflow-specific tool count SHOULD NOT exceed six without a specification revision.

The tool surface must provide only the capabilities required for:

* starting or resuming a run;
* reading status;
* updating coarse run state;
* invoking OpenSpec validation;
* executing project validation;
* finalising or cancelling a run.

SpecOps MUST NOT expose tools requiring models to manually manage:

* dispatch IDs;
* capability graphs;
* artifact dependency graphs;
* provenance tuples;
* review tribunals;
* escalation episodes;
* scheduler internals.

Native OpenCode subagent and question mechanisms SHOULD be used where appropriate.

---

## 22. Public commands

SpecOps 1.0 exposes:

```text
/specops
/specops-status
/specops-cancel
/specops-doctor
/specops-onboard
```

### `/specops`

Starts a new interactive run or resumes the active run for the current change.

### `/specops-status`

Shows:

* goal;
* status;
* current stage;
* OpenSpec artifact status;
* correction attempts;
* validation results;
* review verdict;
* repair attempts;
* blocked or failed reason.

### `/specops-cancel`

Cancels an active run without deleting artifacts or repository changes.

### `/specops-doctor`

Validates installation and compatibility.

### `/specops-onboard`

Initialises or verifies standard OpenSpec project support.

It MUST use upstream OpenSpec setup behaviour.

It MUST NOT install a custom SpecOps schema.

### Excluded commands

SpecOps 1.0 does not expose:

```text
/specops-auto
```

or non-interactive CLI adapters.

---

## 23. Configuration

Configuration may include:

* model mapping for each agent;
* supported model variants;
* required validation commands;
* command timeouts;
* artifact correction limit;
* repair limit;
* bounded output capture settings;
* optional archive preferences that do not bypass final approval.

Configuration MUST NOT expose:

* workflow tiers;
* scope thresholds;
* specialist mappings;
* dispatch budgets;
* refutation behaviour;
* capability graphs;
* frontier levels;
* artifact dependency overrides;
* custom OpenSpec schema installation.

Defaults MUST allow the plugin to run with minimal setup once OpenSpec is available.

---

## 24. Model routing

SpecOps supports independent model configuration for:

```text
coordinator
explorer
planner
designer
implementer
reviewer
frontier
```

TypeScript owns the mapping from role to configured model.

Model configuration MUST NOT alter:

* agent permissions;
* agent ownership;
* OpenSpec workflow;
* completion conditions;
* retry limits.

V1 does not implement automatic model escalation.

The frontier model is invoked only through the explicit frontier policy.

---

## 25. Diagnostics

`/specops-doctor` MUST validate:

* compatible OpenCode version;
* compatible OpenSpec version;
* standard `spec-driven` schema availability;
* absence of required custom SpecOps schemas;
* prompt-file presence;
* prompt placeholder validity;
* agent registration;
* model mappings;
* permission configuration;
* configuration validity;
* writable SpecOps state paths;
* writable OpenSpec change paths;
* validation command configuration;
* supported OpenSpec JSON interfaces.

Doctor output MUST distinguish:

* errors;
* warnings;
* informational findings.

Each error SHOULD provide concrete remediation.

---

## 26. Security and safety

SpecOps MUST:

* validate change names;
* prevent path traversal;
* canonicalise managed paths;
* prevent artifact writes outside approved locations;
* avoid destructive shell interpolation;
* treat user and repository content as untrusted;
* preserve user files;
* preserve existing repository changes;
* prevent read-only agents from editing source code;
* prevent the coordinator and reviewer from mutating implementation code;
* associate validation and review evidence with repository identity;
* reject stale completion evidence.

Existing proven filesystem-safety and atomic-write utilities may be reused after review.

---

## 27. Migration from previous SpecOps versions

### 27.1 Existing runs

Runs created by the previous workflow engine are not resumable in SpecOps 1.0.

SpecOps MUST detect incompatible legacy state and report it clearly.

It MUST NOT silently reinterpret old state.

### 27.2 Existing schemas

Legacy SpecOps-installed custom schemas MUST NOT be deleted automatically.

`/specops-doctor` SHOULD identify them and explain that SpecOps 1.0 uses the standard OpenSpec schema.

### 27.3 Model mappings

Existing model selections may be migrated only when the mapping to a new role is unambiguous.

Otherwise, the role inherits the configured OpenCode default and the migration report explains the result.

### 27.4 Existing artifacts

Existing standard OpenSpec changes remain usable.

SpecOps 1.0 may operate on an existing compatible active change only when its standard artifacts and schema are valid.

---

## 28. Explicit non-goals

SpecOps 1.0 does not include:

* automatic mode;
* unattended execution;
* CI orchestration;
* workflow tiers;
* deterministic scope classification;
* a separate assessor;
* a separate repairer;
* correctness judges;
* compliance judges;
* general-risk reviewers;
* specialist reviewer agents;
* review refuters;
* low and high frontier levels;
* specialist skills;
* required skills;
* custom OpenSpec schemas;
* replacement OpenSpec workflows;
* duplicated OpenSpec validation;
* a parallel artifact dependency graph;
* typed escalation protocols;
* dynamic workflow stages;
* consultation provenance;
* dispatch completion protocols;
* event-sourced model activity;
* partial transitive invalidation;
* finding adjudication;
* finding voting;
* unbounded retries;
* automatic rollback;
* backward-compatible resumption of old workflow runs;
* a generic workflow engine for products other than SpecOps.

These features MUST NOT be added during implementation without revising this specification.

---

## 29. Testing requirements

Core TypeScript behaviour MUST be testable without invoking real language models.

### 29.1 Unit and integration coverage

Tests MUST cover:

* OpenSpec version detection;
* unsupported-version rejection;
* standard-schema enforcement;
* OpenSpec status parsing;
* OpenSpec instruction retrieval;
* artifact validation;
* artifact correction budgets;
* atomic state persistence;
* prompt rendering;
* prompt placeholder rejection;
* path safety;
* agent permissions;
* baseline capture;
* repository-state hashing;
* validation freshness;
* review freshness;
* repair limits;
* cancellation;
* verified-but-unarchived state;
* archive retry;
* legacy-state rejection.

### 29.2 End-to-end scenarios

Before release, SpecOps MUST demonstrate:

1. a trivial bug fix;
2. a small feature;
3. a multi-file feature;
4. a change requiring meaningful design;
5. an invalid proposal corrected automatically;
6. an invalid specification corrected automatically;
7. failed project validation followed by repair;
8. blocking review findings followed by repair;
9. artifact correction exhaustion and user intervention;
10. a material user question;
11. planning checkpoint feedback;
12. completion checkpoint feedback;
13. a dirty working tree;
14. external mutation detection;
15. interrupted run recovery;
16. archive failure and retry;
17. leaving a verified change open;
18. later completion of a verified change.

End-to-end testing SHOULD include at least two model families.

---

## 30. Release acceptance criteria

SpecOps 1.0 is ready for release when all the following are true.

### 30.1 OpenSpec-native behaviour

* Uses OpenSpec 1.7 standard `spec-driven` artifacts.
* Uses OpenSpec for readiness, instructions, validation, and archival.
* Creates no custom schema.
* Produces changes usable through ordinary OpenSpec tooling.

### 30.2 Functional workflow

Given a supported repository and clear goal, SpecOps can:

* explore;
* plan;
* design;
* obtain user approval;
* implement;
* validate;
* review;
* repair;
* obtain final approval;
* archive;
* complete.

### 30.3 Corrective validation

Invalid agent-authored artifacts are returned to their owner with exact validation errors.

The workflow does not immediately fail on correctable validation errors.

### 30.4 Bounded failure behaviour

All correction, retry, frontier, and repair loops terminate predictably.

Exhaustion results in a clear user-controlled or blocked state.

### 30.5 Fresh evidence

Stale validation or review evidence cannot satisfy completion.

### 30.6 Understandability

A developer unfamiliar with the implementation can understand normal execution by reading:

* this specification;
* one orchestration module;
* the OpenSpec adapter;
* the run-state schema;
* the seven prompt files;
* the small tool surface.

Understanding the workflow must not require tracing capability registries, reviewer tribunals, or generated wire-contract machinery.

---

## 31. Change-control rule

This specification is the source of truth for SpecOps 1.0.

Before implementation:

1. this specification must be accepted;
2. an implementation plan must be derived from it;
3. the implementation plan must map requirements to deliverables and tests;
4. no new product feature may enter through planning without a specification revision.

During implementation, proposed work outside this specification must be:

* rejected;
* deferred;
* or added through an explicit specification amendment.

“No, that is not part of SpecOps 1.0” is a successful application of the project process.

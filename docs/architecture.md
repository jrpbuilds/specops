# Architecture

SpecOps separates deterministic control from model reasoning. The controller owns workflow state,
artifact persistence, evidence registration, invalidation, budgets, and completion. Agents receive
one scheduler-authorized action and return bounded content or repository mutations permitted by
their role.

## Runtime layers

1. **OpenCode integration** registers public commands, deterministic protocol tools, and the exact
   final agent catalogue through one config hook.
2. **Canonical capability registry** owns agent IDs, roles, modes, default models, tools, and
   non-overridable permissions.
3. **Deterministic scheduler** examines current requirements, artifact validity, dispatch
   provenance, repair state, and budgets to select one next action.
4. **Workflow engine** issues dispatch records, validates worker results, persists controller-owned
   artifacts, applies bounded escalation decisions, and produces receipts.
5. **State and artifact stores** use atomic replacement beneath one OpenSpec change.
6. **Evidence registry** executes declared project commands without a shell and records immutable
   hashes and bounded excerpts.

## Shared execution engine

Interactive and automatic runs differ only in question presentation. Both use
OpenCode's native task mechanism and call the same `issueDirective`,
`completeAction`, validation, and finalization functions. The scheduler follows
the routed requirement envelope rather than adding mode-specific phases.

A normal Lean run consolidates inspection into assessment and correctness
assurance into verification. Standard and Full retain their independent
exploration, judgment, risk, specialist, and refutation stages.

Automatic execution has two OpenCode adapters:

- `/specops-auto` starts it from the visible command palette.
- `opencode run --command specops-auto --dir <project> <goal>` starts the same command and
  controller without opening the TUI.

No public command contains its own workflow implementation. Future commands must enter through a
registered protocol tool or controller.

## Ownership boundaries

| Concern                         | Owner                        |
| ------------------------------- | ---------------------------- |
| Scope and required capabilities | Deterministic routing policy |
| Next executable action          | Scheduler                    |
| Proposal/spec/task reasoning    | Planner                      |
| Independent Full-tier design    | Designer                     |
| Artifact validation and writes  | Controller                   |
| Repository code mutation        | Implementer or repairer      |
| Command execution               | Evidence registry            |
| Correctness/compliance verdicts | Independent judges           |
| Review deduplication            | Refuter                      |
| Invalidation and completion     | Controller                   |

Planner and designer agents are read-only. Their responses become authoritative only after
controller validation and atomic persistence. This keeps artifact reasoning separate from
repository mutation.

## Command and agent materialisation

On plugin load, the package wrapper:

1. Resolves OpenCode's XDG configuration directory.
2. Loads the user model manifest.
3. Replaces the file if it is absent, malformed, partial, or contains a non-final catalogue.
4. Registers commands through the inner plugin hook.
5. Registers every manifest agent into the same resolved OpenCode config object.

This order prevents a command from surviving without its controller. The persisted manifest stores
user model choices; OpenCode's resolved in-memory config contains the complete executable agent
definitions, including embedded prompts and registry-controlled authority.

## Scheduler invariants

- At most one action is issued for a scheduling decision.
- A dispatch records capability, purpose, independence, input hash, agent, and status.
- Consultation never satisfies independent review.
- General risk review can detect facets but cannot fulfill specialist review.
- Repository mutations stale all downstream verification and assurance artifacts.
- A receipt is impossible while a required artifact is absent or stale.
- Escalation can only add bounded requirements or raise scope.
- Repair budgets and repeated-fingerprint budgets terminate loops deterministically.

## Worker-output contracts

Worker agents (planner, judges, refuter) must return output in exact wire-format
shapes: a planning bundle, an independent judgment, a refuted review ledger, or
similar structured payloads. The same architectural boundary governs each
format: a single shared source of truth for enum value sets and validation
patterns, generated contract strings consumed by dispatch prompts, and engine
parsers that validate against the canonical values. The planner, judges, and
refuter therefore all receive the exact expected output shape in their
prompts, and the engine rejects malformed submissions with specific, actionable
error messages. A change to an accepted enum or template heading cannot
silently drift between prompt, parser, and OpenSpec template because all three
derive from the same canonical values.

The final run format is described in [Artifacts and state](artifacts-and-state.md).

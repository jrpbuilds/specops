# Repository Instructions

## Code quality and documentation

- Keep all code well formatted and consistently structured according to the
  repository's existing style.
- Use logically named functions, types, variables, modules, and files.
- Add complete docblocks to exported and internal functions, classes, types,
  and other non-trivial public or reusable code, following the existing
  documentation format.
- Add concise comments where they clarify intent, invariants, safety
  boundaries, control flow, or non-obvious implementation decisions.
- Keep comments accurate as code changes; do not use comments to preserve
  obsolete behavior or superseded architecture.

## Workflow changes

- Keep workflow routing and state transitions deterministic. Model output may
  propose actions, but it must not directly control persisted state or
  completion.
- For every new state-machine branch, define and test its success, retry,
  exhaustion, malformed-output, and safe-fallback behavior.
- Bind resumable work to its exact originating capability, purpose, and phase.
  Resume targets must be consumed at most once.
- Never treat an explicit blocker, an exhausted budget, or an unverifiable
  decision as successful phase completion.
- When configuration or agent catalogues change, update the schema, example,
  documentation, generated files, and packed-install coverage together.

## Version compatibility

- Do not add backward-compatibility or migration code for features unless
  explicitly requested. Assume all runs are fresh for the current version; do
  not normalize, migrate, or preserve superseded state shapes, field names, or
  legacy persisted records on read.
- When a type or persisted shape changes, change it directly. Remove obsolete
  fields and their handling rather than keeping both old and new forms alive.
- The only exception is an explicit user request to preserve compatibility
  with previously persisted data.

## Validation

- Add automated tests for every new feature and behavior change. Cover the
  success path and all material failure, retry, budget, fallback, persistence,
  and compatibility paths in proportion to risk.
- When a test fails, treat the source implementation as the failure point by
  default. Diagnose the root cause by tracing the execution path before writing
  any fixes. Never modify test assertions, mocks, or expected values to make a
  failing test pass unless you have explicitly verified that the test's
  underlying assumption is flawed or outdated.
- Add a regression test for every corrected workflow bug.
- Prefer assertions on observable state transitions, dispatch provenance,
  invalidation, and terminal outcomes over private implementation details.
- Run `npm run generate` when generated content changes and `npm run check`
  before handing off.

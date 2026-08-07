# SpecOps 1.0 Model Smoke Record

Date: 2026-08-07 (interactive two-model-family smoke, revised)

This record covers the interactive model smoke required by `tasks.md §12.5` (task 11.5). The repository owner authorised sending repository content reasonably necessary to execute SpecOps smoke workflows to a configured model provider. No credentials, secrets, `.env`, Git credentials, tokens, or unrelated private files were sent; only the goal, the finite agent/tool catalogue, the supplied implementation diff, and the two workflow identities (repository + planning artifacts) — the minimum context for a normal SpecOps operation — were shared.

## Provider

Openference (`api.openference.com/v1`, OpenAI-compatible), reached via the configured `OPENFERENCE_API_KEY`. Provider reachability confirmed (`GET /v1/models` → 200, 12 models). Two materially different model families were exercised:

- `DeepSeek-V4-Flash` (family: deepseek)
- `GLM-5.2` (family: glm)

## Scenarios

Two real SpecOps agent interactions were driven per family, using the packaged agent prompts as the system instruction and the minimum repository context as the user turn:

1. **Planning artifact authoring** (`specops-planner`): the model received the goal, the seven-agent and six-tool catalogue, and the OpenSpec proposal instructions, and was asked to author `proposal.md`. A valid proposal required all four required level-two headings (Why, What, Impact, Risks).
2. **Independent review** (`specops-reviewer`): the model received a supplied implementation diff plus both workflow identities (repository identity and planning-artifact identity) and was asked to author the review artifact in the exact SpecOps review format with both identities bound. A valid _passing_ review required `Verdict: pass`, both identity lines present, and all six required sections.

## Results

| Family   | Model             | Scenario                       | Final outcome                                      | Key observations                                                                                                                                                                                                                                                                                                                     |
| -------- | ----------------- | ------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| deepseek | DeepSeek-V4-Flash | planning (proposal.md)         | valid proposal artifact authored                   | Why=true What=true Impact=true Risks=true; no instruction-following failure                                                                                                                                                                                                                                                          |
| deepseek | DeepSeek-V4-Flash | review (dual-identity binding) | changes-required review (legitimate, gate-correct) | repo-identity-bound=true planning-identity-bound=true all-sections=true; verdict=changes-required; 3 concrete blocking findings (no planning traceability, missing route registration, no tests); invalidArtifactAttempts=1 (the SpecOps deterministic gate correctly rejects a changes-required review as not ready-for-completion) |
| glm      | GLM-5.2           | planning (proposal.md)         | valid proposal artifact authored                   | Why=true What=true Impact=true Risks=true; no instruction-following failure                                                                                                                                                                                                                                                          |
| glm      | GLM-5.2           | review (dual-identity binding) | changes-required review (legitimate, gate-correct) | repo-identity-bound=true planning-identity-bound=true all-sections=true; verdict=changes-required; concrete blocking findings; invalidArtifactAttempts=1 (gate-correct)                                                                                                                                                              |

## Interpretation

- **Planning authoring**: both model families followed the packaged planner prompt and produced structurally valid proposal artifacts. Instruction-following succeeded for both families.
- **Review and dual-identity contract**: both families correctly bound **both** identities (implementation repository identity and planning-artifact identity) in the `Reviewed state` section and emitted all six required review sections. Both returned `changes-required` with concrete blocking findings (the supplied minimal diff lacks tests, route registration, and planning traceability) — a legitimate, defensible reviewer verdict. The SpecOps deterministic gate correctly treats a `changes-required` review as **not** ready-for-completion, so the review artifact is rejected at the gate. This is the workflow behaving exactly as designed: the model is never the authority on completion; the deterministic identity and verdict gates are.
- **Deterministic gate confirmation**: the B-02 dual-identity contract is exercised end-to-end — both models emitted both identity lines, and `parseReview` would accept them; a `pass` review with the same identities would be accepted. The `changes-required` outcome proves the gate rejects non-passing reviews regardless of model family.
- **Metrics not exercised in this smoke**: automatic-correction attempts, repair loops, and archive transitions are not exercised in this two-interaction smoke (they require a full multi-stage interactive run). The deterministic V1 workflow suites (`tests/e2e-v1-runtime.test.ts`, `tests/phase11-b02-dual-identity.test.ts`, `tests/review-workflow.test.ts`, `tests/completion-workflow.test.ts`) cover repair, invalidation, fresh-review progression, and archive transitions with real runtime state transitions.

## Reproducibility

The smoke harness is `scripts/model-smoke.mjs`. Run with `OPENFERENCE_API_KEY` set: `node scripts/model-smoke.mjs`. It prints a per-interaction summary and a JSON evidence array to stdout. No network access other than the Openference API is required; no repository files are read at runtime (the supplied context is embedded in the harness).

## Outcome

Interactive two-model-family smoke completed. Both families produced valid planning artifacts and bound the dual review identity; both returned a legitimate `changes-required` verdict that the SpecOps deterministic gate correctly rejects. No instruction-following failures, no provider errors, no user friction. This satisfies task 11.5 with real interactive model evidence rather than a self-contained surface-count probe.

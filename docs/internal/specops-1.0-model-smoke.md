# SpecOps 1.0 Model Smoke Record

Date: 2026-08-07

This release-readiness probe used a self-contained V1 surface-count instruction so no repository content was sent to a model provider. Repository-facing planning, validation, review, repair, and archive transitions are covered by the deterministic V1 workflow suites.

| Model family | Model                           | Result | Observation                                                                         |
| ------------ | ------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| OpenAI       | `openai/gpt-5.4-mini`           | Passed | Returned `agents=7 commands=5 tools=6` exactly. No tool call was requested or made. |
| OpenCode-go  | `opencode-go/deepseek-v4-flash` | Passed | Returned `agents=7 commands=5 tools=6` exactly. No tool call was requested or made. |

There were no instruction-following failures, tool-call failures, or user-friction observations in these self-contained probes. Invalid artifact rate, correction success, review quality, and repair success are not applicable to this limited smoke; the deterministic workflow matrix covers those outcomes. Before a release that permits repository content to be sent to providers, repeat the procedure in `docs/development.md` with representative interactive changes and record those outcome metrics here.

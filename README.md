# SpecOps 1.0

> **OpenSpec defines the specification workflow. SpecOps automates that standard workflow inside OpenCode.**

SpecOps is an interactive OpenCode plugin for the upstream OpenSpec 1.7 `spec-driven` workflow. It requires Node `>=24.18.1`, OpenCode `>=1.18.10`, and OpenSpec `>=1.7.0 <1.8.0`; it uses no custom SpecOps schema and leaves every change usable with ordinary OpenSpec tooling.

Use `/specops <goal>` to start or resume. The workflow explores, authors and validates proposal/specs/design/tasks, pauses for planning approval, implements, validates, independently reviews, repairs bounded blocking findings, pauses for completion approval, and archives only after that approval.

Public commands: `/specops`, `/specops-status`, `/specops-cancel`, `/specops-doctor`, `/specops-onboard`.

The seven roles are coordinator, explorer, planner, designer, implementer, reviewer, and frontier. The six workflow tools are start/resume, reconcile stage, get status, run validation, finalize, and cancel.

See [getting started](docs/getting-started.md), [workflow](docs/workflows.md), [configuration](docs/configuration.md), and [troubleshooting](docs/troubleshooting.md).

`/specops-auto` and `/specops-archive` are removed. Automatic mode is not part of 1.0.

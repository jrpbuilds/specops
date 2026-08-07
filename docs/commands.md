# Commands

SpecOps 1.0 exposes exactly five commands.

| Command            | Purpose                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `/specops <goal>`  | Start or resume the interactive workflow.                               |
| `/specops-status`  | Show run, artifact, evidence, review, checkpoint, and failure state.    |
| `/specops-cancel`  | Cancel safely without deleting repository work or artifacts.            |
| `/specops-doctor`  | Diagnose OpenCode/OpenSpec, schema, paths, migration, and legacy state. |
| `/specops-onboard` | Initialise or verify upstream OpenSpec `spec-driven` support.           |

There is no automatic command and no separate archive command. Resume `/specops` to retry a failed archive when repository identity is unchanged.

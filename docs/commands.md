# Commands

Public commands are registered by the plugin config hook. This table is generated
from the runtime command catalogue so controller and adapter targets cannot drift.

| Command            | Purpose                                                         | Runtime target                                 |
| ------------------ | --------------------------------------------------------------- | ---------------------------------------------- |
| `/specops-auto`    | Run visible deterministic SpecOps workflow                      | primary agent `specops-auto-controller`        |
| `/specops`         | Run deterministic SpecOps workflow with checkpoints             | primary agent `specops-interactive-controller` |
| `/specops-onboard` | Install final SpecOps OpenSpec assets                           | protocol tool `specops_onboard`                |
| `/specops-status`  | Show final SpecOps run status                                   | protocol tool `specops_get_status`             |
| `/specops-archive` | Archive a verified or completed-unarchived change (maintenance) | primary agent `specops-interactive-controller` |
| `/specops-doctor`  | Diagnose final SpecOps installation                             | protocol tool `specops_doctor`                 |

Interactive and automatic execution both use the deterministic scheduler.
Non-interactive automation uses OpenCode's supported
`opencode run --command specops-auto --dir <project> <goal>` adapter, which
resolves the same automatic controller as the command palette. Any future focused
command must enter through a protocol tool or registered controller; it must not
dispatch workers or mutate run state directly.

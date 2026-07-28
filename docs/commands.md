# Command reference

| Command | Purpose |
| --- | --- |
| `/specops-auto [--tier=lean\|standard\|full] <goal>` | Auto-size and complete the workflow with native workers |
| `/specops-auto-headless <goal>` | Run compact deterministic automation for CI/headless use |
| `/specops [--tier=lean\|standard\|full] <goal>` | Auto-size, then run with phase approvals |
| `/specops onboard <context>` | Install assets and refresh repo-local onboarding memory |
| `/sdd-onboard <context>` | Install missing assets and refresh durable project context |
| `/sdd-init [context]` | Bootstrap scope and change identity |
| `/sdd-explore [context]` | Explore repository evidence |
| `/sdd-propose [context]` | Create or revise the proposal |
| `/sdd-spec [context]` | Create or revise behavioral specs |
| `/sdd-design [context]` | Create or revise the design |
| `/sdd-tasks [context]` | Create or revise the implementation checklist |
| `/sdd-apply [context]` | Implement approved tasks |
| `/sdd-verify [context]` | Run traceable verification |
| `/specops-judgment-day <task>` | Run both judges and produce a fix plan on failure |
| `/specops-review-panel` | Run four reviewers and the refuter |
| `/sdd-archive [context]` | Assess and perform an approved archive |
| `/specops-status` | Summarize active changes and receipt state |
| `/specops-doctor` | Run non-mutating readiness checks |

Commands are registered by the plugin's configuration hook. Existing user
commands with the same name are preserved rather than overwritten.

## Tool surface

The plugin exposes these tools to primary agents:

- `specops_prepare_auto`
- `specops_escalate_auto`
- `specops_save_onboarding`
- `specops_save_artifact`
- `specops_check_scope`
- `specops_diff`
- `specops_finalize_auto`
- `specops_onboard`
- `specops_doctor`
- `specops_openspec` (read-only CLI allowlist)
- `specops_judgment_day`
- `specops_review_panel`
- `specops_run_auto`

The visible controller receives narrowly scoped preparation, persistence,
diff, and finalization tools. Mutation-capable generic OpenSpec operations
remain internal; ordinary agents cannot archive or create arbitrary changes
through the read-only CLI wrapper.

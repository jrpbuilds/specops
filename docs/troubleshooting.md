# Troubleshooting

Start with `/specops-doctor`. It performs read-only checks against the installed package,
OpenCode command registration, the materialised agent manifest, canonical agent catalogue,
generated prompts, and bundled OpenSpec schemas. Every failure includes a repair action.

## A command reports a missing controller

`/specops` must resolve to `specops-interactive-controller`, and `/specops-auto` must resolve to
`specops-auto-controller`. Both are primary OpenCode agents registered by the same plugin hook
that registers the commands.

1. Restart OpenCode so it reloads the installed plugin.
2. Run `/specops-doctor` and note the reported manifest path.
3. Run `opencode debug config` and confirm the plugin and both command mappings are present.
4. Run:

    ```bash
    opencode debug agent specops-interactive-controller
    opencode debug agent specops-auto-controller
    ```

5. If the package was installed from this checkout, rebuild and reinstall it:

    ```bash
    npm install
    npm run check
    opencode plugin @jrpbuilds/specops -g -f
    ```

Agent registration is deliberately all-or-nothing. Before registration, the plugin materialises
the exact canonical manifest. A missing, malformed, partial, or wrong-catalogue manifest is
atomically replaced; removed pre-release IDs are not translated or preserved.

## The manifest is missing or invalid

The default path is:

```text
$XDG_CONFIG_HOME/opencode/specops-manifest.json
```

When `XDG_CONFIG_HOME` is unset, it is
`~/.config/opencode/specops-manifest.json`. Run `/specops-doctor` to confirm the exact path used.

The schema-v2 manifest may customise only `model` and optional OpenCode `variant` for every
canonical agent. Use `SpecOps: Configure agent models` in the command palette so choices are
validated against OpenCode's current configured-model catalogue. Restart or reload OpenCode after
saving, then run `/specops-doctor`.

If the file cannot be parsed or its agent catalogue is incomplete, restart OpenCode. Plugin load
will replace it with the generated default using a temporary file and atomic rename. If that
fails, check directory ownership and write permissions for the reported configuration directory.

A schema-v1 file is handled differently: SpecOps preserves it byte-for-byte, uses packaged
defaults for the current session, and opens the mapping screen once per launch. Dismissing the
screen leaves the file untouched, so it is offered again next launch. If the editor reports that
settings changed on disk, reopen it; SpecOps intentionally refuses to overwrite a concurrent edit.

## OpenSpec schemas are unavailable

Run:

```text
/specops-onboard
```

This installs the final Lean, Standard, and Full schemas in the current project. Verify them from
a source checkout with:

```bash
npm run validate:openspec
```

SpecOps does not install obsolete schemas or migrate old run formats.

## A run is blocked

`/specops-status` reports the current scheduler phase and the blocking gate. Common causes are:

- a required planning artifact failed validation;
- registered command evidence is missing, stale, timed out, or failed;
- an independent judgment or selected specialist review is incomplete;
- a sustained review finding still requires repair;
- a configured repair or dispatch budget is exhausted.
- a worker raised a question requiring user input (resumable).

### Pending question (resumable)

When `pauseReason` is `pending-question`, the run is paused with a pending question from a worker.
The persisted state is `status: "paused"`, `resumable: true`. Resume interactively:

```bash
opencode run --command specops --dir /path/to/project "resume"
```

The controller loads the paused state and immediately presents the pending question without
rerunning the original worker.

### Budget exhaustion, policy rejection, validation failure (non-resumable)

When `blockReason` is `budget-exhausted`, `policy-rejected`, or `validation-failed`, the run is
terminal. Do not edit machine state to bypass the gate. Correct the underlying artifact, command
registration, implementation, or configuration and start a fresh run.

### CLI pending-question output

When automatic/CLI execution encounters a pending question, the process returns a stable
machine-readable result:

```json
{
    "version": 1,
    "change": "<change>",
    "status": "paused",
    "reason": "pending-question",
    "resumable": true,
    "question": {
        "id": "<uuid>",
        "prompt": "Which boundary?",
        "options": [
            { "id": "session", "label": "Existing session model" },
            { "id": "token", "label": "Token-based model" }
        ],
        "allowOther": true,
        "impact": "requirements",
        "bindingHash": "<sha256>"
    }
}
```

This is a stable DTO for CI inspection. The exit code is non-zero for a paused outcome.

Do not edit machine state or completion receipts to bypass a gate. Correct the underlying
artifact, command registration, implementation, or configuration and resume through the
scheduler. Dependency provenance determines which downstream evidence must be invalidated.

## A verification command is rejected

Command evidence is not a shell script. Register an executable plus an argument array. The
executable may be any legitimate project tool; it is not restricted to a hardcoded allowlist.
The controller still enforces:

- direct, no-shell process execution;
- a working directory confined to the project;
- explicit timeout and bounded output;
- controlled environment additions and removals;
- no unreviewed inheritance of dangerous environment variables.

If a command needs shell expansion, pipelines, redirection, or command substitution, replace it
with a project script that implements the operation and register that script as the executable.

## CLI automatic execution

Use OpenCode's supported non-interactive command:

```bash
opencode run --command specops-auto --dir /path/to/project "workflow goal"
```

This resolves the same automatic controller as `/specops-auto` without opening the TUI. Run
`opencode run --help` if doctor reports that `--command`, `--dir`, or `--format` is unavailable.

For CI, add `--format json` and inspect the final persisted outcome. Exit `0` only proves the
OpenCode command session completed; success additionally requires outcome category `completed`.
If results differ from the visible command, compare project configuration, goal, repository
revision, provider manifest, and registered evidence commands.

## Collecting a useful diagnostic report

Include the following when reporting an issue:

- SpecOps package version and OpenCode version;
- `/specops-doctor` output;
- the manifest path and agent count, with provider secrets removed;
- `opencode debug config`;
- `opencode debug agent` output for the relevant controller;
- the project configuration with secrets removed;
- the failing scheduler phase and evidence status from `/specops-status`.

Never include API keys, tokens, full environment dumps, or unredacted command output containing
credentials.

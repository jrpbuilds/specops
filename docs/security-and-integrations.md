# Security, evidence, and integrations

## Least authority

Controllers cannot edit files or execute shell commands. Planning, design, consultation, judgment,
review, and refutation agents are read-only and cannot recursively dispatch tasks. Verification can
execute registered commands but cannot edit. Only implementer and repairer can mutate repository
code.

User model manifests cannot raise this authority. Runtime mode, tools, prompt, and permissions are
reapplied from the canonical registry on every plugin load.

## Untrusted content

Sensitive-looking values in generated reports, diagnostics, and command summaries are masked before
they are saved. This includes common tokens, passwords, credentials, bearer values, and private
keys, while verification records retain enough information to explain what was checked.

Repository files, diffs, OpenSpec artifacts, command output, and prior worker responses are treated
as untrusted data. Prompts require observed facts to be separated from inference and prohibit
fabricated paths, APIs, commands, or evidence.

Typed escalation markers are parsed as explicit control data. Ordinary prose cannot change run
requirements.

## Command evidence

Validation commands use executable/argument arrays and never pass through a shell. Working
directories are resolved beneath the project root. The environment contains only explicit
execution controls such as `PATH`, `CI`, and telemetry/color flags. Output is bounded while hashes
and timestamps are retained in `specops-evidence.json`. The controller automatically executes
required commands after implementation binding and before verification; a worker does not need to
remember to invoke the public validation tool for mandatory evidence.

Finalization requires successful matching evidence for every command validation registered in the
run.

## Diff and context bounds

Implementation diffs exclude controller-owned `openspec/` files and have a configured byte limit.
Context requests accept only known artifact names and stop at the configured context bound.

## Review independence

Dispatch provenance records `consultation`, `independent-review`, `judgment`, `repair`, or
`workflow`. The scheduler checks both capability and purpose. A specialist who influenced planning
must be dispatched again independently to satisfy post-implementation review.

Completed assurance is additionally bound to the current implementation diff, requirements policy,
answers, frontier advice, contract version, and relevant artifact hashes. Registered command
evidence carries the current diff and policy hashes, so evidence collected before a repair cannot
satisfy finalization afterward.

Writer dispatches capture the baseline Git commit and the complete immutable portion of the
controller-owned change tree. Completion is policy-blocked if an implementer or repairer changes
`HEAD`, alters an existing protected OpenSpec file, or adds a file or symbolic link under that
tree. The mutable run, progress, and command-evidence records are excluded because controller tools
legitimately update them while a writer is active. SpecOps records violations and leaves the
worktree untouched for diagnosis rather than attempting an automatic revert.

If the implementation diff changes between workflow phases, SpecOps invalidates the implementation
and all downstream assurance before issuing more work. A repair that reports completion without
changing the implementation diff terminates as `validation-failed`.

## External integrations

The non-interactive adapter is OpenCode's own `run --command` process, so it uses the same provider
credentials and model manifest as the visible command. Authentication, networking, rate limits,
and provider availability remain external boundaries. SpecOps does not retry beyond configured
transient budgets or translate those failures into successful workflow outcomes.

OpenSpec ships as a package dependency and is invoked directly with telemetry and color disabled.
MCP server tools are allowed for SpecOps subagents by default. Setting `integrations.mcp` to
`disabled` denies the configured server-prefixed MCP tool patterns for SpecOps subagents;
the `allow` policy applies agent-level permission rules that intentionally override host-level
MCP denials for those workers. Server definitions, credentials, OAuth, and connection
lifecycle remain owned by OpenCode configuration and are never duplicated by SpecOps.
Provider/model choices belong to the user manifest, while deterministic state
and safety authority remain provider-independent.

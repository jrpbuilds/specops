# Security, permissions, and integrations

## Least privilege

Planning, judging, and reviewing agents deny shell, edit, and nested-task
permissions. Verification can run commands but cannot edit. Only implementation
and remediation agents can edit and run commands, and nested delegation remains
denied.

The orchestrator uses process argument arrays with `shell: false`; goals and
change content are never interpolated into a shell command. Artifact paths are
validated against traversal, absolute paths, and unexpected spec layouts.

Repository text, diffs, OpenSpec content, tool output, and agent critiques are
tagged as untrusted data in cross-agent prompts. This reduces, but cannot
eliminate, prompt-injection risk. Review generated changes before committing.

## Git and destructive operations

SpecOps never automatically:

- commits or pushes;
- stashes or resets;
- changes branches;
- deletes user work;
- opens a pull request; or
- bypasses OpenSpec validation.

Automatic mode requires a clean worktree and an existing commit. Archive is
allowed because it is the explicitly requested final phase of
`/specops-auto`; interactive mode asks before archive.

OpenCode's `opencode run --dangerously-skip-permissions` flag can auto-approve
operations that are not explicitly denied. It is a last-resort, explicit user
choice and SpecOps never enables it. The manifest's explicit denials still
define the intended boundary.

## MCP

`integrations.mcp` defaults to `inherit`. Existing MCP tools configured by the
user remain available to the primary orchestrator and its child sessions as
optional context sources. This includes Git or repository MCP tooling when the
user has configured it. SpecOps:

- installs no MCP server;
- requires no MCP server;
- does not fail readiness when none exists;
- tells agents not to perform external writes without explicit authorization;
- prefers repository and OpenSpec evidence; and
- preserves top-level `mcp` configuration during synchronization.

Set the policy to `disabled` to instruct all SpecOps child sessions not to
invoke MCP tools. Because OpenCode owns tool discovery, this is an orchestration
policy rather than removal of the user's MCP configuration.

In interactive mode, the primary orchestrator may perform an MCP write, commit,
push, branch operation, or other Git mutation when the user explicitly
instructs or approves that exact action and OpenCode permissions allow it.
Automatic mode deliberately withholds that inferred authority: merely asking
SpecOps to complete a goal does not authorize publishing or mutating external
systems.

## Secrets and external data

Do not put secrets in OpenSpec artifacts, goals, diffs, or prompts. They may be
sent to configured model providers and committed to the repository. MCP output
that contains sensitive external data should be summarized minimally and only
when authorized.

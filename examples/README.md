# Example project configuration

SpecOps 1.0 stores project configuration at `.opencode/specops.json` and global
configuration at `~/.config/opencode/specops.json` (or `$XDG_CONFIG_HOME/opencode/
specops.json` when XDG is configured). On first plugin load, `/specops-onboard`
writes a complete editable project file; existing files are preserved.

The `specops.json` in this directory is an illustrative project configuration
covering the four V1 sections: `models`, `openspec`, `validation`, and
`integrations`. Copy it into a clean project to start from a known shape:

```bash
mkdir -p .opencode
cp examples/specops.json .opencode/specops.json
```

Values are resolved in this order:

1. Built-in defaults.
2. Global user configuration at `~/.config/opencode/specops.json`.
3. Project `.opencode/specops.json`.

Plain objects merge recursively. Arrays, primitives, and explicit `null`
replace earlier values. Run `/specops-doctor` to see project overrides that
shadow global values.

The project configuration selects the model for each of the seven SpecOps
agents, the OpenSpec command used for validation and archival, the
shell-free validation commands, and the MCP integration policy. It does not
define the agent catalogue; the canonical seven-agent manifest is materialised
separately in OpenCode's configuration directory.

Verification commands accept an arbitrary executable and an argument array.
They run directly without a shell and remain subject to confined working
directories, timeouts, controlled environment changes, and output limits.
Evidence is bound to the complete canonical command definition, so changing
an executable, argument, working directory, or limit invalidates stale
evidence.

The interactive V1 commands are `/specops`, `/specops-status`, `/specops-doctor`,
`/specops-onboard`, and `/specops-cancel`. There is no non-interactive
`/specops-auto` command in V1; the coordinator agent drives the workflow through
the six registered tools.

See [Configuration](../docs/configuration.md) for field semantics and
[Security and integrations](../docs/security-and-integrations.md) for the
execution boundary.

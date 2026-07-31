# Example project configuration

Copy both files into a clean project's `.opencode/` directory:

```bash
mkdir -p .opencode
cp examples/specops.json .opencode/specops.json
cp examples/specops.schema.json .opencode/specops.schema.json
```

`specops.json` demonstrates the final configuration shape. The adjacent JSON Schema documents
every supported field and rejects unknown properties. The JSON Schema validates the complete
merged configuration shape; partial global or project files will show editor warnings for
missing required sections — this is expected and such files are still valid at runtime via the
partial validator.

Create `~/.config/opencode/specops.json` (or `$XDG_CONFIG_HOME/opencode/specops.json`) for
user-wide defaults that apply to every project:

```bash
mkdir -p ~/.config/opencode
cp examples/specops.global.json ~/.config/opencode/specops.json
```

`specops.global.json` is intentionally partial: only the sections you set are merged.
Values are resolved in this order:

1. Built-in defaults (`DEFAULT_CONFIG`).
2. Global user configuration at `~/.config/opencode/specops.json`.
3. Project `.opencode/specops.json`.

Plain objects merge recursively. Arrays, primitives, and explicit `null` replace earlier
values. Use `/specops-doctor` to see project overrides that shadow global values.

The project configuration controls workflow policy, budgets, evidence commands, environment
handling, and review thresholds. It does not define agents. The exact canonical agent catalogue
is materialised separately in OpenCode's configuration directory from the packaged capability
registry.

Verification commands accept an arbitrary executable and argument array. They run directly
without a shell and remain subject to confined working directories, timeouts, controlled
environment changes, and output limits.

The same file configures visible and non-interactive automatic runs. For CI:

```bash
opencode run --command specops-auto --dir "$PWD" --format json "workflow goal"
```

Set `workflow.defaultTier` in `specops.json` when automation requires a minimum tier.

See [Configuration](../docs/configuration.md) for field semantics and
[Security and integrations](../docs/security-and-integrations.md) for the execution boundary.

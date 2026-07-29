# Example project configuration

Copy both files into a clean project's `.opencode/` directory:

```bash
mkdir -p .opencode
cp examples/specops.json .opencode/specops.json
cp examples/specops.schema.json .opencode/specops.schema.json
```

`specops.json` demonstrates the final configuration shape. The adjacent JSON Schema documents
every supported field and rejects unknown properties.

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

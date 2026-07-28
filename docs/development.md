# Development

## Validation

Run the complete local gate:

```bash
npm run check
```

It verifies:

1. manifest and generated OpenCode configuration are synchronized;
2. TypeScript passes strict checking;
3. orchestrator and receipt unit tests pass;
4. Python synchronization tests pass; and
5. the custom OpenSpec schema validates.

To verify OpenCode discovery:

```bash
opencode debug config
```

The `plugin_origins` result should contain only
`.opencode/plugins/sdd-orchestrator.ts`. Runtime helpers belong in
`.opencode/lib/`, because every source file directly inside the plugin directory
is treated as a plugin entrypoint.

## Changing an agent

1. Edit `.opencode/sdd-manifest.json`.
2. Edit the existing prompt when its engineering contract changes.
3. Run `npm run sync`.
4. Run `npm run check`.
5. Inspect `opencode.json` and commit manifest, prompt, and generated changes.

The Python tests cover both short and object manifest formats, configuration
preservation, prompt preservation, and unsafe IDs.

The TypeScript tests cover strict pass markers, blocking severity parsing,
slugging, configuration merging, artifact hashing, receipt freshness, Judgment
Day remediation, and complete review-panel synthesis.

## Compatibility

The plugin pins the SDK version used for its type contract and loads through
OpenCode's project plugin mechanism. When upgrading OpenCode or the SDK, run the
full gate and `opencode debug config`, then smoke-test `/specops-doctor` before
changing the pin.


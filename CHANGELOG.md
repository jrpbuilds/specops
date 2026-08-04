# Changelog

## [Unreleased]

### Changed

- Reorganized the workflow engine internals into focused modules (startup, directive issuance, completion, finalization, archive, interactive, questions, run state, artifacts, writer guards) behind the same public API. No change to run behavior or tooling.

### Fixed

- Release validation now reliably reflects configured MCP permissions: the OpenCode integration smoke test uses an enabled example server so the expected `example_*` allow rule is present, matching the documented behavior.

## [0.16.2] - 2026-08-03

### Changed

- Archival is now part of finalization, governed by `openspec.autoArchive` (default `true`).
  `specops_finalize` transitions a passed run to `completed` and, when auto-archive is enabled,
  runs `openspec archive` as part of that transition: the change directory moves to
  `openspec/changes/archive/<date>-<change>/`, spec deltas merge into `openspec/specs/` for
  standard and full tiers, and the `completed` state (carrying `archivedAt`) moves with the
  archived directory. When auto-archive is disabled, the run transitions straight to `completed`
  and the change stays in `openspec/changes/<change>/`; `/specops-archive` is a maintenance entry
  point that archives such a run without rerunning verification.
- Crash recovery is identity-based, not filename-based. SpecOps records run identity in a recovery
  sidecar before archiving, and a crash between the directory move and the final `completed` write
  is recovered on the next call only when the sidecar and the moved `specops-run.json` prove the
  same identity. Missing, malformed, or mismatched sidecars raise a controlled diagnostic instead
  of guessing from the archive directory name. Run locks moved outside the change directory and
  in-flight transactions are recovered before the directory move.
- Removed the unsafe sidecar-less terminal filename fallback: `RunState` has no persisted original
  change identifier, so sidecar-less candidate matching could recover a foreign same-suffix
  archive. Archive failures are reported as `archive_failed` with a structured `archiveError`
  (`kind`, `attempt`, `message`) and are retryable via `specops_finalize` or the maintenance
  command without rerunning implementation or verification.

### Fixed

- Structured planning and Lean assurance checkpoint previews are now rendered as readable Markdown
  instead of exposing their JSON transport envelopes to the user.
- Interactive checkpoint controllers now preserve transition commentary, JSON examples, and internal
  code fences while avoiding an outer wrapper that causes the entire preview to render as raw Markdown.

## [0.16.1] - 2026-08-02

### Changed

- Renamed the MCP integration policy from `inherit` to `allow`. The `allow`
  policy grants SpecOps subagents access to every enabled MCP server already
  configured in OpenCode by applying agent-level `<server>_*` permission rules.
  Because the permission is applied at the agent level, `allow` intentionally
  overrides host-level MCP permission or `tools` denials for those subagents;
  set `integrations.mcp` to `disabled` when SpecOps workers must not use MCP
  tools. MCP server definitions, credentials, OAuth, and connection lifecycle
  remain owned by OpenCode configuration.

### Fixed

- Verification checkpoints no longer show `Apply implementation fixes` when the current assurance
  result has no implementation findings, or only contains stale or planning/design findings.
- Clarified assessment confidence semantics across routing, persisted run state, frontier decisions,
  prompts, tests, and documentation. Low now consistently means low confidence/high uncertainty,
  while the assessor is explicitly told not to promote generic documentation drift into a material
  maintainability facet, preventing simple changes from being routed through unnecessary Full and
  specialist workflows.
- Required command validations are now executed by a controller-owned pre-verification barrier
  after the implementation diff is bound. Results are persisted atomically with current diff and
  policy hashes, so normal workflows no longer depend on a verifier remembering to call
  `specops_run_validation`; stale evidence is rerun and failed commands terminate safely.
- Configuration files with an invalid schema no longer prevent the plugin from
  loading. The loader now salvages every top-level section that still parses,
  rewrites the offending file in place with the salvaged settings deep-merged
  onto defaults (preserving the `$schema` header), and records a repair for
  `doctor` to surface as a `WARN` diagnostic. A single bad field, unknown key,
  or malformed JSON now falls back to defaults instead of crashing the plugin,
  mirroring the existing repair-on-load behaviour of the agent manifest.

- Exposed configured OpenCode MCP server tools to SpecOps subagents using server-prefixed permission rules. Previously workers fell back to OpenCode's implicit `ask` prompt, which subagents cannot satisfy, effectively blocking all MCP tool access including `codegraph_explore`.
- Aligned generated OpenSpec change names with the 200-character kebab-case contract.
- Added regression coverage for packed installation, MCP policy, and change-name boundaries.

## [0.16.0] - 2026-08-01

### Highlights

- Added an explicit archive phase for completed OpenSpec changes.
- Added native confirmation before archiving passed changes.
- Added retry-safe archive failure handling, archive locking, incomplete-task checks, and
  Standard/Full specification merging.
- Added a controller-owned question ledger with multi-question transactions, resumable answers,
  and persisted provenance.
- Removed artificial question-count limits.
- Materialized a complete global configuration on first install without overwriting existing user
  configuration.
- Added configurable MCP access policy for SpecOps subagents.
- Hardened workflow recovery, transaction persistence, lock handling, and failure recovery.
- Added packed-install coverage for the archive lifecycle and public protocol tools.

### Compatibility

- Node.js `24.18.1` or newer is now required.
- OpenCode `1.18.10` or newer is now required.
- OpenSpec updated to `1.7.0`.
- This release drops support for older Node.js and OpenCode versions.

### Documentation And Tooling

- Reworked README, site, getting-started, development, configuration, workflow, and troubleshooting
  documentation.
- Updated compatibility badges and installation requirements.
- Added compatibility drift validation for package metadata, lockfiles, CI, and maintained
  documentation.
- CI and release workflows now use the repository-pinned Node.js version from `.nvmrc`.

[0.16.2]: https://github.com/jrpbuilds/specops/compare/v0.16.1...v0.16.2
[0.16.1]: https://github.com/jrpbuilds/specops/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/jrpbuilds/specops/compare/v0.15.1...v0.16.0

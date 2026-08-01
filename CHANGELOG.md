# Changelog

## [0.16.1] - 2026-08-01

### Fixed

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

[0.16.1]: https://github.com/jrpbuilds/specops/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/jrpbuilds/specops/compare/v0.15.1...v0.16.0

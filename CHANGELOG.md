# Changelog

## 1.0.0 — unreleased

- Replaced the legacy scheduler and custom schemas with one interactive, OpenSpec-first `spec-driven` workflow.
- Registered seven agents, five public commands, and six workflow tools.
- Added atomic V1 state, identity-bound validation/review, bounded repair, explicit archive approval, diagnostics, and one-time migration.
- Removed automatic mode, workflow tiers, dispatch protocol, tribunals, `/specops-auto`, and `/specops-archive`.

Upgrade: run `/specops-doctor`. Old runs cannot resume. Legacy schemas are not deleted. Recognised V2 manifests and configuration migrate once; removed settings are reported.

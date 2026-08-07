# Troubleshooting

Run `/specops-doctor` first. It reports incompatible Node `>=24.18.1`, OpenCode `>=1.18.10`, OpenSpec, missing `spec-driven`, unwritable paths, invalid configuration, prompts, manifest problems, legacy schemas, and legacy run state.

OpenSpec must be `>=1.7.0 <1.8.0`. Custom schemas are unsupported but not deleted. If a validation or review identity is stale, resume `/specops` to run the required corrective stage. A failed archive is retryable through `/specops` only when the repository identity remains unchanged.

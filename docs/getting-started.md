# Getting started

Install the plugin with Node `>=24.18.1` and OpenCode `>=1.18.10`, open a repository with OpenSpec `>=1.7.0 <1.8.0`, then run `/specops-onboard`. It verifies upstream `openspec/config.yaml` uses `spec-driven`; it never copies a custom SpecOps schema.

Run `/specops <goal>`. Approve the validated plan at the planning checkpoint and approve archive at the completion checkpoint. Run `/specops-doctor` after upgrading: V2 manifests and recognised V2 configuration migrate once, old run state cannot resume, and legacy schemas are only reported.

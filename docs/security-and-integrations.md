# Security and integrations

OpenSpec and validation commands run shell-free. Paths and change names are validated, managed writes are atomic, and artifact ownership is enforced through agent permissions. Dirty repository work is preserved.

Only the coordinator delegates or asks questions. The implementer may edit source; reviewers and frontier are read-only. Validation evidence and review are tied to repository identity, preventing stale completion. MCP access is an explicit V1 configuration toggle.

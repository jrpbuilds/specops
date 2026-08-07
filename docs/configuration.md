# Configuration and migration

V1 configuration contains only seven-role model mappings, an optional OpenSpec command override, required shell-free validation commands with timeout/output bounds, and the MCP integration toggle. Retry, correction, repair, and frontier limits are internal constants.

Recognised V2 configuration migrates once and atomically. Supported OpenSpec-command and MCP values are retained; obsolete workflow, routing, automation, escalation, frontier, review, and auto-archive fields are removed and reported. Unsupported unrelated shapes are not rewritten. `/specops-doctor` reports migration results and strict validation errors.

# Agents

V1 registers exactly seven roles: coordinator, explorer, planner, designer, implementer, reviewer, and frontier. The coordinator alone delegates and asks questions. The implementer alone edits source; planner/designers edit only their owned OpenSpec artifacts; explorer/reviewer write only their reports; frontier is read-only.

Prompts are packaged Markdown files. A V2 24-agent manifest migrates once to V3, preserving unambiguous model choices and reporting ambiguous mappings. Permissions and old workflow policy never migrate.

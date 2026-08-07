# Artifacts and state

OpenSpec owns `openspec/changes/<change>/` and its standard proposal, specs, design, and tasks. SpecOps owns only `.specops/runs/<change>/exploration.md`, `review.md`, `run.json`, and validation evidence.

`run.json` is coarse V1 state: status, stage, identities, correction and repair counters, and failure/archive facts. It contains no dispatches, capability graphs, provenance, or scheduler directives. Old run formats are detected and cannot resume automatically.

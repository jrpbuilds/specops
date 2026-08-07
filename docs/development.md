# Development

Develop with Node `>=24.18.1`, OpenCode `>=1.18.10`, and OpenSpec `>=1.7.0 <1.8.0`. Run `npm run check` for format, typecheck, dead-code analysis, tests, packed install, OpenSpec compatibility, and documentation checks. Run `npm run test:openspec:compat` to validate the tracked standard OpenSpec change strictly.

V1 tests cover state, planning, implementation, review, completion, protocol, status, doctor, migration, and packed installation. Do not add scheduler or dispatch compatibility layers; use the V1 workflow modules and standard OpenSpec adapter.

For release smoke validation, run representative interactive changes with two materially different configured model families. Record instruction/tool-call failures, invalid artifact corrections, review/repair outcomes, and user friction in release notes; improve prompts rather than adding model-specific orchestration.

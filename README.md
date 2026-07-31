<div align="center">

![SpecOps](https://raw.githubusercontent.com/jrpbuilds/specops/master/docs/specops-logo.webp)

# SpecOps

**Spec-driven software changes for OpenCode — the TypeScript owns the workflow, the model owns the reasoning.**

[![npm version](https://img.shields.io/npm/v/@jrpbuilds/specops?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@jrpbuilds/specops)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 20.19](https://img.shields.io/badge/node-%E2%89%A520.19-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![OpenCode ≥ 1.16.2](https://img.shields.io/badge/opencode-%E2%89%A51.16.2-000?logo=opencode&logoColor=white)](https://opencode.ai)
[![OpenSpec 1.6](https://img.shields.io/badge/openspec-1.6-6f42c1)](https://github.com/fission-ai/openspec)
[![release workflow](https://img.shields.io/badge/release-npm%20run%20check%20on%20tag-2ea44f?logo=githubactions&logoColor=white)](.github/workflows/release.yml)

</div>

SpecOps is an [OpenCode](https://opencode.ai) plugin that turns a one-line goal into a fully audited code change. You write `/specops add a /healthz endpoint with tests` and the plugin handles the rest: it reads your repo, decides how big the change is, plans it through validated [OpenSpec](https://github.com/fission-ai/openspec) artifacts, writes the code, runs the tests, sends it through independent reviewers, repairs what fails, and only then marks the work complete. The model writes code. The plugin — written in strict TypeScript — decides when the code is actually done, with a completion receipt backed by fresh evidence and verified artifacts.

If you've used an AI coding agent before, you've probably noticed it does the easy part well (one file, one function) and the hard part badly (multi-file changes, contracts, breaking changes, anything where "the LLM just did it" isn't enough). SpecOps exists for the hard part. Every decision — scope, risk, what to build, whether the change is complete — is enforced by code, not by the model agreeing with itself.

## Install

Requires [OpenCode](https://opencode.ai) 1.16.2 or newer and [Node.js](https://nodejs.org) 20.19 or newer.

```bash
opencode plugin @jrpbuilds/specops -g
```

That's the whole install. On first load SpecOps writes its agent manifest to `$XDG_CONFIG_HOME/opencode/specops-manifest.json` (or `~/.config/opencode/specops-manifest.json` if `XDG_CONFIG_HOME` is unset) — no manual config-file shuffling. Then open OpenCode's command palette and pick `SpecOps: Configure agent models` to map your configured providers to the 24 controller and worker roles. Out of the box everything inherits OpenCode's global default model, so the plugin works immediately; you'll get better results by assigning stronger coding models to the implementer, repairer, and frontier routes.

## First Run

For each repo you want to use SpecOps in, run the onboard once:

```text
/specops-onboard
```

That installs the final OpenSpec schemas into the current repository. From there, ship a change the same way you'd describe it to a senior engineer:

```text
/specops add a /healthz endpoint with tests
```

A small change completes in four subagent calls — assessment, compact plan, implementation, bundled verification and assurance. No ceremony, all gates. Bigger changes route to a heavier workflow that adds planning, design, specialist reviews, and bounded repair cycles; the plugin picks the smallest safe route from the actual repository evidence, not from vibes.

If you'd rather not open the TUI, the same workflow runs non-interactively through OpenCode's CLI adapter:

```bash
opencode run --command specops-auto --dir /path/to/project \
  "apply the scheduled maintenance change"
```

Add `--format json` for raw NDJSON events you can pipe into CI. Process exit `0` means the command session completed; CI must additionally require persisted outcome category `completed` to know every workflow gate actually passed.

## Commands

```
/specops         interactive controller with checkpoints and native worker-question handling
/specops-auto    automatic controller using visible native workers; pauses for material choices
/specops-status  read an existing run
/specops-doctor  validate installation, manifest, commands, agents, prompts, and schemas
/specops-onboard install final OpenSpec schemas into the current repository
```

Each command's exact runtime target is in [docs/commands.md](docs/commands.md).

## Docs

The full product tour — scope tiers, workflow stages, agent catalogue, configuration, security model, troubleshooting — lives on the [SpecOps site](https://jrpbuilds.github.io/specops/). The on-disk reference is here:

- [Getting started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Workflows and scope tiers](docs/workflows.md)
- [Agent catalogue](docs/agents.md)
- [Commands](docs/commands.md)
- [Configuration](docs/configuration.md)
- [Artifacts and persisted state](docs/artifacts-and-state.md)
- [Security, evidence, and integrations](docs/security-and-integrations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development and testing](docs/development.md)

## Contributing

```bash
npm install
npm run generate
npm run format
npm run check
npm run smoke:opencode
```

`npm run check` runs formatting, strict TypeScript and unused-symbol checks, unit and integration tests, packed-output materialisation tests, generated-asset drift checks, and OpenSpec schema validation. `npm run smoke:opencode` additionally loads the packed plugin through a real isolated OpenCode installation and runs the documented CLI command until the first scheduler action or an external provider boundary. The release workflow runs `npm run check` on every version tag before publishing to npm and opening the GitHub release — there is no per-PR CI gate, so run `npm run check` locally before pushing. Full validation matrix in [docs/development.md](docs/development.md).

If a command reports a missing controller, run `/specops-doctor`, inspect the manifest path it reports, rebuild and reinstall the package, restart OpenCode, and reach for `opencode debug config` or `opencode debug agent <controller-id>` as needed.

## License

MIT. Built by [@jrpbuilds](https://github.com/jrpbuilds).

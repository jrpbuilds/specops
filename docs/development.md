# Development and release verification

SpecOps is developed as a clean-slate OpenCode plugin. A change is complete only when the source
tree, generated runtime surfaces, packed package, schemas, and documentation agree on
the same architecture.

## Prerequisites

- Node.js 20.19 or newer
- npm
- OpenCode for the optional real-host smoke test

Install the pinned development dependencies:

```bash
npm install
```

## Generated surfaces

The capability registry is the source of truth for agent identity, mode, role, authority, and
default model. Generate the manifest-derived documentation after an intentional registry or
command change:

```bash
npm run generate
```

This command builds the TypeScript, regenerates `src/workflow/contracts.generated.ts`
and `docs/agents.md` and `docs/commands.md`, and formats the repository. Do not
hand-edit those generated files.

`npm run generated:check` verifies:

- the registry, canonical ID collection, default manifest, and prompts contain the same exact
  agent set;
- each scheduler capability resolves to a registered agent;
- every public command targets a registered controller or protocol tool;
- the generated artifact wire-format contracts match the canonical constants and templates;
- generated documentation is current.

## Formatting and static analysis

Use the write-mode formatter before validation:

```bash
npm run format
npm run format:check
npm run typecheck
```

The production and test TypeScript configurations enable strict checking, unused-local checks,
unused-parameter checks, and consistent filename casing. Public APIs and non-obvious safety
invariants should have JSDoc or focused comments; comments should explain ownership or constraints
rather than restate syntax.

## Focused tests

Run a focused loop while editing:

```bash
npm test
npm run validate:openspec
```

Vitest covers scheduler behavior, command/controller consistency, manifest replacement, plugin
hook registration, permission boundaries, prompts, protocol tools, and the checked-in example
configuration. OpenSpec validates all three final schemas.

## Packed-package integration

The packed test is the release-critical integration boundary:

```bash
npm run test:packed
```

It creates a real npm archive, extracts it into a temporary clean installation, supplies the
OpenCode peer dependency as a host would, and loads only the packed `dist` entry point. The test
then:

- starts with a partial manifest and confirms exact atomic materialisation;
- invokes the real plugin configuration hook;
- resolves every canonical agent and public command;
- confirms controller and worker modes, prompts, tools, and authority;
- invokes the packed doctor tool;
- onboards a fresh Git project, starts a final-format run, requests the first scheduler action,
  and reads it through the status tool;
- rejects source-only TypeScript and checkout-path leakage.

The test does not copy source files into the package and does not read or modify the developer's
real OpenCode configuration.

## Real OpenCode smoke test

When the `opencode` binary is available, run:

```bash
npm run smoke:opencode
```

This repeats the packed test, loads the packed file URL through a real isolated OpenCode
configuration, checks `opencode run --help`, and invokes:

```bash
opencode run --command specops-auto --dir <isolated-project> --format json \
  "Confirm packed CLI automatic execution"
```

The harness observes the first scheduler action and sends `SIGINT`, or reports the exact external
provider boundary when authentication or networking prevents that point. It also uses
`opencode debug config` and `opencode debug agent` to prove both controllers resolve.

## Release publishing

Publishing is automated through the GitHub Actions release workflow. A version tag
matching `v[0-9]+.[0-9]+.[0-9]+` triggers a single job that:

- installs dependencies with `npm ci`;
- runs the full validation matrix (`npm run check`);
- publishes to the npm registry using `npm publish --provenance --access public`;
- creates a GitHub release with generated release notes.

npm publishing uses OIDC Trusted Publishing: the workflow declares
`id-token: write` permission and npm provenance, so no long-lived `NPM_TOKEN`
secret is required. The GitHub release step requires `contents: write`. Pushing
a stable version tag is the only publish action; there is no manual publish path
and no `curl | bash` installer distribution.

## Full validation

Run:

```bash
npm run check
npm pack --dry-run
```

`npm run check` executes formatting, generated-surface drift checks, strict TypeScript, Vitest,
packed-package integration, OpenSpec validation, and documentation link checks.
`npm pack --dry-run` is a final review of the publishable file list.

Before release, also inspect:

```bash
git status --short
git diff --check
```

Then run repository-wide stale-reference searches for removed agent IDs, obsolete run-state
versions, escalation types, static workflow plans, deprecated fields, superseded prompts, and
migration or compatibility code. A final package must contain only the canonical architecture.

## Test isolation

Tests use temporary `HOME`, `XDG_CONFIG_HOME`, and package directories. Keep this property when
adding coverage:

- never write to the developer's real OpenCode configuration;
- never rely on an already installed global plugin;
- never use a source checkout to make a packed test pass;
- never contact a model provider from the default validation suite;
- bound spawned processes, captured output, and temporary artifacts.

## Adding a focused command

The current public command set is not an immutable product list. A future focused command is valid
only if it enters through a registered controller or protocol tool and then uses the deterministic
scheduler. It must not dispatch a worker directly, mutate run state itself, or bypass artifact,
evidence, independence, repair-budget, or completion gates.

## Code review checklist

- Agent spellings come from `src/capabilities/ids.ts`.
- Tool spellings come from `src/protocol.ts`.
- Agent roles and authority come from the capability registry.
- Planner and designer output is validated before controller-owned atomic persistence.
- Only implementer and repairer capabilities mutate repository code.
- Consultation and independent review provenance remain distinct.
- The general risk reviewer detects cross-cutting facets but does not replace specialists.
- Visible and non-interactive automatic adapters resolve the same command and scheduler.
- New tests prove the packed behavior, not only source-level behavior.

---
name: Bug report
about: Report a reproducible problem with SpecOps or its OpenCode integration
title: "[Bug]: "
labels: bug
assignees: ""
---

<!--
  Please remove secrets and private information before submitting. This includes API keys, access
  tokens, credentials, private source code, sensitive prompts or output, file paths, repository
  names, and personal data. Use the repository's private security reporting channel for potential
  vulnerabilities.
-->

## Summary

<!-- Briefly describe the problem and its impact. -->

## Impact

- **Frequency:** <!-- Every time, intermittent, or once -->
- **Scope:** <!-- One project/configuration, or multiple -->
- **Severity:** <!-- Blocks work, major inconvenience, or minor issue -->

## Steps to reproduce

<!-- Provide the smallest reliable reproduction. Replace sensitive values with [REDACTED]. -->

1.
2.
3.

### Relevant command or configuration

<!-- Include the command, sanitized configuration, spec, or workflow input involved. -->

```text

```

## Expected behavior

<!-- What did you expect to happen? -->

## Actual behavior

<!-- What happened instead? Include the complete error message if there is one. -->

## AI interaction details (if relevant)

<!--
  Include only the relevant, sanitized portion. Preserve the sequence of events, tool names, and
  error messages where possible. Replace sensitive content with [REDACTED].
-->

<details>
<summary>Prompt or input</summary>

```text

```

</details>

<details>
<summary>Model, tool, or plugin output</summary>

```text

```

</details>

## Logs (if available)

<!--
  Paste relevant logs below, including surrounding context or timestamps when useful. Remove
  secrets and unrelated private data. If logs are too large, attach a sanitized file or excerpt.
-->

```text

```

## Environment

<!-- Please provide exact versions where possible. -->

| Component             | Version or details                           |
| --------------------- | -------------------------------------------- |
| SpecOps               | <!-- package version or commit -->           |
| OpenCode              | <!-- output of `opencode --version` -->      |
| `@opencode-ai/plugin` | <!-- installed/resolved version -->          |
| Node.js               | <!-- output of `node --version` -->          |
| Host OS and version   | <!-- e.g. Ubuntu 24.04 or macOS 15.4 -->     |
| Architecture          | <!-- x64, arm64, etc. -->                    |
| Installation method   | <!-- npm, local checkout, packed install --> |

### Optional environment details

<!-- Include these when relevant: OpenSpec, package manager, shell/terminal, model, or provider. -->

## Regression and workarounds (optional)

- **Last known working version:**
- **Possible triggering change:**
- **Workaround:**

## Additional context (optional)

<!-- Add screenshots, recordings, related issues, or anything else that may help diagnosis. -->

## Checklist

- [ ] I searched existing issues and did not find a duplicate.
- [ ] I included steps that another person can follow to reproduce the issue.
- [ ] I removed secrets, credentials, private code, and sensitive user data from this report.

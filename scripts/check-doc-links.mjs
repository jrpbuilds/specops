import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const documentationFiles = [
    "README.md",
    "CHANGELOG.md",
    "docs/agents.md",
    "docs/architecture.md",
    "docs/artifacts-and-state.md",
    "docs/commands.md",
    "docs/configuration.md",
    "docs/development.md",
    "docs/getting-started.md",
    "docs/security-and-integrations.md",
    "docs/troubleshooting.md",
    "docs/workflows.md",
    "examples/README.md",
];

const failures = [];

for (const relativeFile of documentationFiles) {
    const sourcePath = path.join(repositoryRoot, relativeFile);
    const markdown = await readFile(sourcePath, "utf8");

    for (const target of localMarkdownTargets(markdown)) {
        const pathPart = decodeURIComponent(target.split("#", 1)[0]);
        if (!pathPart) {
            continue;
        }

        const resolved = path.resolve(path.dirname(sourcePath), pathPart);
        const relativeResolved = path.relative(repositoryRoot, resolved);
        if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) {
            failures.push(`${relativeFile}: link escapes repository: ${target}`);
            continue;
        }

        try {
            await access(resolved);
        } catch {
            failures.push(`${relativeFile}: missing link target: ${target}`);
        }
    }
}

if (failures.length > 0) {
    throw new Error(`Documentation link validation failed:\n${failures.join("\n")}`);
}

process.stdout.write(`Documentation links passed for ${documentationFiles.length} files.\n`);

/**
 * Extracts local inline-link destinations while ignoring images and external schemes.
 *
 * Reference-style links are intentionally not accepted in the maintained documentation set:
 * keeping the destination adjacent to its label makes drift checks deterministic and reviewable.
 */
function localMarkdownTargets(markdown) {
    const targets = [];
    const inlineLink = /(?<!!)\[[^\]]+\]\((?<target>[^)\s]+)(?:\s+"[^"]*")?\)/g;

    for (const match of markdown.matchAll(inlineLink)) {
        const target = match.groups?.target;
        if (
            !target ||
            target.startsWith("#") ||
            /^[a-z][a-z0-9+.-]*:/i.test(target) ||
            target.startsWith("//")
        ) {
            continue;
        }
        targets.push(target.replace(/^<|>$/g, ""));
    }

    return targets;
}

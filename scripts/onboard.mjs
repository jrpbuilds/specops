import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const entry = require.resolve("@fission-ai/openspec");
const binary = path.resolve(path.dirname(entry), "..", "bin", "openspec.js");

const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [binary, "init", "--tools", "opencode"], {
        cwd: repositoryRoot,
        env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", OPENSPEC_TELEMETRY: "0" },
        shell: false,
        stdio: "inherit",
    });
    child.on("error", error => resolve({ code: 1, error }));
    child.on("close", code => resolve({ code: code ?? 1 }));
});
if (result.code !== 0) throw result.error ?? new Error("OpenSpec initialization failed");

const config = await readFile(path.join(repositoryRoot, "openspec", "config.yaml"), "utf8");
if (!/^schema:\s*spec-driven\s*$/m.test(config)) {
    throw new Error("OpenSpec onboarding did not create a spec-driven project");
}

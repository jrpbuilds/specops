import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../src/security/redact.js";
import { changeRoot, withRunLock, writeMachine } from "../src/state/store.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, utimes } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("workflow reliability safeguards", () => {
    it("redacts common secrets while preserving surrounding diagnostics", () => {
        const output = redactSensitiveText(
            'failed: {"API_TOKEN":"super-secret"} Authorization: Bearer abc123 path=/src/main.ts',
        );
        expect(output).toContain("failed");
        expect(output).toContain("/src/main.ts");
        expect(output).not.toContain("super-secret");
        expect(output).not.toContain("abc123");
    });

    it("redacts quoted YAML and keeps the serialized shape valid", () => {
        const output = redactSensitiveText("token: \"super-secret\"\npassword: 'hidden'");
        expect(output).toContain('token: "[REDACTED]"');
        expect(output).toContain("password: '[REDACTED]'");
    });

    it("serializes concurrent mutations and removes the lock after completion", async () => {
        const directory = await fsTemp("specops-lock-");
        const change = "lock-test";
        await mkdir(changeRoot(directory, change), { recursive: true });
        const order: string[] = [];
        let signalFirstStarted!: () => void;
        const firstStarted = new Promise<void>(resolve => {
            signalFirstStarted = resolve;
        });
        const first = withRunLock(directory, change, "first", async () => {
            order.push("first-start");
            signalFirstStarted();
            await new Promise(resolve => setTimeout(resolve, 10));
            order.push("first-end");
        });
        await firstStarted;
        await expect(
            withRunLock(directory, change, "second", async () => undefined),
        ).rejects.toThrow("SpecOps run is busy");
        await first;
        expect(order).toEqual(["first-start", "first-end"]);
        await expect(
            readFile(path.join(directory, "openspec", ".specops-run-locks", `${change}.lock`)),
        ).rejects.toThrow();
    });

    it("reclaims an old lock directory with missing owner metadata", async () => {
        const directory = await fsTemp("specops-stale-lock-");
        const change = "stale-lock-test";
        await mkdir(changeRoot(directory, change), { recursive: true });
        const lockPath = path.join(directory, "openspec", ".specops-run-locks", `${change}.lock`);
        await mkdir(lockPath, { recursive: true });
        const stale = new Date(Date.now() - 60_000);
        await utimes(lockPath, stale, stale);

        await expect(
            withRunLock(directory, change, "reclaim", async () => undefined),
        ).resolves.toBeUndefined();
    });

    it("does not recreate a missing active change while acquiring a run lock", async () => {
        const directory = await fsTemp("specops-missing-run-");
        const change = "missing-run-test";

        await expect(
            withRunLock(directory, change, "missing", async () => undefined),
        ).rejects.toThrow("SpecOps active run is missing");
        await expect(statSafe(changeRoot(directory, change))).resolves.toBe(false);
    });

    it("publishes staged machine writes when the controller reports an error", async () => {
        const directory = await fsTemp("specops-transaction-");
        const change = "transaction-test";
        await mkdir(changeRoot(directory, change), { recursive: true });

        await expect(
            withRunLock(directory, change, "transaction", async () => {
                await writeMachine(directory, change, "specops-context.json", { committed: true });
                throw new Error("worker output rejected");
            }),
        ).rejects.toThrow("worker output rejected");

        await expect(
            readFile(path.join(changeRoot(directory, change), "specops-context.json"), "utf8"),
        ).resolves.toContain('"committed": true');
    });

    it("rolls forward a prepared transaction left by an interrupted process", async () => {
        const directory = await fsTemp("specops-recovery-");
        const change = "transaction-recovery-test";
        const root = changeRoot(directory, change);
        const transaction = path.join(root, "specops-transaction", "prepared");
        const content = '{"recovered":true}\n';
        await mkdir(path.join(transaction, "files"), { recursive: true });
        await writeFile(path.join(transaction, "files", "specops-context.json"), content);
        await writeFile(
            path.join(transaction, "manifest.json"),
            JSON.stringify({
                version: 1,
                id: "prepared",
                status: "prepared",
                entries: [
                    {
                        destination: "specops-context.json",
                        staged: "files/specops-context.json",
                        hash: createHash("sha256").update(content).digest("hex"),
                    },
                ],
            }),
        );

        await withRunLock(directory, change, "recover transaction", async () => undefined);
        await expect(readFile(path.join(root, "specops-context.json"), "utf8")).resolves.toBe(
            content,
        );
    });
});

async function fsTemp(prefix: string): Promise<string> {
    return (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), prefix));
}

async function statSafe(target: string): Promise<boolean> {
    try {
        await stat(target);
        return true;
    } catch {
        return false;
    }
}

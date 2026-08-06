import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
    invalidateValidationEvidence,
    persistValidationEvidence,
    readValidationEvidence,
} from "../src/validation/evidence.js"
import { executeValidationCommand } from "../src/validation/executor.js"
import { createValidationRegistry, validateValidationCommands } from "../src/validation/registry.js"

const identity = "a".repeat(64)
const changedIdentity = "b".repeat(64)

async function directory(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "specops-validation-"))
}

describe("validation evidence", () => {
    it("keeps explorer recommendations separate until explicitly accepted", () => {
        const command = {
            id: "typecheck",
            executable: "node",
            args: ["--version"],
            timeoutMs: 1_000,
            maxOutputBytes: 1_024,
        }
        const registry = createValidationRegistry(
            [],
            [{ ...command, id: "test", source: "explorer" }],
        )
        expect(registry.required).toEqual([])
        expect(registry.recommendations).toHaveLength(1)
        expect(createValidationRegistry([command], [], []).required).toEqual([command])
        expect(() => validateValidationCommands([{ ...command, id: "not safe" }])).toThrow(
            "invalid validation command id",
        )
    })

    it("runs direct executables with bounded output and persists identity-bound evidence", async () => {
        const root = await directory()
        const evidence = await executeValidationCommand(
            root,
            {
                id: "bounded-output",
                executable: process.execPath,
                args: [
                    "-e",
                    "process.stdout.write('a'.repeat(32)); process.stderr.write('b'.repeat(32))",
                ],
                timeoutMs: 1_000,
                maxOutputBytes: 16,
            },
            identity,
        )
        expect(evidence.exitCode).toBe(0)
        expect(evidence.outputTruncated).toBe(true)
        expect(evidence.repositoryIdentity).toBe(identity)
        expect(evidence.outputHash).toHaveLength(64)

        await persistValidationEvidence(root, "validation-test", evidence)
        await expect(readValidationEvidence(root, "validation-test")).resolves.toEqual([evidence])
        const invalidated = await invalidateValidationEvidence(
            root,
            "validation-test",
            changedIdentity,
        )
        expect(invalidated[0]).toMatchObject({ invalidatedBy: changedIdentity })
    })

    it("records a timeout rather than treating it as a normal exit code", async () => {
        const evidence = await executeValidationCommand(
            await directory(),
            {
                id: "timeout",
                executable: process.execPath,
                args: ["-e", "setTimeout(() => {}, 1000)"],
                timeoutMs: 25,
                maxOutputBytes: 1_024,
            },
            identity,
        )
        expect(evidence.timedOut).toBe(true)
        expect(evidence.exitCode).toBeNull()
    })
})

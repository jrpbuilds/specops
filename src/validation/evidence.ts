import { readFile, readdir } from "node:fs/promises";
import type { RepositoryIdentity } from "../repository/identity.js";
import { writeFileAtomic } from "../state/atomic.js";
import { validationDirectory, validationEvidencePath } from "../state/paths.js";
import type { ValidationEvidence } from "./executor.js";

/** Atomically persist one command result in its managed validation directory. */
export async function persistValidationEvidence(
    directory: string,
    change: string,
    evidence: ValidationEvidence,
): Promise<void> {
    await writeFileAtomic(
        validationEvidencePath(directory, change, evidence.commandId),
        `${JSON.stringify(evidence, null, 2)}\n`,
    );
}

/** Read all persisted validation evidence in deterministic command-id order. */
export async function readValidationEvidence(
    directory: string,
    change: string,
): Promise<ValidationEvidence[]> {
    const files = await readdir(validationDirectory(directory, change)).catch(error => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    });
    return Promise.all(
        files
            .filter(file => file.endsWith(".json"))
            .sort()
            .map(async file => {
                const raw: unknown = JSON.parse(
                    await readFile(`${validationDirectory(directory, change)}/${file}`, "utf8"),
                );
                return assertValidationEvidence(raw);
            }),
    );
}

/** Mark evidence for another repository state stale while preserving diagnostics. */
export async function invalidateValidationEvidence(
    directory: string,
    change: string,
    currentIdentity: RepositoryIdentity,
): Promise<ValidationEvidence[]> {
    const evidence = await readValidationEvidence(directory, change);
    const invalidatedAt = new Date().toISOString();
    const updated = evidence.map(item =>
        item.repositoryIdentity === currentIdentity || item.invalidatedAt !== undefined
            ? item
            : { ...item, invalidatedAt, invalidatedBy: currentIdentity },
    );
    await Promise.all(
        updated
            .filter(
                item =>
                    item.invalidatedBy === currentIdentity && item.invalidatedAt === invalidatedAt,
            )
            .map(item => persistValidationEvidence(directory, change, item)),
    );
    return updated;
}

/** Return whether every evidence record remains fresh for the supplied identity. */
export function isValidationEvidenceCurrent(
    evidence: ValidationEvidence,
    currentIdentity: RepositoryIdentity,
): boolean {
    return evidence.repositoryIdentity === currentIdentity && evidence.invalidatedAt === undefined;
}

/** Validate persisted evidence before it can participate in workflow gates. */
function assertValidationEvidence(value: unknown): ValidationEvidence {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("invalid validation evidence");
    }
    const evidence = value as Partial<ValidationEvidence>;
    if (
        typeof evidence.commandId !== "string" ||
        typeof evidence.executable !== "string" ||
        !Array.isArray(evidence.args) ||
        typeof evidence.cwd !== "string" ||
        typeof evidence.repositoryIdentity !== "string" ||
        typeof evidence.outputHash !== "string"
    ) {
        throw new Error("invalid validation evidence");
    }
    return evidence as ValidationEvidence;
}

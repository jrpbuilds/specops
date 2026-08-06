/** Check whether a value is a plain object (not null and not an array). */
export function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Assert that a value is a non-null, non-array object and return it as a
 * `Record<string, unknown>`.
 *
 * @param value - Value to check.
 * @param name - Human-readable field path used in the error message.
 * @returns `value` cast to `Record<string, unknown>`.
 * @throws {Error} If `value` is null, not an object, or an array.
 */
export function asObject(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`invalid SpecOps configuration: ${name}`);
    }
    return value as Record<string, unknown>;
}

/**
 * Assert that a record's keys are a subset of the allowed set, rejecting
 * unknown keys.
 *
 * @param value - The record to validate.
 * @param allowed - Array of permitted key names.
 * @param name - Human-readable field path used in the error message.
 * @throws {Error} If any key in `value` is not present in `allowed`.
 */
export function assertKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
    name: string,
): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            throw new Error(`invalid SpecOps configuration field: ${name}.${key}`);
        }
    }
}

/**
 * Assert that a value is an integer at or above `minimum`.
 *
 * @param value - Value to check.
 * @param name - Human-readable field path used in the error message.
 * @param minimum - Inclusive lower bound; defaults to `1`.
 * @returns The validated integer.
 * @throws {Error} If `value` is not an integer or is below `minimum`.
 */
export function positiveInteger(value: unknown, name: string, minimum: number = 1): number {
    if (!Number.isInteger(value) || Number(value) < minimum) {
        throw new Error(`invalid SpecOps configuration field: ${name}`);
    }
    return Number(value);
}

/**
 * Type guard: returns whether `value` is one of the supplied string choices.
 *
 * @param value - Value to test.
 * @param choices - Allowed string literals.
 * @returns `true` when `value` is a string contained in `choices`.
 */
export function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
    return typeof value === "string" && choices.includes(value as T);
}

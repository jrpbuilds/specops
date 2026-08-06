import { OpenSpecOperationalError } from "./errors.js"

/** Parse an OpenSpec JSON response or raise an operational failure. */
export function parseOpenSpecJson(output: string, operation: string): unknown {
    try {
        return JSON.parse(output)
    } catch {
        throw new OpenSpecOperationalError(
            `${operation} returned malformed JSON. Verify OpenSpec ${operation} supports --json.`,
            output,
        )
    }
}

/** Narrow an unknown value to a JSON object. */
export function object(value: unknown, operation: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new OpenSpecOperationalError(`${operation} returned an unsupported JSON shape.`)
    }
    return value as Record<string, unknown>
}

/** Read a required string property from an OpenSpec JSON object. */
export function string(value: Record<string, unknown>, key: string, operation: string): string {
    if (typeof value[key] !== "string") {
        throw new OpenSpecOperationalError(`${operation} returned an unsupported JSON shape.`)
    }
    return value[key]
}

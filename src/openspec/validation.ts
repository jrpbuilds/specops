import { object, parseOpenSpecJson } from "./json.js"

export type OpenSpecValidationResult = { valid: boolean; issues: unknown[]; raw: unknown }

/** Parse validation output, preserving OpenSpec-owned issue details verbatim. */
export function parseOpenSpecValidation(output: string): OpenSpecValidationResult {
    const value = object(parseOpenSpecJson(output, "openspec validate"), "openspec validate")
    const items = value.items
    if (!Array.isArray(items))
        throw new Error("openspec validate returned an unsupported JSON shape")
    const issues = items.flatMap(item => {
        const record = object(item, "openspec validate")
        return Array.isArray(record.issues) ? record.issues : []
    })
    return {
        valid:
            issues.length === 0 &&
            items.every(item => object(item, "openspec validate").valid === true),
        issues,
        raw: value,
    }
}

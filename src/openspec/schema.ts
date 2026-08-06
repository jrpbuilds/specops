import { UnsupportedOpenSpecSchemaError } from "./errors.js"
import { object, parseOpenSpecJson, string } from "./json.js"

export type OpenSpecSchema = {
    name: string
    description: string
    artifacts: string[]
    source: string
}

/** Parse the schemas JSON response exposed by OpenSpec. */
export function parseOpenSpecSchemas(output: string): OpenSpecSchema[] {
    const value = parseOpenSpecJson(output, "openspec schemas")
    if (!Array.isArray(value)) throw new UnsupportedOpenSpecSchemaError("unavailable")
    return value.map(item => {
        const schema = object(item, "openspec schemas")
        const artifacts = schema.artifacts
        if (!Array.isArray(artifacts) || artifacts.some(artifact => typeof artifact !== "string")) {
            throw new UnsupportedOpenSpecSchemaError("unavailable")
        }
        return {
            name: string(schema, "name", "openspec schemas"),
            description: string(schema, "description", "openspec schemas"),
            artifacts,
            source: string(schema, "source", "openspec schemas"),
        }
    })
}

/** Reject a schema name other than standard upstream `spec-driven`. */
export function assertStandardSchemaName(schemaName: string): void {
    if (schemaName !== "spec-driven") throw new UnsupportedOpenSpecSchemaError(schemaName)
}

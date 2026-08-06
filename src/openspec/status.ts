import { object, parseOpenSpecJson, string } from "./json.js"

export type OpenSpecArtifactStatus = {
    id: string
    outputPath: string
    status: string
    requires: string[]
}
export type OpenSpecChangeStatus = {
    changeName: string
    schemaName: string
    changeRoot: string
    isComplete: boolean
    artifacts: OpenSpecArtifactStatus[]
    artifactPaths: Record<
        string,
        { outputPath: string; resolvedOutputPath: string; existingOutputPaths: string[] }
    >
}

/** Parse the bounded status fields required by the SpecOps adapter. */
export function parseOpenSpecStatus(output: string): OpenSpecChangeStatus {
    const value = object(parseOpenSpecJson(output, "openspec status"), "openspec status")
    if (typeof value.isComplete !== "boolean" || !Array.isArray(value.artifacts)) {
        throw new Error("openspec status returned an unsupported JSON shape")
    }
    const paths = object(value.artifactPaths, "openspec status")
    const artifactPaths = Object.fromEntries(
        Object.entries(paths).map(([id, path]) => {
            const item = object(path, "openspec status")
            const existing = item.existingOutputPaths
            if (!Array.isArray(existing) || existing.some(entry => typeof entry !== "string")) {
                throw new Error("openspec status returned an unsupported JSON shape")
            }
            return [
                id,
                {
                    outputPath: string(item, "outputPath", "openspec status"),
                    resolvedOutputPath: string(item, "resolvedOutputPath", "openspec status"),
                    existingOutputPaths: existing,
                },
            ]
        }),
    )
    return {
        changeName: string(value, "changeName", "openspec status"),
        schemaName: string(value, "schemaName", "openspec status"),
        changeRoot: string(value, "changeRoot", "openspec status"),
        isComplete: value.isComplete,
        artifacts: value.artifacts.map(artifact => {
            const item = object(artifact, "openspec status")
            const requires = item.requires
            if (!Array.isArray(requires) || requires.some(entry => typeof entry !== "string")) {
                throw new Error("openspec status returned an unsupported JSON shape")
            }
            return {
                id: string(item, "id", "openspec status"),
                outputPath: string(item, "outputPath", "openspec status"),
                status: string(item, "status", "openspec status"),
                requires,
            }
        }),
        artifactPaths,
    }
}

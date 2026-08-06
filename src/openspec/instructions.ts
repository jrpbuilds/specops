import { object, parseOpenSpecJson, string } from "./json.js";

export type OpenSpecInstructions = {
    artifactId: string;
    schemaName: string;
    outputPath: string;
    resolvedOutputPath: string;
    description: string;
    instruction: string;
    template: string;
    dependencies: string[];
};

/** Parse current upstream artifact instructions without copying their templates. */
export function parseOpenSpecInstructions(output: string): OpenSpecInstructions {
    const value = object(
        parseOpenSpecJson(output, "openspec instructions"),
        "openspec instructions",
    );
    const dependencies = value.dependencies;
    if (!Array.isArray(dependencies) || dependencies.some(item => typeof item !== "string")) {
        throw new Error("openspec instructions returned an unsupported JSON shape");
    }
    return {
        artifactId: string(value, "artifactId", "openspec instructions"),
        schemaName: string(value, "schemaName", "openspec instructions"),
        outputPath: string(value, "outputPath", "openspec instructions"),
        resolvedOutputPath: string(value, "resolvedOutputPath", "openspec instructions"),
        description: string(value, "description", "openspec instructions"),
        instruction: string(value, "instruction", "openspec instructions"),
        template: string(value, "template", "openspec instructions"),
        dependencies,
    };
}

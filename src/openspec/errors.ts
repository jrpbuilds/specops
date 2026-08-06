/** OpenSpec failed to execute or returned an unsupported machine-readable response. */
export class OpenSpecOperationalError extends Error {
    constructor(
        message: string,
        readonly output?: string,
    ) {
        super(message);
        this.name = "OpenSpecOperationalError";
    }
}

/** Installed OpenSpec is outside the supported SpecOps 1.0 compatibility range. */
export class OpenSpecCompatibilityError extends Error {
    constructor(readonly detectedVersion: string) {
        super(
            `Unsupported OpenSpec version ${detectedVersion}; SpecOps 1.0 requires >=1.7.0 <1.8.0. Install @fission-ai/openspec@1.7.x and retry.`,
        );
        this.name = "OpenSpecCompatibilityError";
    }
}

/** The project or change uses a schema other than standard `spec-driven`. */
export class UnsupportedOpenSpecSchemaError extends Error {
    constructor(readonly schemaName: string) {
        super(
            `Unsupported OpenSpec schema ${schemaName}; SpecOps 1.0 supports only spec-driven. Preserve the project schema or create a standard spec-driven change.`,
        );
        this.name = "UnsupportedOpenSpecSchemaError";
    }
}

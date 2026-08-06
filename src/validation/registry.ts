/** Explicit shell-free command configuration accepted for a V1 validation gate. */
export type ValidationCommand = {
    id: string
    executable: string
    args: string[]
    cwd?: string
    timeoutMs: number
    maxOutputBytes: number
}

/** Explorer-proposed command held separately until a planning checkpoint accepts it. */
export type ValidationRecommendation = ValidationCommand & { source: "explorer" }

/** Validated required commands and still-unaccepted explorer recommendations. */
export type ValidationRegistry = {
    required: ValidationCommand[]
    recommendations: ValidationRecommendation[]
}

/**
 * Build the validation registry while keeping explorer recommendations
 * non-authoritative until their ids are explicitly accepted.
 */
export function createValidationRegistry(
    configured: ValidationCommand[],
    recommendations: ValidationRecommendation[] = [],
    acceptedRecommendationIds: string[] = [],
): ValidationRegistry {
    const accepted = new Set(acceptedRecommendationIds)
    const configuredIds = new Set(configured.map(command => command.id))
    const required = [
        ...configured,
        ...recommendations.filter(item => accepted.has(item.id) && !configuredIds.has(item.id)),
    ]
    validateValidationCommands(required)
    validateValidationCommands(recommendations)
    return {
        required: required.map(copyCommand),
        recommendations: recommendations
            .filter(item => !accepted.has(item.id))
            .map(item => ({ ...copyCommand(item), source: "explorer" })),
    }
}

/** Validate explicit validation commands before they can execute. */
export function validateValidationCommands(commands: ValidationCommand[]): void {
    const ids = new Set<string>()
    for (const command of commands) {
        if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(command.id)) {
            throw new Error(`invalid validation command id: ${command.id}`)
        }
        if (ids.has(command.id)) throw new Error(`duplicate validation command id: ${command.id}`)
        ids.add(command.id)
        if (!command.executable.trim() || command.executable.includes("\0")) {
            throw new Error(`invalid validation executable for ${command.id}`)
        }
        if (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== "string")) {
            throw new Error(`invalid validation arguments for ${command.id}`)
        }
        if (
            command.cwd !== undefined &&
            (command.cwd.includes("\0") || command.cwd.startsWith("/"))
        ) {
            throw new Error(
                `validation working directory must be repository-relative for ${command.id}`,
            )
        }
        if (!isPositiveInteger(command.timeoutMs) || !isPositiveInteger(command.maxOutputBytes)) {
            throw new Error(`invalid validation limits for ${command.id}`)
        }
    }
}

/** Return an immutable-by-convention copy of a command configuration. */
function copyCommand(command: ValidationCommand): ValidationCommand {
    return { ...command, args: [...command.args] }
}

/** Return whether a configured numeric bound is a positive integer. */
function isPositiveInteger(value: number): boolean {
    return Number.isInteger(value) && value > 0
}

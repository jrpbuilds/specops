import {
    createValidationRegistry,
    type ValidationCommand,
    type ValidationRecommendation,
} from "./registry.js";

/** Validation commands approved for a run after its planning checkpoint. */
export type AcceptedValidationCommands = {
    required: ValidationCommand[];
    acceptedRecommendationIds: string[];
};

/**
 * Build the authoritative command set for a run. Configured commands are
 * always required; explorer recommendations join only after explicit approval.
 */
export function acceptValidationCommands(
    configured: ValidationCommand[],
    recommendations: ValidationRecommendation[] = [],
    acceptedRecommendationIds: string[] = [],
): AcceptedValidationCommands {
    const recommendationIds = new Set(recommendations.map(command => command.id));
    const unknown = acceptedRecommendationIds.find(id => !recommendationIds.has(id));
    if (unknown) throw new Error(`unknown explorer validation recommendation: ${unknown}`);

    const registry = createValidationRegistry(
        configured,
        recommendations,
        acceptedRecommendationIds,
    );
    return {
        required: registry.required,
        acceptedRecommendationIds: [...new Set(acceptedRecommendationIds)].sort(),
    };
}

/** Rebuild a persisted run's command set from active configuration and recommendations. */
export function acceptedValidationCommandsForRun(
    configured: ValidationCommand[],
    recommendations: ValidationRecommendation[],
    acceptedRecommendationIds: readonly string[],
): AcceptedValidationCommands {
    return acceptValidationCommands(configured, recommendations, [...acceptedRecommendationIds]);
}

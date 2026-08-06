/** A worker-reported decision that may require a native coordinator question. */
export type PlanningWorkerQuestion = {
    prompt: string
    outcomes: readonly string[]
    repositoryResolvable: boolean
    affectsMaterialOutcome: boolean
    reversibleLowRiskAssumptionAvailable: boolean
}

/** A coordinator-owned native-question request. */
export type PlanningMaterialQuestion = Pick<PlanningWorkerQuestion, "prompt" | "outcomes">

/** Decide whether a worker blocker meets the intentionally narrow question policy. */
export function isPlanningMaterialQuestion(question: PlanningWorkerQuestion): boolean {
    return (
        question.prompt.trim().length > 0 &&
        question.outcomes.length >= 2 &&
        !question.repositoryResolvable &&
        question.affectsMaterialOutcome &&
        !question.reversibleLowRiskAssumptionAvailable
    )
}

/** Route a permitted worker blocker to the coordinator or reject a trivial question. */
export function routePlanningWorkerQuestion(
    question: PlanningWorkerQuestion,
): { kind: "ask"; question: PlanningMaterialQuestion } | { kind: "continue" } {
    return isPlanningMaterialQuestion(question)
        ? { kind: "ask", question: { prompt: question.prompt, outcomes: question.outcomes } }
        : { kind: "continue" }
}

/** Values intentionally separated by trust boundary before prompt rendering. */
export type PromptValues = {
    trusted?: Record<string, string>
    untrusted?: Record<string, string>
}

const PLACEHOLDER = /\{\{(?:(trusted|untrusted):)?([a-zA-Z][a-zA-Z0-9_]*)\}\}/g

/**
 * Render simple named placeholders without executable template features.
 *
 * Untrusted values are wrapped in explicit delimiters so a recipient model can
 * distinguish user or repository content from trusted role instructions.
 */
export function renderPrompt(template: string, values: PromptValues): string {
    const rendered = template.replace(
        PLACEHOLDER,
        (_placeholder, boundary: string | undefined, name) => {
            const bucket = boundary === "untrusted" ? values.untrusted : values.trusted
            const value = bucket?.[name]
            if (value === undefined)
                throw new Error(`missing prompt value: ${boundary ?? "trusted"}:${name}`)
            if (boundary === "untrusted") {
                return `<untrusted-${name}>\n${value}\n</untrusted-${name}>`
            }
            return value
        },
    )
    if (PLACEHOLDER.test(rendered)) throw new Error("prompt contains unresolved placeholders")
    return rendered
}

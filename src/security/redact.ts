/**
 * Redact common credential material before text is persisted to run artifacts,
 * evidence excerpts, or diagnostics. Hashes are computed from the raw bytes by
 * callers before this function is applied, preserving evidence identity without
 * retaining the secret itself.
 */
export function redactSensitiveText(value: string): string {
    let redacted = value
    for (const [name, secret] of Object.entries(process.env)) {
        if (
            !secret ||
            secret.length < 8 ||
            !/(token|secret|password|passwd|credential|api[_-]?key)/i.test(name)
        ) {
            continue
        }
        redacted = redacted.split(secret).join(`[REDACTED:${name}]`)
    }
    redacted = redacted.replace(
        /((?:authorization|proxy-authorization)\s*:\s*bearer\s+)[^\s,;]+/gi,
        "$1[REDACTED]",
    )
    redacted = redacted.replace(
        /((?:["']?[a-z0-9_-]*(?:token|secret|password|passwd|credential|api[_-]?key)[a-z0-9_-]*["']?)\s*[=:]\s*)"[^"\r\n]*"/gi,
        '$1"[REDACTED]"',
    )
    redacted = redacted.replace(
        /((?:["']?[a-z0-9_-]*(?:token|secret|password|passwd|credential|api[_-]?key)[a-z0-9_-]*["']?)\s*[=:]\s*)'[^'\r\n]*'/gi,
        "$1'[REDACTED]'",
    )
    redacted = redacted.replace(
        /((?:["']?[a-z0-9_-]*(?:token|secret|password|passwd|credential|api[_-]?key)[a-z0-9_-]*["']?)\s*[=:]\s*)(?!["'])[^\s,;}\]]+/gi,
        "$1[REDACTED]",
    )
    return redacted.replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
        "[REDACTED:PRIVATE_KEY]",
    )
}

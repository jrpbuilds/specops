import { OpenSpecCompatibilityError } from "./errors.js"

export const SUPPORTED_OPENSPEC_RANGE = ">=1.7.0 <1.8.0"

/** Parse and validate one OpenSpec semantic version from command stdout. */
export function parseOpenSpecVersion(output: string): string {
    const match = output.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/)
    if (!match) throw new OpenSpecCompatibilityError(output.trim() || "unavailable")
    const [, major, minor, patch] = match
    const version = `${major}.${minor}.${patch}`
    if (major !== "1" || minor !== "7") throw new OpenSpecCompatibilityError(version)
    return version
}

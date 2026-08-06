import { parseOpenSpecJson } from "./json.js"

export type OpenSpecArchiveResult = {
    success: boolean
    code: number
    stdout: string
    stderr: string
    result?: unknown
}

/** Normalize archival output while preserving failures for retry handling. */
export function parseOpenSpecArchive(
    stdout: string,
    stderr: string,
    code: number,
): OpenSpecArchiveResult {
    if (code !== 0) return { success: false, code, stdout, stderr }
    return {
        success: true,
        code,
        stdout,
        stderr,
        result: parseOpenSpecJson(stdout, "openspec archive"),
    }
}

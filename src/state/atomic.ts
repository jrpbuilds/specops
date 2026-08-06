import { randomUUID } from "node:crypto"
import { mkdir, open, rename, unlink } from "node:fs/promises"
import path from "node:path"

/**
 * Atomically replace a UTF-8 text file after creating its parent directory.
 *
 * @param destination - File to replace.
 * @param content - Complete UTF-8 content to persist.
 */
export async function writeFileAtomic(destination: string, content: string): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true })
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(temporary, "wx")
    try {
        await handle.writeFile(content, "utf8")
        await handle.sync()
    } finally {
        await handle.close()
    }
    try {
        await rename(temporary, destination)
    } finally {
        await unlink(temporary).catch(() => undefined)
    }
}

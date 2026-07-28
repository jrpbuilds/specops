/**
 * The agent runner: launches native OpenCode subagent sessions, handles
 * timeouts, cancellation, and transient-provider retries.
 *
 * The runner is the single funnel through which every worker is invoked. It
 * enforces the configured timeout, retries transient provider failures with
 * exponential backoff, and reports every state transition to the optional
 * {@link WorkerReporter}.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type { AgentRunner, WorkerEvent, WorkerReporter } from "./progress.js"
import type { SpecOpsConfig } from "./core.js"

/**
 * Extract the concatenated text parts from an OpenCode SDK response. The SDK
 * returns a deeply-nested structure; this flattens it to a plain string.
 *
 * @param response - The raw SDK response object.
 */
export function responseText(response: unknown): string {
  const data = (response as { data?: { parts?: unknown[] } })?.data ??
    (response as { parts?: unknown[] })
  const parts = (data as { parts?: Array<{ type?: string; text?: string }> })?.parts ?? []
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

/**
 * Render an error (and its cause chain) into a single human-readable string.
 * Guards against circular cause chains by tracking seen objects.
 *
 * @param error - The error to describe.
 * @param seen - Internal set guarding against circular `cause` chains.
 */
export function describeError(error: unknown, seen = new Set<unknown>()): string {
  if (typeof error === "object" && error !== null) {
    if (seen.has(error)) return "[circular error cause]"
    seen.add(error)
  }
  if (error instanceof Error) {
    const cause =
      error.cause === undefined ? "" : `; cause: ${describeError(error.cause, seen)}`
    return `${error.name}: ${error.message}${cause}`
  }
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/**
 * Classify an error as a transient provider capacity failure (HTTP 429,
 * rate-limit, 503/504, timeouts, streaming failures). Such errors retain the
 * selected model and retry with backoff rather than escalating the workflow.
 *
 * @param error - The error from the SDK call.
 */
export function isTransientProviderError(error: unknown): boolean {
  const text = describeError(error)
  return /(?:\b429\b|rate.?limit|provider.*(?:unavailable|capacity)|temporar(?:y|ily).?unavailable|stream(?:ing)? response failed|\b50[234]\b|timed? out)/i.test(
    text,
  )
}

/**
 * Wait for a number of seconds, rejecting early if the abort signal fires.
 * Used to back off transient provider failures.
 *
 * @param seconds - How long to wait.
 * @param signal - Optional abort signal; aborting rejects the promise.
 */
export async function waitForProvider(seconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Provider wait cancelled by user")
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", cancel)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, seconds * 1000)
    const cancel = () => {
      clearTimeout(timer)
      cleanup()
      reject(new Error("Provider wait cancelled by user"))
    }
    signal?.addEventListener("abort", cancel, { once: true })
  })
}

/**
 * Create an {@link AgentRunner} bound to the current OpenCode session and
 * SpecOps configuration.
 *
 * The runner:
 * 1. Creates a child session with `parentID` as its parent.
 * 2. Prompts the named agent, applying the MCP policy from `config.integrations.mcp`.
 * 3. Races the prompt against a per-agent timeout and the abort signal.
 * 4. On transient failure, retries with exponential backoff up to
 *    `review.transient_retries` (plus unlimited retries for transient errors).
 * 5. Reports every state transition to the optional `reporter`.
 *
 * @param input - The OpenCode plugin input (provides the SDK client and directory).
 * @param config - The merged SpecOps configuration.
 */
export function createAgentRunner(input: PluginInput, config: SpecOpsConfig): AgentRunner {
  return async (agent, prompt, parentID, reporter, signal) => {
    let lastError: unknown
    // Capacity errors retain the selected model and poll until success or user
    // cancellation. Other failures use the configured finite retry allowance.
    for (let attempt = 0; ; attempt += 1) {
      let sessionID: string | undefined
      const started = Date.now()
      const startedAt = new Date(started).toISOString()
      await reporter?.({
        agent,
        attempt: attempt + 1,
        state: attempt === 0 ? "starting" : "retrying",
        startedAt,
        elapsedMs: 0,
      })
      try {
        if (signal?.aborted) throw new Error(`${agent} cancelled before start`)
        const created = await input.client.session.create({
          body: { parentID, title: `SpecOps: ${agent}` },
          query: { directory: input.directory },
        })
        sessionID = (created as { data?: { id?: string } }).data?.id
        if (!sessionID) throw new Error(`OpenCode did not return a session id for ${agent}`)
        await reporter?.({
          agent,
          sessionID,
          attempt: attempt + 1,
          state: "running",
          startedAt,
          elapsedMs: Date.now() - started,
        })
        const operation = input.client.session.prompt({
          path: { id: sessionID },
          query: { directory: input.directory },
          body: {
            agent,
            parts: [
              {
                type: "text",
                text:
                  (config.integrations.mcp === "disabled"
                    ? "SpecOps project policy: do not invoke any MCP tool for this task.\n\n"
                    : "SpecOps project policy: configured MCP tools are optional context sources; do not require them or perform external writes without explicit authorization.\n\n") +
                  prompt,
              },
            ],
          },
        })
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`${agent} timed out after ${config.review.agent_timeout_seconds}s`)),
            config.review.agent_timeout_seconds * 1000,
          )
        })
        let cancelHandler: (() => void) | undefined
        const cancelled = new Promise<never>((_, reject) => {
          cancelHandler = () => reject(new Error(`${agent} cancelled by user`))
          signal?.addEventListener("abort", cancelHandler, { once: true })
        })
        const response = await Promise.race([operation, timeout, cancelled]).finally(() => {
          if (timeoutHandle) clearTimeout(timeoutHandle)
          if (cancelHandler) signal?.removeEventListener("abort", cancelHandler)
        })
        const output = responseText(response)
        if (!output) throw new Error(`${agent} returned no text`)
        await reporter?.({
          agent,
          sessionID,
          attempt: attempt + 1,
          state: "completed",
          startedAt,
          elapsedMs: Date.now() - started,
          outputChars: output.length,
        })
        return output
      } catch (error) {
        lastError = error
        if (sessionID) {
          await input.client.session
            .abort({ path: { id: sessionID }, query: { directory: input.directory } })
            .catch(() => undefined)
        }
        const cancelled = signal?.aborted === true
        const transient = isTransientProviderError(error)
        const willRetry =
          !cancelled && (transient || attempt < config.review.transient_retries)
        await reporter?.({
          agent,
          sessionID,
          attempt: attempt + 1,
          state: cancelled
            ? "cancelled"
            : willRetry
              ? "retrying"
              : "failed",
          startedAt,
          elapsedMs: Date.now() - started,
          error: describeError(error),
        })
        if (cancelled) throw new Error(`${agent} cancelled by user`)
        if (!willRetry) break
        await waitForProvider(Math.min(30, 5 * 2 ** Math.min(attempt, 3)), signal)
      }
    }
    throw new Error(`${agent} failed: ${describeError(lastError)}`)
  }
}

/** Re-export the worker-event types for callers that need to construct events. */
export type { WorkerEvent, WorkerReporter }

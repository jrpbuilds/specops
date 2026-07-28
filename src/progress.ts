/**
 * Progress tracking and worker observability for the automatic workflow.
 *
 * {@link ProgressTracker} publishes live metadata titles and durable
 * `specops-progress.json` documents so the user can watch every phase and
 * worker in OpenCode's native subagent pane (ctrl+x, then down).
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { slugifyGoal } from "./core.js"

/** The lifecycle state of a single worker invocation. */
export type WorkerState =
  | "starting"
  | "running"
  | "completed"
  | "retrying"
  | "failed"
  | "cancelled"

/** A single worker event emitted by the agent runner. */
export type WorkerEvent = {
  agent: string
  sessionID?: string
  attempt: number
  state: WorkerState
  startedAt: string
  elapsedMs: number
  error?: string
  outputChars?: number
}

/** Callback invoked on every worker state transition. */
export type WorkerReporter = (event: WorkerEvent) => void | Promise<void>

/** The signature of the agent runner function (see `runner.ts`). */
export type AgentRunner = (
  agent: string,
  prompt: string,
  parentID?: string,
  reporter?: WorkerReporter,
  signal?: AbortSignal,
) => Promise<string>

/** Context required to publish live metadata titles in OpenCode's UI. */
export type MetadataContext = {
  sessionID: string
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void
}

/** A worker event enriched with a stable sequence number for ordering. */
export type ProgressWorker = WorkerEvent & { sequence: number }

/** The durable on-disk progress document written to `specops-progress.json`. */
export type ProgressDocument = {
  version: 1
  run_id: string
  mode: "automatic"
  goal: string
  change?: string
  state: "running" | "passed" | "failed" | "cancelled"
  started_at: string
  updated_at: string
  elapsed_ms: number
  phase: {
    index: number
    total: number
    id: string
    label: string
    status: "running" | "completed" | "failed" | "cancelled"
    remediation_cycle: number
    agents: string[]
  }
  workers: ProgressWorker[]
  error?: string
}

/** Total phases in the automatic workflow (used as a default before the plan is known). */
export const AUTO_PHASE_TOTAL = 13

/**
 * Format an elapsed duration as `MM:SS` for compact titles.
 *
 * @param milliseconds - Elapsed time in milliseconds.
 */
function elapsedLabel(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

/**
 * Tracks an automatic workflow run: live metadata titles, durable progress
 * documents, and a clickable worker map for OpenCode's subagent pane.
 *
 * One instance per `specops_run_auto` invocation. The reporter is exposed for
 * the runner to feed worker events into; the signal is forwarded from the
 * caller's `AbortController`.
 */
export class ProgressTracker {
  readonly reporter: WorkerReporter
  readonly signal: AbortSignal
  private readonly started = Date.now()
  private readonly startedAt = new Date(this.started).toISOString()
  private readonly workers = new Map<string, ProgressWorker>()
  private readonly timer: ReturnType<typeof setInterval>
  private sequence = 0
  private change: string | undefined
  private progressDirectory: string | undefined
  private phaseIndex = 0
  private phaseID = "preflight"
  private phaseLabel = "Preflight"
  private phaseAgents: string[] = []
  private remediationCycle = 0
  private total = AUTO_PHASE_TOTAL
  private state: ProgressDocument["state"] = "running"
  private phaseStatus: ProgressDocument["phase"]["status"] = "running"
  private error: string | undefined
  private writeChain = Promise.resolve()

  /**
   * @param context - Metadata publisher for live titles.
   * @param directory - The project root directory.
   * @param goal - The user's goal text.
   * @param signal - Abort signal forwarded from the caller.
   */
  constructor(
    private readonly context: MetadataContext,
    private readonly directory: string,
    private readonly goal: string,
    signal: AbortSignal,
  ) {
    this.signal = signal
    this.reporter = async (event) => {
      const key = event.sessionID ?? `${event.agent}:${event.attempt}`
      if (event.sessionID) this.workers.delete(`${event.agent}:${event.attempt}`)
      const existing = this.workers.get(key)
      this.workers.set(key, {
        ...event,
        sequence: existing?.sequence ?? ++this.sequence,
      })
      this.render()
      await this.persist()
    }
    this.timer = setInterval(() => this.render(), 1000)
    this.render()
  }

  /** Bind this tracker to a specific OpenSpec change and start persisting. */
  async setChange(change: string): Promise<void> {
    this.change = change
    this.progressDirectory = path.join(this.directory, "openspec", "changes", change)
    await this.persist()
  }

  /** Update the total phase count (after the tier plan is known). */
  setTotal(total: number): void {
    this.total = Math.max(this.phaseIndex, total)
    this.render()
  }

  /** Move the progress document to a new directory (used after archive). */
  relocate(progressDirectory: string): void {
    this.progressDirectory = progressDirectory
  }

  /** Advance to a new phase. Renders and persists immediately. */
  async phase(
    index: number,
    id: string,
    label: string,
    agents: string[] = [],
    remediationCycle = 0,
  ): Promise<void> {
    this.phaseIndex = index
    this.phaseID = id
    this.phaseLabel = label
    this.phaseAgents = agents
    this.remediationCycle = remediationCycle
    this.phaseStatus = "running"
    this.render()
    await this.persist()
  }

  /** Mark the run as finished. Stops the render timer and writes the final state. */
  async finish(state: "passed" | "failed" | "cancelled", error?: unknown): Promise<void> {
    if (this.state !== "running") return
    this.state = state
    this.phaseStatus =
      state === "passed" ? "completed" : state === "cancelled" ? "cancelled" : "failed"
    this.error = error === undefined ? undefined : String(error)
    clearInterval(this.timer)
    this.render()
    await this.persist()
  }

  /** Build the structured tool result (title, output, metadata) for OpenCode. */
  result(output: string): {
    title: string
    output: string
    metadata: Record<string, unknown>
  } {
    const document = this.document()
    const active = this.activeWorker()
    return {
      title: `SpecOps ${document.state} • ${document.change ?? slugifyGoal(this.goal)} • ${elapsedLabel(document.elapsed_ms)}`,
      output,
      metadata: {
        parentSessionId: this.context.sessionID,
        ...(active?.sessionID ? { sessionId: active.sessionID } : {}),
        specops: document,
        workers: document.workers.map((worker) => ({
          agent: worker.agent,
          sessionId: worker.sessionID,
          state: worker.state,
          attempt: worker.attempt,
          elapsedMs: worker.elapsedMs,
        })),
      },
    }
  }

  /** Pick the worker to highlight in the title (prefers running, rotates among them). */
  private activeWorker(): ProgressWorker | undefined {
    const workers = [...this.workers.values()].sort((a, b) => b.sequence - a.sequence)
    const running = workers.filter((worker) =>
      ["starting", "running", "retrying"].includes(worker.state),
    )
    if (running.length) {
      return running[Math.floor((Date.now() - this.started) / 5000) % running.length]
    }
    return workers[0]
  }

  /** Construct the current progress document snapshot. */
  private document(): ProgressDocument {
    const now = Date.now()
    return {
      version: 1,
      run_id: this.context.sessionID,
      mode: "automatic",
      goal: this.goal,
      change: this.change,
      state: this.state,
      started_at: this.startedAt,
      updated_at: new Date(now).toISOString(),
      elapsed_ms: now - this.started,
      phase: {
        index: this.phaseIndex,
        total: this.total,
        id: this.phaseID,
        label: this.phaseLabel,
        status: this.phaseStatus,
        remediation_cycle: this.remediationCycle,
        agents: this.phaseAgents,
      },
      workers: [...this.workers.values()].sort((a, b) => a.sequence - b.sequence),
      error: this.error,
    }
  }

  /** Publish the live metadata title to OpenCode. */
  private render(): void {
    const document = this.document()
    const active = this.activeWorker()
    const workerText =
      this.phaseAgents.length > 1
        ? `${this.phaseAgents.length} workers${active ? ` • ${active.agent}` : ""}`
        : active?.agent ?? this.phaseAgents[0]
    const cycle = this.remediationCycle > 0 ? ` • repair ${this.remediationCycle}` : ""
    this.context.metadata({
      title: `SpecOps ${this.phaseIndex}/${this.total} • ${this.phaseLabel}${workerText ? ` • ${workerText}` : ""}${cycle} • ${elapsedLabel(document.elapsed_ms)}`,
      metadata: {
        parentSessionId: this.context.sessionID,
        ...(active?.sessionID ? { sessionId: active.sessionID } : {}),
        specops: document,
        workers: document.workers.map((worker) => ({
          agent: worker.agent,
          sessionId: worker.sessionID,
          state: worker.state,
          attempt: worker.attempt,
          elapsedMs: worker.elapsedMs,
        })),
      },
    })
  }

  /** Persist the progress document to disk, serialized behind a write chain. */
  private async persist(): Promise<void> {
    if (!this.progressDirectory) return
    const destination = path.join(this.progressDirectory, "specops-progress.json")
    const content = JSON.stringify(this.document(), null, 2) + "\n"
    this.writeChain = this.writeChain.then(() => writeFile(destination, content, "utf-8"))
    await this.writeChain
  }
}

/**
 * A lightweight worker reporter for non-ProgressTracker use (e.g. the onboarding,
 * judgment, and review-panel tools). Publishes a single rolling title with the
 * active worker and a compact worker map.
 *
 * @param context - Metadata publisher for live titles.
 * @param title - Prefix for the published title.
 */
export function linkedWorkerReporter(
  context: MetadataContext,
  title: string,
): WorkerReporter {
  const workers = new Map<string, WorkerEvent>()
  return (event) => {
    const key = event.sessionID ?? `${event.agent}:${event.attempt}`
    if (event.sessionID) workers.delete(`${event.agent}:${event.attempt}`)
    workers.set(key, event)
    const active = [...workers.values()].find((worker) =>
      ["starting", "running", "retrying"].includes(worker.state),
    ) ?? event
    context.metadata({
      title: `${title} • ${active.agent} • ${active.state} • ${elapsedLabel(active.elapsedMs)}`,
      metadata: {
        parentSessionId: context.sessionID,
        ...(active.sessionID ? { sessionId: active.sessionID } : {}),
        workers: [...workers.values()].map((worker) => ({
          agent: worker.agent,
          sessionId: worker.sessionID,
          state: worker.state,
          attempt: worker.attempt,
          elapsedMs: worker.elapsedMs,
        })),
      },
    })
  }
}

/** Ensure a directory exists (used by callers that write artifacts). */
export async function ensureDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true })
}

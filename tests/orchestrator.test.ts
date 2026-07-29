import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { COMMANDS } from "../src/commands.js"
import { ProgressTracker } from "../src/progress.js"
import {
  SPECOPS_CONTROLLER_PROMPT,
  SPECOPS_INTERACTIVE_PROMPT,
} from "../src/prompts-controller.js"
import { escalateVisibleRun } from "../src/runs.js"
import {
  parseAssessment,
  parseTierInvocation,
} from "../src/parsing.js"
import { footprintEscalation, moduleKey } from "../src/git.js"
import { isTransientProviderError } from "../src/runner.js"
import { DEFAULT_MANIFEST, manifestAgentConfig } from "../src/manifest.js"
import {
  judgmentDayWithRunner,
  reviewPanelWithRunner,
} from "../src/judgment.js"

describe("visible automatic controller", () => {
  it("preserves OpenCode provider options from the manifest", () => {
    const config = manifestAgentConfig("sdd-apply", {
      model: "provider/model",
      steps: 96,
      tools: { question: false },
      permission: { bash: "allow", edit: "allow", task: "deny" },
      reasoningEffort: "high",
      textVerbosity: "low",
    })

    expect(config.reasoningEffort).toBe("high")
    expect(config.textVerbosity).toBe("low")
    expect(config.steps).toBe(96)
    expect(config).not.toHaveProperty("maxSteps")
    expect(config.mode).toBe("subagent")
    expect(config.prompt).toContain("sdd-apply")
  })

  it("discards deprecated maxSteps without supplying a replacement budget", () => {
    const config = manifestAgentConfig("sdd-apply", {
      model: "provider/model",
      maxSteps: 16,
      tools: { question: false },
      permission: { bash: "allow", edit: "allow", task: "deny" },
    } as unknown as Parameters<typeof manifestAgentConfig>[1])

    expect(config).not.toHaveProperty("maxSteps")
    expect(config).not.toHaveProperty("steps")
  })

  it("ships high role-based default step budgets", () => {
    for (const [agentId, agent] of Object.entries(DEFAULT_MANIFEST.agents)) {
      const expected = agentId === "sdd-apply"
        ? 96
        : agentId === "sdd-verify" || agentId === "jd-fix-agent"
          ? 64
          : 32
      expect(agent.steps).toBe(expected)
    }
  })

  it("routes automatic mode through native task workers", () => {
    expect(COMMANDS["specops-auto"]?.agent).toBe("specops-controller")
    expect(COMMANDS["specops-auto"]?.subtask).toBe(false)
    expect(COMMANDS["specops-auto"]?.template).toContain("built-in task tool")
    expect(COMMANDS["specops-auto-headless"]).toBeDefined()
    expect(SPECOPS_CONTROLLER_PROMPT).toContain("built-in `task`")
    expect(SPECOPS_CONTROLLER_PROMPT).toContain("ctrl+x, then down")
    expect(SPECOPS_CONTROLLER_PROMPT).toContain("plan.judges")
    expect(SPECOPS_CONTROLLER_PROMPT).toContain("sdd-assess")
    expect(SPECOPS_CONTROLLER_PROMPT).toContain("specops_wait_for_provider")
    expect(SPECOPS_CONTROLLER_PROMPT).not.toContain("\\`")
    expect(COMMANDS.specops?.agent).toBe("specops-interactive-controller")
    expect(SPECOPS_INTERACTIVE_PROMPT).toContain("Do not ask the user to select a workflow tier")
  })

  it("groups implementation footprint by meaningful boundaries", () => {
    expect(moduleKey("src/auth/Login.ts")).toBe("src/auth")
    expect(moduleKey("tests/Feature/AuthTest.ts")).toBe("tests/Feature")
    expect(moduleKey("database/migrations/001_add_users.sql")).toBe("database/migrations")
  })

  it("parses explicit minimum tiers without polluting the goal", () => {
    expect(parseTierInvocation("--tier=full migrate the queue")).toEqual({
      goal: "migrate the queue",
      requestedTier: "full",
    })
    expect(parseTierInvocation("fix the typo")).toEqual({
      goal: "fix the typo",
      requestedTier: "auto",
    })
    expect(() => parseTierInvocation("--tier medium fix it")).toThrow("Tier syntax")
  })

  it("validates strict assessor JSON", () => {
    const valid = {
      suggested_tier: "lean",
      change_kind: "documentation",
      expected_files: 1,
      expected_modules: 1,
      restores_existing_behavior: false,
      changes_requirements: false,
      public_contract: "none",
      security_sensitive: false,
      data_migration: false,
      new_external_dependency: false,
      infrastructure_change: false,
      concurrency_sensitive: false,
      destructive_or_irreversible: false,
      cross_cutting_architecture: false,
      critical_unknowns: false,
      rationale: ["One documentation file."],
      evidence: ["README.md"],
    }
    expect(parseAssessment(JSON.stringify(valid))).toEqual(valid)
    expect(() => parseAssessment(JSON.stringify({ ...valid, expected_files: 0 }))).toThrow(
      "expected_files",
    )
  })

  it("normalizes the compact assessment emitted by free routing models", () => {
    const compact = {
      goal: "update the README with a test line",
      tier: "lean",
      rationale:
        "Trivial single-file documentation change with zero impact on code, contracts, security, dependencies, or behavior.",
      requiresOnboarding: false,
      scope: {
        type: "single_file",
        files: ["README.md"],
        complexity: "trivial",
      },
      risks: ["None — documentation-only change with no behavioral impact"],
      dependencies: [],
    }
    const normalized = parseAssessment(JSON.stringify(compact))
    expect(normalized.suggested_tier).toBe("lean")
    expect(normalized.change_kind).toBe("documentation")
    expect(normalized.expected_files).toBe(1)
    expect(normalized.security_sensitive).toBe(false)
    expect(normalized.rationale.at(-1)).toContain("compact assessor format")
  })

  it("persists monotonic schema escalation and history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "specops-escalation-"))
    const change = "adaptive-run"
    const directory = path.join(root, "openspec", "changes", change)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, ".openspec.yaml"), "schema: specops-lean\ngoal: test\n")
    await writeFile(path.join(directory, "routing.md"), "# Adaptive Routing\n")
    await writeFile(
      path.join(directory, "specops-run.json"),
      JSON.stringify({
        version: 2,
        mode: "visible-controller",
        goal: "test",
        base_commit: "abc",
        requested_tier: "auto",
        initial_tier: "lean",
        tier: "lean",
        schema: "specops-lean",
        assessment: {},
        routing_reasons: [],
        tier_history: [],
        created_at: new Date().toISOString(),
      }),
    )

    const standard = await escalateVisibleRun(root, change, "standard", "Requirements changed.")
    expect(standard.escalated).toBe(true)
    expect(standard.plan.tier).toBe("standard")
    const metadata = await readFile(path.join(directory, ".openspec.yaml"), "utf-8")
    expect(metadata).toContain("schema: specops-standard")
    expect(metadata).toContain("goal: test")
    const ignored = await escalateVisibleRun(root, change, "standard", "No downgrade.")
    expect(ignored.escalated).toBe(false)
    const full = await escalateVisibleRun(root, change, "full", "Security impact.")
    expect(full.history).toHaveLength(2)
  })

  it("raises tiers from actual implementation footprint", () => {
    const config = {
      workflow: {
        lean_max_files: 2,
        lean_max_modules: 1,
        full_min_files: 9,
        full_min_modules: 4,
      },
    } as Parameters<typeof footprintEscalation>[2]
    expect(footprintEscalation("lean", { files: 3, modules: 1 }, config)).toBe("standard")
    expect(footprintEscalation("standard", { files: 9, modules: 2 }, config)).toBe("full")
    expect(footprintEscalation("full", { files: 20, modules: 8 }, config)).toBeUndefined()
  })

  it("distinguishes transient provider failures from workflow findings", () => {
    expect(isTransientProviderError(new Error("HTTP 429 provider rate limit exceeded"))).toBe(true)
    expect(isTransientProviderError(new Error("Streaming response failed"))).toBe(true)
    expect(isTransientProviderError(new Error("503 temporarily unavailable"))).toBe(true)
    expect(isTransientProviderError(new Error("sdd-tasks returned invalid Markdown"))).toBe(false)
    const circular = new Error("HTTP 429")
    circular.cause = circular
    expect(isTransientProviderError(circular)).toBe(true)
  })
})

describe("Judgment Day", () => {
  it("runs both judges and skips remediation when both pass", async () => {
    const runner = vi.fn(async (agent: string) => {
      if (agent.startsWith("jd-judge")) return `No defects.\n[PASS]`
      throw new Error("fix agent should not run")
    })

    const result = await judgmentDayWithRunner(runner, "diff", "task")

    expect(result.passed).toBe(true)
    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls.map(([agent]) => agent).sort()).toEqual([
      "jd-judge-a",
      "jd-judge-b",
    ])
  })

  it("asks the fix agent for a plan when either judge fails", async () => {
    const runner = vi.fn(async (agent: string) => {
      if (agent === "jd-judge-a") return "[PASS]"
      if (agent === "jd-judge-b") return "Missing test.\n[FAIL]"
      return "1. Add the missing regression test."
    })

    const result = await judgmentDayWithRunner(runner, "diff", "task")

    expect(result.passed).toBe(false)
    expect(result.fixPlan).toContain("regression test")
    expect(runner).toHaveBeenCalledTimes(3)
  })
})

describe("review panel", () => {
  it("runs four specialties and sends every output to the refuter", async () => {
    const runner = vi.fn(async (agent: string, prompt: string) => {
      if (agent === "review-refuter") {
        expect(prompt).toContain("review-risk")
        expect(prompt).toContain("review-readability")
        expect(prompt).toContain("review-reliability")
        expect(prompt).toContain("review-resilience")
        return "[PASS]"
      }
      return `${agent} output`
    })

    const result = await reviewPanelWithRunner(runner, "diff")

    expect(result.ledger).toBe("[PASS]")
    expect(Object.keys(result.reviews)).toHaveLength(4)
    expect(runner).toHaveBeenCalledTimes(5)
  })
})

describe("automatic progress", () => {
  it("publishes clickable worker metadata and durable progress", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "specops-progress-"))
    const change = "observable-run"
    await mkdir(path.join(root, "openspec", "changes", change), { recursive: true })
    const updates: Array<{ title?: string; metadata?: Record<string, unknown> }> = []
    const controller = new AbortController()
    const tracker = new ProgressTracker(
      {
        sessionID: "parent-session",
        metadata(update) {
          updates.push(update)
        },
      },
      root,
      "observable test",
      controller.signal,
    )

    await tracker.setChange(change)
    await tracker.phase(3, "exploration", "Explore", ["sdd-explore"])
    await tracker.reporter({
      agent: "sdd-explore",
      sessionID: "child-session",
      attempt: 1,
      state: "running",
      startedAt: new Date().toISOString(),
      elapsedMs: 1200,
    })
    await tracker.finish("cancelled", "test interrupt")

    const latest = updates.at(-1)
    expect(latest?.metadata?.parentSessionId).toBe("parent-session")
    expect(latest?.metadata?.sessionId).toBe("child-session")
    expect(latest?.title).toContain("Explore")
    const progress = JSON.parse(
      await readFile(
        path.join(root, "openspec", "changes", change, "specops-progress.json"),
        "utf-8",
      ),
    )
    expect(progress.state).toBe("cancelled")
    expect(progress.phase.id).toBe("exploration")
    expect(progress.workers[0].sessionID).toBe("child-session")
  })
})

import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../src/agents/ids.js";
import { COMMANDS } from "../src/commands.js";

/** Tests the deliberately small V1 public command boundary. */
describe("V1 public commands", () => {
  it("exposes exactly the five supported interactive commands", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual([
      "specops",
      "specops-cancel",
      "specops-doctor",
      "specops-onboard",
      "specops-status",
    ]);
  });

  it("routes the workflow entrypoint to the V1 coordinator", () => {
    expect(COMMANDS.specops.agent).toBe(AGENT_IDS.coordinator);
    expect(COMMANDS.specops.subtask).toBe(false);
  });

  it("does not expose automatic mode or a separate archive command", () => {
    expect(COMMANDS).not.toHaveProperty("specops-auto");
    expect(COMMANDS).not.toHaveProperty("specops-archive");
  });
});

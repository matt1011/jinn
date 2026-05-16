import { describe, expect, it } from "vitest";
import { buildClaudeSyncTranscriptPrompt } from "../syncPrompt.js";

describe("buildClaudeSyncTranscriptPrompt", () => {
  it("prioritizes implementation completion over broad gap analysis", () => {
    const prompt = buildClaudeSyncTranscriptPrompt([
      "USER: please finish the remaining error-state work",
      "ASSISTANT: I found several possible gaps",
    ]);

    expect(prompt).toContain("This work has already been attempted");
    expect(prompt).toContain("inspect the current codebase state");
    expect(prompt).toContain("Do not spend the turn broadly re-auditing for gaps");
    expect(prompt).toContain("spend most of your effort finishing the requested development");
    expect(prompt).toContain("USER: please finish the remaining error-state work");
  });
});

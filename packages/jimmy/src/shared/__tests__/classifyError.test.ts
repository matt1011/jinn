import { describe, it, expect } from "vitest";
import { classifyError, RECOVERABLE_KINDS, BUFFER_MS } from "../rateLimit.js";
import type { EngineResult } from "../types.js";

const baseResult = (over: Partial<EngineResult> = {}): EngineResult => ({
  sessionId: "test-session",
  result: "",
  cost: 0,
  numTurns: 0,
  ...over,
});

describe("classifyError — constants and contract", () => {
  it("exports BUFFER_MS = 2 minutes", () => {
    expect(BUFFER_MS).toBe(2 * 60_000);
  });

  it("recoverable kinds are exactly rate_limited and usage_cap", () => {
    expect([...RECOVERABLE_KINDS].sort()).toEqual(["rate_limited", "usage_cap"]);
  });

  it("returns unknown for an unrecognised error string", () => {
    const result = baseResult({ error: "totally novel failure", cost: 1, numTurns: 1 });
    const c = classifyError(result, "codex");
    expect(c.kind).toBe("unknown");
    expect(c.recoverable).toBe(false);
  });

  it("returns unknown when there is no error at all", () => {
    // Omit `error` entirely — it's optional (undefined).
    const c = classifyError(baseResult({}), "codex");
    expect(c.kind).toBe("unknown");
  });
});

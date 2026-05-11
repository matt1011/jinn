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

describe("classifyError — rate_limited", () => {
  it("classifies HTTP 429 text", () => {
    const c = classifyError(baseResult({ error: "HTTP 429 too many requests" }), "codex");
    expect(c.kind).toBe("rate_limited");
    expect(c.recoverable).toBe(true);
  });

  it("classifies 'overloaded' as rate_limited", () => {
    const c = classifyError(baseResult({ error: "Service is overloaded, try again" }), "claude");
    expect(c.kind).toBe("rate_limited");
  });

  it("classifies rateLimit.status=rejected as rate_limited even without text", () => {
    const c = classifyError(
      baseResult({ rateLimit: { status: "rejected", resetsAt: 1778500000 } }),
      "claude",
    );
    expect(c.kind).toBe("rate_limited");
  });

  it("does NOT classify 'exceeded the request body limit' as rate_limited (regex tightening)", () => {
    const c = classifyError(
      baseResult({ error: "exceeded the request body limit of 10 MB" }),
      "codex",
    );
    expect(c.kind).toBe("unknown");
  });

  it("still classifies 'exceeded the rate limit' as rate_limited", () => {
    const c = classifyError(baseResult({ error: "exceeded the rate limit" }), "codex");
    expect(c.kind).toBe("rate_limited");
  });
});

describe("classifyError — usage_cap", () => {
  it("classifies real-world Codex usage-cap message", () => {
    const c = classifyError(
      baseResult({
        error:
          "Error running remote compact task: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 7:10 AM.",
      }),
      "codex",
    );
    expect(c.kind).toBe("usage_cap");
    expect(c.recoverable).toBe(true);
  });

  it("classifies 'credits exhausted' as usage_cap", () => {
    const c = classifyError(baseResult({ error: "credits exhausted for the day" }), "codex");
    expect(c.kind).toBe("usage_cap");
  });

  it("classifies 'quota exhausted' as usage_cap", () => {
    const c = classifyError(baseResult({ error: "quota exhausted on plan" }), "gemini");
    expect(c.kind).toBe("usage_cap");
  });

  it("classifies mixed phrasing 'rate limit + usage limit' as usage_cap (precedence lock)", () => {
    const c = classifyError(
      baseResult({ error: "rate limit reached — you've hit your usage limit" }),
      "codex",
    );
    expect(c.kind).toBe("usage_cap");
  });
});

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpHome = mkdtempSync(path.join(tmpdir(), "jinn-mgr-classify-"));
process.env.JINN_HOME = tmpHome;
mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });

import { describe, it, expect, afterAll } from "vitest";
import { createSession, getSession } from "../registry.js";
import { applyEngineErrorToSession } from "../manager.js";

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("applyEngineErrorToSession", () => {
  it("populates errorKind, recoverable, and retryAfter on usage-cap error", () => {
    const s = createSession({
      engine: "codex", source: "cron", sourceRef: "j1", sessionKey: "j1", connector: "cron",
    } as Parameters<typeof createSession>[0]);

    applyEngineErrorToSession(s.id, "codex", {
      sessionId: s.id,
      result: "",
      error: "hit your usage limit; try again at 7:10 AM",
      cost: 0,
      numTurns: 0,
    });

    const loaded = getSession(s.id);
    expect(loaded?.status).toBe("error");
    expect(loaded?.errorKind).toBe("usage_cap");
    expect(loaded?.errorRecoverable).toBe(true);
    expect(loaded?.errorRetryAfter).toBeTruthy();
    expect(loaded?.errorDetectedFrom).toBe("engine_result");
    expect(loaded?.lastError).toContain("usage limit");
  });

  it("marks engine_crashed as non-recoverable with null retryAfter", () => {
    const s = createSession({
      engine: "codex", source: "web", sourceRef: "w1", sessionKey: "w1", connector: "web",
    } as Parameters<typeof createSession>[0]);

    applyEngineErrorToSession(s.id, "codex", {
      sessionId: s.id,
      result: "",
      error: "segmentation fault",
      cost: 0.01,
      numTurns: 2,
    });

    const loaded = getSession(s.id);
    expect(loaded?.status).toBe("error");
    expect(loaded?.errorKind).toBe("engine_crashed");
    expect(loaded?.errorRecoverable).toBe(false);
    expect(loaded?.errorRetryAfter).toBeNull();
  });

  it("handles dead_session non-recoverable cleanly", () => {
    const s = createSession({
      engine: "codex", source: "web", sourceRef: "w2", sessionKey: "w2", connector: "web",
    } as Parameters<typeof createSession>[0]);

    applyEngineErrorToSession(s.id, "codex", {
      sessionId: s.id,
      result: "",
      error: "session expired",
      cost: 0,
      numTurns: 0,
    });

    const loaded = getSession(s.id);
    expect(loaded?.errorKind).toBe("dead_session");
    expect(loaded?.errorRecoverable).toBe(false);
  });

  it("returns the classification for caller inspection", () => {
    const s = createSession({
      engine: "codex", source: "web", sourceRef: "w3", sessionKey: "w3", connector: "web",
    } as Parameters<typeof createSession>[0]);

    const result = applyEngineErrorToSession(s.id, "codex", {
      sessionId: s.id,
      result: "",
      error: "rate limit exceeded the rate limit",
      cost: 0,
      numTurns: 0,
    });

    expect(result.classification.kind).toBe("rate_limited");
    expect(result.classification.recoverable).toBe(true);
  });
});

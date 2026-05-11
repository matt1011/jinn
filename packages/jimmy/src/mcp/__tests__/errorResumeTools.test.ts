import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpHome = mkdtempSync(path.join(tmpdir(), "jinn-mcp-"));
process.env.JINN_HOME = tmpHome;
mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });

import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import {
  createSession, updateSession, enqueueAutoResume, getSession,
} from "../../sessions/registry.js";
import { mcpHandleTool } from "../gateway-server.js";
import { setAutoResumeDispatcher } from "../../sessions/autoResumer.js";

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

const dispatched: Array<{ id: string; nudge: string }> = [];
beforeAll(() => {
  // Inject a fake dispatcher so jinn_resume_session has something to call.
  setAutoResumeDispatcher(async (id, nudge) => {
    dispatched.push({ id, nudge });
  });
});

describe("MCP tool — jinn_list_recoverable_sessions", () => {
  it("returns sessions in recoverable error state", async () => {
    const s = createSession({
      engine: "codex", source: "cron", sourceRef: "mcp-1", sessionKey: "mcp-1", connector: "cron",
    } as Parameters<typeof createSession>[0]);
    updateSession(s.id, {
      status: "error", lastError: "hit your usage limit",
      errorKind: "usage_cap", errorRecoverable: true,
      errorRetryAfter: new Date(Date.now() + 60_000).toISOString(),
    } as Parameters<typeof updateSession>[1]);

    const text = await mcpHandleTool("jinn_list_recoverable_sessions", {});
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    const found = parsed.find((p: { sessionId: string }) => p.sessionId === s.id);
    expect(found).toBeDefined();
    expect(found.errorKind).toBe("usage_cap");
  });
});

describe("MCP tool — jinn_get_session_error", () => {
  it("returns structured fields including auto-resume info", async () => {
    const s = createSession({
      engine: "codex", source: "cron", sourceRef: "mcp-2", sessionKey: "mcp-2", connector: "cron",
    } as Parameters<typeof createSession>[0]);
    const retry = new Date(Date.now() + 60_000).toISOString();
    updateSession(s.id, {
      status: "error", lastError: "hit your usage limit",
      errorKind: "usage_cap", errorRecoverable: true, errorRetryAfter: retry,
    } as Parameters<typeof updateSession>[1]);
    enqueueAutoResume({ sessionId: s.id, fireAt: retry, nudge: "keep going" });

    const text = await mcpHandleTool("jinn_get_session_error", { sessionId: s.id });
    const parsed = JSON.parse(text);
    expect(parsed.sessionId).toBe(s.id);
    expect(parsed.errorKind).toBe("usage_cap");
    expect(parsed.errorRecoverable).toBe(true);
    expect(parsed.errorRetryAfter).toBe(retry);
    expect(parsed.autoResumeScheduledAt).toBe(retry);
    expect(parsed.autoResumeNudge).toBe("keep going");
  });

  it("throws for unknown session", async () => {
    await expect(mcpHandleTool("jinn_get_session_error", { sessionId: "nope" })).rejects.toThrow(/session not found/);
  });
});

describe("MCP tool — jinn_resume_session", () => {
  it("resumes the session, preserving engineSessionId, and dispatches the nudge", async () => {
    const s = createSession({
      engine: "codex", source: "cron", sourceRef: "mcp-3", sessionKey: "mcp-3", connector: "cron",
    } as Parameters<typeof createSession>[0]);
    updateSession(s.id, {
      status: "error", lastError: "usage cap", errorKind: "usage_cap",
      errorRecoverable: true, errorRetryAfter: new Date(Date.now() + 60_000).toISOString(),
      engineSessionId: "engine-thread-xyz",
    } as Parameters<typeof updateSession>[1]);

    dispatched.length = 0;
    const text = await mcpHandleTool("jinn_resume_session", { sessionId: s.id, nudge: "go on" });
    const parsed = JSON.parse(text);
    expect(parsed.sessionId).toBe(s.id);
    expect(parsed.dispatched).toBe(true);

    expect(getSession(s.id)?.engineSessionId).toBe("engine-thread-xyz");
    expect(dispatched).toEqual([{ id: s.id, nudge: "go on" }]);
  });

  it("defaults nudge to 'keep going' when omitted", async () => {
    const s = createSession({
      engine: "codex", source: "cron", sourceRef: "mcp-4", sessionKey: "mcp-4", connector: "cron",
    } as Parameters<typeof createSession>[0]);
    updateSession(s.id, {
      status: "error", lastError: "x",
    } as Parameters<typeof updateSession>[1]);

    dispatched.length = 0;
    await mcpHandleTool("jinn_resume_session", { sessionId: s.id });
    expect(dispatched).toEqual([{ id: s.id, nudge: "keep going" }]);
  });
});

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpHome = mkdtempSync(path.join(tmpdir(), "jinn-resume-api-"));
process.env.JINN_HOME = tmpHome;
mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });

import { describe, it, expect, afterAll, vi } from "vitest";
import { createSession, updateSession, getSession } from "../../sessions/registry.js";
import { enqueueAutoResume, getAutoResumeForSession } from "../../sessions/registry.js";
import { handleResumeRequest, handleListRecoverable } from "../api.js";

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("POST /api/sessions/:id/resume — handler", () => {
  it("404s on unknown session", async () => {
    const mockDispatch = vi.fn(async () => undefined);
    const res = await handleResumeRequest("nonexistent-id", {}, { dispatchMessage: mockDispatch });
    expect(res.status).toBe(404);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("409s when session is running", async () => {
    const mockDispatch = vi.fn(async () => undefined);
    const s = createSession({
      engine: "codex", source: "web", sourceRef: "rapi-1", sessionKey: "rapi-1", connector: "web",
    } as Parameters<typeof createSession>[0]);
    updateSession(s.id, { status: "running" } as Parameters<typeof updateSession>[1]);

    const res = await handleResumeRequest(s.id, {}, { dispatchMessage: mockDispatch });
    expect(res.status).toBe(409);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("409s when session is idle (nothing to resume)", async () => {
    const mockDispatch = vi.fn(async () => undefined);
    const s = createSession({
      engine: "codex", source: "web", sourceRef: "rapi-1b", sessionKey: "rapi-1b", connector: "web",
    } as Parameters<typeof createSession>[0]);
    // status defaults to "idle" on creation
    const res = await handleResumeRequest(s.id, {}, { dispatchMessage: mockDispatch });
    expect(res.status).toBe(409);
  });

  it("clears error fields, preserves engineSessionId by default, dispatches nudge", async () => {
    const mockDispatch = vi.fn(async () => undefined);
    const s = createSession({
      engine: "codex", source: "web", sourceRef: "rapi-2", sessionKey: "rapi-2", connector: "web",
    } as Parameters<typeof createSession>[0]);
    updateSession(s.id, {
      status: "error",
      lastError: "hit your usage limit",
      errorKind: "usage_cap",
      errorRecoverable: true,
      errorRetryAfter: new Date(Date.now() + 60_000).toISOString(),
      errorDetectedFrom: "engine_result",
      engineSessionId: "engine-thread-abc",
    } as Parameters<typeof updateSession>[1]);

    const res = await handleResumeRequest(s.id, { nudge: "go on" }, { dispatchMessage: mockDispatch });
    expect(res.status).toBe(200);

    const loaded = getSession(s.id);
    expect(loaded?.lastError).toBeNull();
    expect(loaded?.errorKind).toBeUndefined();
    expect(loaded?.errorRecoverable).toBeUndefined();
    expect(loaded?.engineSessionId).toBe("engine-thread-abc"); // preserved
    expect(mockDispatch).toHaveBeenCalledWith(s.id, "go on");
  });

  it("preserveEngineSession=false clears engineSessionId", async () => {
    const mockDispatch = vi.fn(async () => undefined);
    const s = createSession({
      engine: "codex", source: "web", sourceRef: "rapi-3", sessionKey: "rapi-3", connector: "web",
    } as Parameters<typeof createSession>[0]);
    updateSession(s.id, {
      status: "error", lastError: "x", engineSessionId: "engine-thread-abc",
    } as Parameters<typeof updateSession>[1]);

    const res = await handleResumeRequest(
      s.id,
      { nudge: "go", preserveEngineSession: false },
      { dispatchMessage: mockDispatch },
    );
    expect(res.status).toBe(200);
    expect(getSession(s.id)?.engineSessionId).toBeNull();
  });

  it("defaults nudge to 'keep going' when omitted", async () => {
    const mockDispatch = vi.fn(async () => undefined);
    const s = createSession({
      engine: "codex", source: "web", sourceRef: "rapi-4", sessionKey: "rapi-4", connector: "web",
    } as Parameters<typeof createSession>[0]);
    updateSession(s.id, { status: "error", lastError: "x" } as Parameters<typeof updateSession>[1]);

    await handleResumeRequest(s.id, {}, { dispatchMessage: mockDispatch });
    expect(mockDispatch).toHaveBeenCalledWith(s.id, "keep going");
  });

  it("rejects empty-string nudge and falls back to default", async () => {
    const mockDispatch = vi.fn(async () => undefined);
    const s = createSession({
      engine: "codex", source: "web", sourceRef: "rapi-5", sessionKey: "rapi-5", connector: "web",
    } as Parameters<typeof createSession>[0]);
    updateSession(s.id, { status: "error", lastError: "x" } as Parameters<typeof updateSession>[1]);

    await handleResumeRequest(s.id, { nudge: "" }, { dispatchMessage: mockDispatch });
    expect(mockDispatch).toHaveBeenCalledWith(s.id, "keep going");
  });
});

describe("GET /api/sessions/recoverable — handler", () => {
  it("returns only sessions where errorRecoverable=true", async () => {
    const a = createSession({
      engine: "codex", source: "cron", sourceRef: "rec-1", sessionKey: "rec-1", connector: "cron",
    } as Parameters<typeof createSession>[0]);
    const b = createSession({
      engine: "codex", source: "web", sourceRef: "rec-2", sessionKey: "rec-2", connector: "web",
    } as Parameters<typeof createSession>[0]);
    const c = createSession({
      engine: "codex", source: "web", sourceRef: "rec-3", sessionKey: "rec-3", connector: "web",
    } as Parameters<typeof createSession>[0]);

    updateSession(a.id, {
      status: "error", lastError: "usage cap", errorKind: "usage_cap",
      errorRecoverable: true, errorRetryAfter: new Date(Date.now() + 60_000).toISOString(),
    } as Parameters<typeof updateSession>[1]);
    updateSession(b.id, {
      status: "error", lastError: "crashed", errorKind: "engine_crashed", errorRecoverable: false,
    } as Parameters<typeof updateSession>[1]);
    // c stays idle

    const res = await handleListRecoverable();
    expect(res.status).toBe(200);
    const list = res.body;
    const ids = list.map((s) => s.sessionId);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(c.id);
    const entry = list.find((s) => s.sessionId === a.id);
    expect(entry?.errorKind).toBe("usage_cap");
    expect(entry?.lastErrorPreview).toContain("usage cap");
  });

  it("includes autoResumeScheduledAt when a pending row exists", async () => {
    const s = createSession({
      engine: "codex", source: "cron", sourceRef: "rec-4", sessionKey: "rec-4", connector: "cron",
    } as Parameters<typeof createSession>[0]);
    const retry = new Date(Date.now() + 60_000).toISOString();
    updateSession(s.id, {
      status: "error", lastError: "usage cap", errorKind: "usage_cap",
      errorRecoverable: true, errorRetryAfter: retry,
    } as Parameters<typeof updateSession>[1]);
    enqueueAutoResume({ sessionId: s.id, fireAt: retry, nudge: "keep going" });

    const res = await handleListRecoverable();
    const entry = res.body.find((x) => x.sessionId === s.id);
    expect(entry?.autoResumeScheduledAt).toBe(retry);
  });
});

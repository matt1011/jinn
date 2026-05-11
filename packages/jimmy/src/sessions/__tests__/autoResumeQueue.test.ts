import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// MUST set before importing registry (singleton DB pin)
const tmpHome = mkdtempSync(path.join(tmpdir(), "jinn-autoresume-"));
process.env.JINN_HOME = tmpHome;
mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });

import { describe, it, expect, afterAll } from "vitest";
import {
  enqueueAutoResume,
  cancelAutoResume,
  listPendingAutoResumes,
  deleteAutoResume,
  getAutoResumeForSession,
} from "../registry.js";

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("auto_resume_queue", () => {
  it("enqueues a pending entry and lists it", () => {
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    const id = enqueueAutoResume({ sessionId: "task9-s1", fireAt, nudge: "keep going" });
    expect(id).toBeTruthy();

    const pending = listPendingAutoResumes();
    const entry = pending.find((r) => r.sessionId === "task9-s1");
    expect(entry).toBeDefined();
    expect(entry?.nudge).toBe("keep going");
    expect(entry?.fireAt).toBe(fireAt);
  });

  it("cancellation removes from pending list", () => {
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    enqueueAutoResume({ sessionId: "task9-s2", fireAt, nudge: "keep going" });
    cancelAutoResume("task9-s2");
    const pending = listPendingAutoResumes();
    expect(pending.find((r) => r.sessionId === "task9-s2")).toBeUndefined();
  });

  it("getAutoResumeForSession returns the active entry", () => {
    const fireAt = new Date(Date.now() + 90_000).toISOString();
    enqueueAutoResume({ sessionId: "task9-s3", fireAt, nudge: "go" });
    const active = getAutoResumeForSession("task9-s3");
    expect(active?.fireAt).toBe(fireAt);
    expect(active?.nudge).toBe("go");
  });

  it("deleteAutoResume removes by id", () => {
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    const id = enqueueAutoResume({ sessionId: "task9-s4", fireAt, nudge: "x" });
    deleteAutoResume(id);
    expect(getAutoResumeForSession("task9-s4")).toBeNull();
  });

  it("re-enqueuing the same session cancels the previous pending entry", () => {
    const fireAt1 = new Date(Date.now() + 60_000).toISOString();
    const fireAt2 = new Date(Date.now() + 120_000).toISOString();
    enqueueAutoResume({ sessionId: "task9-s5", fireAt: fireAt1, nudge: "first" });
    enqueueAutoResume({ sessionId: "task9-s5", fireAt: fireAt2, nudge: "second" });
    const active = getAutoResumeForSession("task9-s5");
    expect(active?.fireAt).toBe(fireAt2);
    expect(active?.nudge).toBe("second");
    // Only the latest is pending
    const pending = listPendingAutoResumes().filter((r) => r.sessionId === "task9-s5");
    expect(pending).toHaveLength(1);
  });
});

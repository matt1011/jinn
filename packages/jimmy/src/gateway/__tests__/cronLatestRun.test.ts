import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpHome = mkdtempSync(path.join(tmpdir(), "jinn-cron-run-"));
process.env.JINN_HOME = tmpHome;
mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });
mkdirSync(path.join(tmpHome, "cron", "runs"), { recursive: true });

import { describe, it, expect, afterAll } from "vitest";
import { handleListCronJobs } from "../api.js";
import { createSession, updateSession, enqueueAutoResume } from "../../sessions/registry.js";
import { appendRunLog } from "../../cron/jobs.js";

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("GET /api/cron — latestRun summary", () => {
  it("includes errorKind and autoResumeScheduledAt when latest run is recoverable error", async () => {
    const s = createSession({
      engine: "codex", source: "cron", sourceRef: "jobX", sessionKey: "jobX", connector: "cron",
    } as Parameters<typeof createSession>[0]);
    const retry = new Date(Date.now() + 60_000).toISOString();
    updateSession(s.id, {
      status: "error", lastError: "x",
      errorKind: "usage_cap", errorRecoverable: true, errorRetryAfter: retry,
    } as Parameters<typeof updateSession>[1]);
    enqueueAutoResume({ sessionId: s.id, fireAt: retry, nudge: "keep going" });

    appendRunLog("jobX", {
      timestamp: new Date().toISOString(), sessionKey: "k", sessionId: s.id,
      status: "success", durationMs: 60_000, error: null, resultPreview: null,
    });

    const result = await handleListCronJobs([
      { id: "jobX", name: "X", enabled: true, schedule: "0 0 * * *", prompt: "x" },
    ]);
    const jobs = result.body as Array<{ id: string; latestRun?: { errorKind?: string; autoResumeScheduledAt?: string | null } }>;
    const job = jobs.find((j) => j.id === "jobX");
    expect(job?.latestRun?.errorKind).toBe("usage_cap");
    expect(job?.latestRun?.autoResumeScheduledAt).toBe(retry);
  });

  it("returns job unchanged when no run history exists", async () => {
    const result = await handleListCronJobs([
      { id: "noRuns", name: "No Runs", enabled: true, schedule: "0 0 * * *", prompt: "x" },
    ]);
    const jobs = result.body as Array<{ id: string; latestRun?: unknown }>;
    expect(jobs[0].latestRun).toBeUndefined();
  });
});

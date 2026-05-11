import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpHome = mkdtempSync(path.join(tmpdir(), "jinn-ar-"));
process.env.JINN_HOME = tmpHome;
mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });

import { describe, it, expect, afterAll } from "vitest";
import { createSession, getAutoResumeForSession } from "../registry.js";
import {
  resolveAutoResume,
  scheduleAutoResume,
  cancelScheduledAutoResume,
} from "../autoResumer.js";
import type { JinnConfig, CronJob, Employee } from "../../shared/types.js";

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

const minimalConfig = (): JinnConfig =>
  ({
    jinn: { version: "0.10.0" },
    gateway: { port: 7777, host: "127.0.0.1" },
    engines: { default: "codex", codex: {}, claude: {}, gemini: {} },
    connectors: {},
    logging: { file: false, stdout: false, level: "info" },
  } as unknown as JinnConfig);

describe("resolveAutoResume — precedence", () => {
  it("rate_limited defaults to true globally", () => {
    const r = resolveAutoResume({ kind: "rate_limited", config: minimalConfig() });
    expect(r.enabled).toBe(true);
    expect(r.nudge).toBe("keep going");
  });

  it("usage_cap defaults to false globally", () => {
    const r = resolveAutoResume({ kind: "usage_cap", config: minimalConfig() });
    expect(r.enabled).toBe(false);
  });

  it("non-recoverable kinds always disabled", () => {
    const r = resolveAutoResume({ kind: "engine_crashed", config: minimalConfig() });
    expect(r.enabled).toBe(false);
  });

  it("cron job > employee > global precedence", () => {
    const cfg = minimalConfig();
    cfg.sessions = { autoResumeOnUsageCap: false, autoResumeNudge: "global" };
    const emp = {
      name: "codex-engineer",
      displayName: "Codex Engineer",
      department: "engineering",
      rank: "senior",
      engine: "codex",
      model: "gpt-5.5",
      persona: "",
      autoResumeOnUsageCap: false,
      autoResumeNudge: "employee",
    } as Employee;
    const job = {
      id: "j",
      name: "j",
      enabled: true,
      schedule: "0 0 * * *",
      prompt: "",
      autoResumeOnUsageCap: true,
      autoResumeNudge: "job-specific",
    } as CronJob;

    const r = resolveAutoResume({
      kind: "usage_cap",
      config: cfg,
      employee: emp,
      cronJob: job,
    });
    expect(r.enabled).toBe(true);
    expect(r.nudge).toBe("job-specific");
  });

  it("employee beats global when no cron job", () => {
    const cfg = minimalConfig();
    cfg.sessions = { autoResumeOnUsageCap: false };
    const emp = {
      name: "codex-engineer",
      displayName: "Codex Engineer",
      department: "engineering",
      rank: "senior",
      engine: "codex",
      model: "gpt-5.5",
      persona: "",
      autoResumeOnUsageCap: true,
      autoResumeNudge: "employee-nudge",
    } as Employee;

    const r = resolveAutoResume({ kind: "usage_cap", config: cfg, employee: emp });
    expect(r.enabled).toBe(true);
    expect(r.nudge).toBe("employee-nudge");
  });

  it("global override works when no per-target config", () => {
    const cfg = minimalConfig();
    cfg.sessions = { autoResumeOnUsageCap: true };
    const r = resolveAutoResume({ kind: "usage_cap", config: cfg });
    expect(r.enabled).toBe(true);
  });
});

describe("scheduleAutoResume — persistence", () => {
  it("writes a queue row when called", () => {
    const s = createSession({
      engine: "codex",
      source: "cron",
      sourceRef: "ar1",
      sessionKey: "ar1",
      connector: "cron",
    } as Parameters<typeof createSession>[0]);

    scheduleAutoResume({
      sessionId: s.id,
      fireAt: new Date(Date.now() + 60_000),
      nudge: "keep going",
    });

    const ar = getAutoResumeForSession(s.id);
    expect(ar).not.toBeNull();
    expect(ar?.nudge).toBe("keep going");
  });

  it("cancelScheduledAutoResume marks row cancelled", () => {
    const s = createSession({
      engine: "codex",
      source: "cron",
      sourceRef: "ar2",
      sessionKey: "ar2",
      connector: "cron",
    } as Parameters<typeof createSession>[0]);
    scheduleAutoResume({
      sessionId: s.id,
      fireAt: new Date(Date.now() + 60_000),
      nudge: "x",
    });
    cancelScheduledAutoResume(s.id);
    expect(getAutoResumeForSession(s.id)).toBeNull();
  });
});

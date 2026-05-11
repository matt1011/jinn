import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

// Point initDb to a temp directory BEFORE importing registry. The
// SESSIONS_DB constant in shared/paths.ts is computed at import time, so
// JINN_HOME must be set before we touch any module that imports it.
const tmpHome = path.join(os.tmpdir(), `jinn-registry-test-${process.pid}`);
mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });
process.env.JINN_HOME = tmpHome;

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  migrateSessionsSchema,
  createSession,
  updateSession,
  getSession,
} from "../registry.js";

describe("migrateSessionsSchema — error classification columns", () => {
  it("adds error_kind, error_recoverable, error_retry_after, error_detected_from columns", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      engine TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_activity TEXT NOT NULL
    )`);

    migrateSessionsSchema(db);

    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("error_kind")).toBe(true);
    expect(names.has("error_recoverable")).toBe(true);
    expect(names.has("error_retry_after")).toBe(true);
    expect(names.has("error_detected_from")).toBe(true);

    db.close();
  });

  it("is idempotent — second run does not error", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      engine TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_activity TEXT NOT NULL
    )`);
    migrateSessionsSchema(db);
    expect(() => migrateSessionsSchema(db)).not.toThrow();
    db.close();
  });
});

describe("registry — error fields roundtrip", () => {
  it("writes and reads errorKind, errorRecoverable, errorRetryAfter, errorDetectedFrom", () => {
    const created = createSession({
      engine: "codex",
      source: "cron",
      sourceRef: "test-job-roundtrip",
      sessionKey: "test-roundtrip",
      connector: "cron",
    });

    updateSession(created.id, {
      status: "error",
      lastError: "hit your usage limit; try again at 7:10 AM",
      errorKind: "usage_cap",
      errorRecoverable: true,
      errorRetryAfter: "2026-05-11T07:12:00-04:00",
      errorDetectedFrom: "engine_result",
    });

    const loaded = getSession(created.id);
    expect(loaded?.errorKind).toBe("usage_cap");
    expect(loaded?.errorRecoverable).toBe(true);
    expect(loaded?.errorRetryAfter).toBe("2026-05-11T07:12:00-04:00");
    expect(loaded?.errorDetectedFrom).toBe("engine_result");
  });

  it("undefined error fields stay undefined/null after read", () => {
    const created = createSession({
      engine: "codex",
      source: "web",
      sourceRef: "w1-no-error",
      sessionKey: "w1-no-error",
      connector: "web",
    });

    const loaded = getSession(created.id);
    expect(loaded?.errorKind).toBeUndefined();
    expect(loaded?.errorRecoverable).toBeUndefined();
    // rowToSession returns null for missing errorRetryAfter (consistent with lastError handling)
    expect(loaded?.errorRetryAfter ?? null).toBeNull();
    expect(loaded?.errorDetectedFrom).toBeUndefined();
  });
});

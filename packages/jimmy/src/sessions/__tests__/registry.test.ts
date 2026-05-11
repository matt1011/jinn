import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrateSessionsSchema } from "../registry.js";

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

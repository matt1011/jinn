import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractRetryAfter, BUFFER_MS } from "../rateLimit.js";

describe("extractRetryAfter", () => {
  const FIXED_NOW = new Date("2026-05-11T08:28:00-04:00"); // 04:28 ET — captures the real overnight failure

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses an ISO-8601 timestamp embedded in the text and adds +2 min buffer", () => {
    const result = extractRetryAfter(
      "Quota resets at 2026-05-11T09:00:00-04:00, sorry",
      "usage_cap",
      "codex",
    );
    expect(result).not.toBeNull();
    expect(result!.getTime()).toBe(new Date("2026-05-11T09:02:00-04:00").getTime());
  });

  it("bumps a past timestamp to now + max(buffer, 5 minutes)", () => {
    // 7:10 AM today with current time 08:28 → in the past for today; should bump forward.
    const result = extractRetryAfter("try again at 7:10 AM", "usage_cap", "codex");
    expect(result).not.toBeNull();
    const lowerBound = FIXED_NOW.getTime() + 5 * 60_000;
    expect(result!.getTime()).toBeGreaterThanOrEqual(lowerBound);
  });

  it("returns null when no timestamp and no engine config is supplied", () => {
    const result = extractRetryAfter("something went wrong", "engine_crashed", "codex");
    expect(result).toBeNull();
  });

  it("always applies +2 min buffer to ISO timestamps", () => {
    const isoTime = "2026-05-11T09:00:00-04:00";
    const result = extractRetryAfter(`Retry-After: ${isoTime}`, "rate_limited", "claude");
    expect(result).not.toBeNull();
    expect(result!.getTime()).toBe(new Date(isoTime).getTime() + BUFFER_MS);
  });

  it("returns null for empty error text", () => {
    expect(extractRetryAfter("", "rate_limited", "codex")).toBeNull();
  });

  it("parses 'try again at H:MM PM' (afternoon) and adds buffer", () => {
    // FIXED_NOW is 04:28 ET; "try again at 5:30 PM" should be later today.
    const result = extractRetryAfter("try again at 5:30 PM", "usage_cap", "codex");
    expect(result).not.toBeNull();
    // 17:30 + 2 min = 17:32
    const expected = new Date("2026-05-11T17:32:00-04:00").getTime();
    expect(result!.getTime()).toBe(expected);
  });

  it("parses 'try again at 12:00 PM' as noon", () => {
    const result = extractRetryAfter("try again at 12:00 PM", "usage_cap", "codex");
    expect(result).not.toBeNull();
    // 12:00 + 2 min = 12:02
    const expected = new Date("2026-05-11T12:02:00-04:00").getTime();
    expect(result!.getTime()).toBe(expected);
  });

  it("parses 'try again at 12:00 AM' as midnight (next day if past)", () => {
    // Midnight is in the past relative to FIXED_NOW (08:28 ET) → clamped to now + max(buffer, 5min)
    const result = extractRetryAfter("try again at 12:00 AM", "usage_cap", "codex");
    expect(result).not.toBeNull();
    const lowerBound = FIXED_NOW.getTime() + 5 * 60_000;
    expect(result!.getTime()).toBeGreaterThanOrEqual(lowerBound);
  });
});

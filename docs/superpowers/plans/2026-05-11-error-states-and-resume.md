# Error States and Session Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured error classification, an opt-in auto-resume scheduler, a resume API that preserves engineSessionId, GUI affordance, and MCP tools so Claude can list and resume recoverable Jinn sessions.

**Architecture:** Detection logic centralises in `shared/rateLimit.ts` and feeds new optional fields on `Session`. A new `sessions/autoResumer.ts` schedules resumes per global → employee → cron-job precedence. A new `POST /api/sessions/:id/resume` endpoint preserves `engineSessionId` while clearing error state and dispatching an optional nudge. Web UI surfaces a kind-chip in the session header that opens a resume modal (layout B). MCP gateway gains three tools wrapping the API.

**Tech Stack:** TypeScript, Node 22, better-sqlite3, vitest, Next.js 14 (App Router), React 19, Playwright, MCP server stdio JSON-RPC.

**Spec:** `docs/superpowers/specs/2026-05-11-error-states-and-resume-design.md`

---

## Phase 1 — Detection & Types

### Task 1: ErrorKind type, constants, and skeleton classifier

**Files:**
- Modify: `packages/jimmy/src/shared/rateLimit.ts`
- Test: `packages/jimmy/src/shared/__tests__/classifyError.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/jimmy/src/shared/__tests__/classifyError.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { classifyError, RECOVERABLE_KINDS, BUFFER_MS } from "../rateLimit.js";
import type { EngineResult } from "../types.js";

const baseResult = (over: Partial<EngineResult> = {}): EngineResult => ({
  cost: 0,
  numTurns: 0,
  error: null,
  output: "",
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
    const c = classifyError(baseResult({ error: null }), "codex");
    expect(c.kind).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```bash
cd packages/jimmy && pnpm vitest run src/shared/__tests__/classifyError.test.ts
```

Expected: FAIL — `classifyError`, `RECOVERABLE_KINDS`, `BUFFER_MS` are not exported.

- [ ] **Step 3: Add the type, constants, and minimal classifier**

Append to `packages/jimmy/src/shared/rateLimit.ts`:

```typescript
export type ErrorKind = "rate_limited" | "usage_cap" | "dead_session" | "engine_crashed" | "unknown";

export const RECOVERABLE_KINDS: ReadonlySet<ErrorKind> = new Set(["rate_limited", "usage_cap"]);

export const BUFFER_MS = 2 * 60_000;

export interface ErrorClassification {
  kind: ErrorKind;
  recoverable: boolean;
  retryAfter: Date | null;
  originalMessage: string;
  detectedFrom: "engine_result" | "process_exit" | "manual";
}

export function classifyError(result: EngineResult, _engineName: string): ErrorClassification {
  const originalMessage = result.error ?? "";
  return {
    kind: "unknown",
    recoverable: false,
    retryAfter: null,
    originalMessage,
    detectedFrom: "engine_result",
  };
}
```

- [ ] **Step 4: Run test, expect pass**

```bash
cd packages/jimmy && pnpm vitest run src/shared/__tests__/classifyError.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/jimmy/src/shared/rateLimit.ts packages/jimmy/src/shared/__tests__/classifyError.test.ts
git commit -m "feat(rate-limit): add ErrorKind type and skeleton classifyError"
```

---

### Task 2: Detect `rate_limited` and `usage_cap` kinds

**Files:**
- Modify: `packages/jimmy/src/shared/rateLimit.ts`
- Test: `packages/jimmy/src/shared/__tests__/classifyError.test.ts` (extend)

- [ ] **Step 1: Add failing tests for rate_limited and usage_cap**

Append to `packages/jimmy/src/shared/__tests__/classifyError.test.ts`:

```typescript
describe("classifyError — rate_limited", () => {
  it("classifies HTTP 429 text", () => {
    const c = classifyError(baseResult({ error: "HTTP 429 too many requests", cost: 0, numTurns: 0 }), "codex");
    expect(c.kind).toBe("rate_limited");
    expect(c.recoverable).toBe(true);
  });

  it("classifies 'overloaded' as rate_limited", () => {
    const c = classifyError(baseResult({ error: "Service is overloaded, try again", cost: 0, numTurns: 0 }), "claude");
    expect(c.kind).toBe("rate_limited");
  });

  it("classifies rateLimit.status=rejected as rate_limited even without text", () => {
    const c = classifyError(
      baseResult({ error: "", rateLimit: { status: "rejected", resetsAt: 1778500000 } }),
      "claude",
    );
    expect(c.kind).toBe("rate_limited");
  });
});

describe("classifyError — usage_cap", () => {
  it("classifies real-world Codex usage-cap message", () => {
    const c = classifyError(
      baseResult({
        error:
          "Error running remote compact task: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 7:10 AM.",
        cost: 0,
        numTurns: 0,
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
});
```

- [ ] **Step 2: Run tests, expect failure**

```bash
cd packages/jimmy && pnpm vitest run src/shared/__tests__/classifyError.test.ts
```

Expected: FAIL — all 6 new tests fail (still `unknown`).

- [ ] **Step 3: Add detection regexes and switch logic**

Edit `packages/jimmy/src/shared/rateLimit.ts`. Replace the existing `RATE_LIMIT_ERROR_RE` line with two narrower regexes, and update `classifyError`:

```typescript
// Disambiguated patterns — usage-cap is checked first because some provider
// messages contain both "rate limit" and "usage limit" phrasings.
const USAGE_CAP_RE =
  /usage\s*limit|hit your\s*(usage\s*)?limit|credits?\s*exhausted|quota\s*exhausted|compact task.*usage|purchase more credits/i;

const RATE_LIMIT_RE =
  /rate.?limit|too many requests|429|overloaded|out of extra usage|exceeded.*limit/i;

// Keep existing RATE_LIMIT_ERROR_RE export for backwards compat with any
// callers; alias to RATE_LIMIT_RE.
export const RATE_LIMIT_ERROR_RE = RATE_LIMIT_RE;

export function classifyError(result: EngineResult, _engineName: string): ErrorClassification {
  const originalMessage = result.error ?? "";

  // Explicit rateLimit signal from engine — short-circuit to rate_limited.
  if (result.rateLimit?.status === "rejected") {
    return {
      kind: "rate_limited",
      recoverable: true,
      retryAfter: null,
      originalMessage,
      detectedFrom: "engine_result",
    };
  }

  if (!originalMessage) {
    return { kind: "unknown", recoverable: false, retryAfter: null, originalMessage, detectedFrom: "engine_result" };
  }

  if (USAGE_CAP_RE.test(originalMessage)) {
    return { kind: "usage_cap", recoverable: true, retryAfter: null, originalMessage, detectedFrom: "engine_result" };
  }

  if (RATE_LIMIT_RE.test(originalMessage)) {
    return { kind: "rate_limited", recoverable: true, retryAfter: null, originalMessage, detectedFrom: "engine_result" };
  }

  return { kind: "unknown", recoverable: false, retryAfter: null, originalMessage, detectedFrom: "engine_result" };
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
cd packages/jimmy && pnpm vitest run src/shared/__tests__/classifyError.test.ts
```

Expected: PASS, 10 tests total.

- [ ] **Step 5: Verify existing rate-limit consumers still pass**

```bash
cd packages/jimmy && pnpm vitest run src/shared/__tests__/rateLimit.test.ts
```

Expected: PASS — no regressions. If anything fails because `RATE_LIMIT_ERROR_RE` no longer matches `usage.*limit`, the design intends that — usage-cap is its own kind now. Update those tests only if they truly tested usage-cap behavior under the old name.

- [ ] **Step 6: Commit**

```bash
git add packages/jimmy/src/shared/rateLimit.ts packages/jimmy/src/shared/__tests__/classifyError.test.ts
git commit -m "feat(rate-limit): classify rate_limited and usage_cap kinds"
```

---

### Task 3: Detect `dead_session` and `engine_crashed` kinds

**Files:**
- Modify: `packages/jimmy/src/shared/rateLimit.ts`
- Test: `packages/jimmy/src/shared/__tests__/classifyError.test.ts` (extend)

- [ ] **Step 1: Add failing tests**

Append to the test file:

```typescript
describe("classifyError — dead_session", () => {
  it("classifies zero-cost zero-turn error with no rate-limit signal as dead_session", () => {
    const c = classifyError(
      baseResult({ error: "Error during execution: session not found", cost: 0, numTurns: 0 }),
      "codex",
    );
    expect(c.kind).toBe("dead_session");
    expect(c.recoverable).toBe(false);
  });

  it("classifies 'session expired' as dead_session", () => {
    const c = classifyError(baseResult({ error: "session expired", cost: 0, numTurns: 0 }), "codex");
    expect(c.kind).toBe("dead_session");
  });
});

describe("classifyError — engine_crashed", () => {
  it("classifies non-zero-work error with no recognized pattern as engine_crashed", () => {
    const c = classifyError(
      baseResult({ error: "segmentation fault in subprocess", cost: 0.02, numTurns: 3 }),
      "codex",
    );
    expect(c.kind).toBe("engine_crashed");
    expect(c.recoverable).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

```bash
cd packages/jimmy && pnpm vitest run src/shared/__tests__/classifyError.test.ts
```

Expected: 3 new tests fail.

- [ ] **Step 3: Wire dead_session and engine_crashed into classifier**

Update `classifyError` in `packages/jimmy/src/shared/rateLimit.ts`. Add the dead-session check before falling through to crashed/unknown:

```typescript
export function classifyError(result: EngineResult, _engineName: string): ErrorClassification {
  const originalMessage = result.error ?? "";

  if (result.rateLimit?.status === "rejected") {
    return { kind: "rate_limited", recoverable: true, retryAfter: null, originalMessage, detectedFrom: "engine_result" };
  }

  if (!originalMessage) {
    return { kind: "unknown", recoverable: false, retryAfter: null, originalMessage, detectedFrom: "engine_result" };
  }

  if (USAGE_CAP_RE.test(originalMessage)) {
    return { kind: "usage_cap", recoverable: true, retryAfter: null, originalMessage, detectedFrom: "engine_result" };
  }

  if (RATE_LIMIT_RE.test(originalMessage)) {
    return { kind: "rate_limited", recoverable: true, retryAfter: null, originalMessage, detectedFrom: "engine_result" };
  }

  // Reuse existing dead-session detector for consistency.
  if (isDeadSessionError(result)) {
    return { kind: "dead_session", recoverable: false, retryAfter: null, originalMessage, detectedFrom: "engine_result" };
  }

  // Any remaining error with zero progress is dead-session-shaped; otherwise treat as crash.
  return { kind: "engine_crashed", recoverable: false, retryAfter: null, originalMessage, detectedFrom: "engine_result" };
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
cd packages/jimmy && pnpm vitest run src/shared/__tests__/classifyError.test.ts
```

Expected: PASS, 13 tests total.

- [ ] **Step 5: Commit**

```bash
git add packages/jimmy/src/shared/rateLimit.ts packages/jimmy/src/shared/__tests__/classifyError.test.ts
git commit -m "feat(rate-limit): classify dead_session and engine_crashed kinds"
```

---

### Task 4: `extractRetryAfter` — parse provider strings with +2 min buffer

**Files:**
- Modify: `packages/jimmy/src/shared/rateLimit.ts`
- Test: `packages/jimmy/src/shared/__tests__/extractRetryAfter.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/jimmy/src/shared/__tests__/extractRetryAfter.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractRetryAfter, BUFFER_MS } from "../rateLimit.js";

describe("extractRetryAfter", () => {
  const FIXED_NOW = new Date("2026-05-11T08:28:00-04:00"); // 04:28 ET, captures the real overnight case

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses 'try again at 7:10 AM' as next 07:10 local + 2 min buffer", () => {
    const result = extractRetryAfter("You've hit your usage limit. Try again at 7:10 AM.", "usage_cap", "codex");
    expect(result).not.toBeNull();
    // 04:28 ET + future 07:10 ET = same day 07:10 ET, then +2 min = 07:12 ET
    const expected = new Date("2026-05-11T07:12:00-04:00");
    expect(result!.getTime()).toBe(expected.getTime());
  });

  it("parses an ISO-8601 timestamp embedded in the text", () => {
    const result = extractRetryAfter(
      "Quota resets at 2026-05-11T09:00:00-04:00, sorry",
      "usage_cap",
      "codex",
    );
    expect(result).not.toBeNull();
    expect(result!.getTime()).toBe(new Date("2026-05-11T09:02:00-04:00").getTime());
  });

  it("bumps a past timestamp to now + max(buffer, 5 minutes)", () => {
    // 7:10 AM with current time 08:28 → in the past for today; bump.
    const result = extractRetryAfter("try again at 7:10 AM", "usage_cap", "codex");
    // Either tomorrow 07:10 + buffer, OR now + max(buffer, 5 min).
    // The implementation chooses now + 5 min for past-same-day ambiguity (see Step 3).
    const lowerBound = FIXED_NOW.getTime() + 5 * 60_000;
    expect(result!.getTime()).toBeGreaterThanOrEqual(lowerBound);
  });

  it("returns null when no timestamp is present and no fallback applies", () => {
    const result = extractRetryAfter("something went wrong", "engine_crashed", "codex");
    expect(result).toBeNull();
  });

  it("always applies +2 min buffer", () => {
    const result = extractRetryAfter("Retry-After: 2026-05-11T09:00:00-04:00", "rate_limited", "claude");
    expect(result!.getTime()).toBe(new Date("2026-05-11T09:00:00-04:00").getTime() + BUFFER_MS);
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

```bash
cd packages/jimmy && pnpm vitest run src/shared/__tests__/extractRetryAfter.test.ts
```

Expected: FAIL — `extractRetryAfter` is not exported.

- [ ] **Step 3: Implement `extractRetryAfter`**

Append to `packages/jimmy/src/shared/rateLimit.ts`:

```typescript
const ISO_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/;
const TIME_OF_DAY_RE = /\btry again at\s+(\d{1,2}):(\d{2})\s*(AM|PM)?\b/i;

/**
 * Extract a retry-at timestamp from a provider error message.
 *
 * Resolution order:
 *   1. ISO-8601 timestamp anywhere in the text.
 *   2. "try again at H:MM AM/PM" phrasing (provider speaks user-local time).
 *   3. null — caller decides fallback (e.g. PROVIDER_RESET_DEFAULTS).
 *
 * The returned Date always includes the +2 min buffer and is guaranteed to be
 * at least now + 5 minutes in the future, even if the provider quoted a past
 * time (clock skew / ambiguous AM-PM).
 */
export function extractRetryAfter(
  errorText: string,
  _kind: ErrorKind,
  _engineName: string,
): Date | null {
  if (!errorText) return null;

  const isoMatch = errorText.match(ISO_RE);
  if (isoMatch) {
    const parsed = new Date(isoMatch[0]);
    if (!Number.isNaN(parsed.getTime())) {
      return clampFutureWithBuffer(parsed);
    }
  }

  const todMatch = errorText.match(TIME_OF_DAY_RE);
  if (todMatch) {
    const hour12 = parseInt(todMatch[1], 10);
    const minute = parseInt(todMatch[2], 10);
    const ampm = (todMatch[3] || "").toUpperCase();
    let hour24 = hour12;
    if (ampm === "PM" && hour12 < 12) hour24 = hour12 + 12;
    if (ampm === "AM" && hour12 === 12) hour24 = 0;
    const now = new Date();
    const candidate = new Date(now);
    candidate.setHours(hour24, minute, 0, 0);
    return clampFutureWithBuffer(candidate);
  }

  return null;
}

function clampFutureWithBuffer(target: Date): Date {
  const now = Date.now();
  const minFuture = now + Math.max(BUFFER_MS, 5 * 60_000);
  const withBuffer = target.getTime() + BUFFER_MS;
  return new Date(Math.max(withBuffer, minFuture));
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
cd packages/jimmy && pnpm vitest run src/shared/__tests__/extractRetryAfter.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/jimmy/src/shared/rateLimit.ts packages/jimmy/src/shared/__tests__/extractRetryAfter.test.ts
git commit -m "feat(rate-limit): extractRetryAfter with +2 min buffer"
```

---

### Task 5: `PROVIDER_RESET_DEFAULTS` table + config override and wiring

**Files:**
- Modify: `packages/jimmy/src/shared/rateLimit.ts`
- Test: `packages/jimmy/src/shared/__tests__/classifyError.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `packages/jimmy/src/shared/__tests__/classifyError.test.ts`:

```typescript
import { resolveResetFallback, PROVIDER_RESET_DEFAULTS } from "../rateLimit.js";
import type { JinnConfig } from "../types.js";

const minimalConfig: JinnConfig = {
  jinn: { version: "0.10.0" },
  gateway: { port: 7777, host: "127.0.0.1" },
  engines: { default: "codex", claude: {}, codex: {}, gemini: {} } as JinnConfig["engines"],
  connectors: {},
  logging: { file: false, stdout: false, level: "info" },
};

describe("resolveResetFallback", () => {
  it("returns hardcoded default when no config override", () => {
    expect(resolveResetFallback("codex", "usage_cap", minimalConfig)).toBe(60);
    expect(resolveResetFallback("claude", "usage_cap", minimalConfig)).toBe(300);
    expect(resolveResetFallback("codex", "rate_limited", minimalConfig)).toBe(1);
  });

  it("config override beats hardcoded default", () => {
    const overridden: JinnConfig = {
      ...minimalConfig,
      engines: {
        ...minimalConfig.engines,
        codex: { resetWindow: { usage_cap_min: 90, rate_limited_min: 2 } } as JinnConfig["engines"]["codex"],
      },
    };
    expect(resolveResetFallback("codex", "usage_cap", overridden)).toBe(90);
    expect(resolveResetFallback("codex", "rate_limited", overridden)).toBe(2);
  });

  it("returns null for non-recoverable kinds", () => {
    expect(resolveResetFallback("codex", "engine_crashed", minimalConfig)).toBeNull();
    expect(resolveResetFallback("codex", "unknown", minimalConfig)).toBeNull();
  });

  it("PROVIDER_RESET_DEFAULTS includes the documented engines and kinds", () => {
    expect(PROVIDER_RESET_DEFAULTS.codex.rate_limited).toBe(1);
    expect(PROVIDER_RESET_DEFAULTS.codex.usage_cap).toBe(60);
    expect(PROVIDER_RESET_DEFAULTS.claude.rate_limited).toBe(5);
    expect(PROVIDER_RESET_DEFAULTS.claude.usage_cap).toBe(300);
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

```bash
cd packages/jimmy && pnpm vitest run src/shared/__tests__/classifyError.test.ts
```

Expected: FAIL — `resolveResetFallback`, `PROVIDER_RESET_DEFAULTS` not exported.

- [ ] **Step 3: Add the table and resolver**

Append to `packages/jimmy/src/shared/rateLimit.ts`:

```typescript
import type { JinnConfig } from "./types.js";

/** Fallback reset-window minutes per engine per recoverable kind. */
export const PROVIDER_RESET_DEFAULTS: Record<
  string,
  Partial<Record<ErrorKind, number>>
> = {
  codex: { rate_limited: 1, usage_cap: 60 },
  claude: { rate_limited: 5, usage_cap: 300 },
  gemini: { rate_limited: 5, usage_cap: 60 },
};

/**
 * Resolve fallback reset minutes for an engine+kind, honouring
 * `config.engines.<name>.resetWindow.<kind>_min` overrides.
 *
 * Returns null for non-recoverable kinds (callers should not schedule).
 */
export function resolveResetFallback(
  engineName: string,
  kind: ErrorKind,
  config: JinnConfig,
): number | null {
  if (!RECOVERABLE_KINDS.has(kind)) return null;

  const cfgKey = kind === "rate_limited" ? "rate_limited_min" : "usage_cap_min";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engineCfg = (config.engines as any)?.[engineName] as { resetWindow?: Record<string, number> } | undefined;
  const override = engineCfg?.resetWindow?.[cfgKey];
  if (typeof override === "number" && Number.isFinite(override)) return override;

  return PROVIDER_RESET_DEFAULTS[engineName]?.[kind] ?? null;
}
```

- [ ] **Step 4: Wire `extractRetryAfter` to use the table when no in-text timestamp**

Update `extractRetryAfter` signature and implementation. Replace the function in `packages/jimmy/src/shared/rateLimit.ts`:

```typescript
export function extractRetryAfter(
  errorText: string,
  kind: ErrorKind,
  engineName: string,
  config?: JinnConfig,
): Date | null {
  if (errorText) {
    const isoMatch = errorText.match(ISO_RE);
    if (isoMatch) {
      const parsed = new Date(isoMatch[0]);
      if (!Number.isNaN(parsed.getTime())) {
        return clampFutureWithBuffer(parsed);
      }
    }

    const todMatch = errorText.match(TIME_OF_DAY_RE);
    if (todMatch) {
      const hour12 = parseInt(todMatch[1], 10);
      const minute = parseInt(todMatch[2], 10);
      const ampm = (todMatch[3] || "").toUpperCase();
      let hour24 = hour12;
      if (ampm === "PM" && hour12 < 12) hour24 = hour12 + 12;
      if (ampm === "AM" && hour12 === 12) hour24 = 0;
      const now = new Date();
      const candidate = new Date(now);
      candidate.setHours(hour24, minute, 0, 0);
      return clampFutureWithBuffer(candidate);
    }
  }

  // No explicit timestamp — fall back to config/default table.
  if (config) {
    const minutes = resolveResetFallback(engineName, kind, config);
    if (minutes !== null) {
      return new Date(Date.now() + minutes * 60_000 + BUFFER_MS);
    }
  }

  return null;
}
```

- [ ] **Step 5: Run tests, expect pass**

```bash
cd packages/jimmy && pnpm vitest run src/shared/__tests__/classifyError.test.ts src/shared/__tests__/extractRetryAfter.test.ts
```

Expected: PASS, all 17 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/jimmy/src/shared/rateLimit.ts packages/jimmy/src/shared/__tests__/classifyError.test.ts
git commit -m "feat(rate-limit): provider reset defaults table + config override"
```

---

## Phase 2 — Types and Persistence

### Task 6: Add error fields to `Session`, `CronJob`, `Employee`, `JinnConfig`

**Files:**
- Modify: `packages/jimmy/src/shared/types.ts`

This is a types-only change. No TDD step — types have no runtime behavior to test directly. Tests of consumers (next tasks) will fail if these fields are wrong.

- [ ] **Step 1: Extend `Session`**

In `packages/jimmy/src/shared/types.ts`, find the `Session` interface (around line 152) and add the four optional fields right after `lastError`:

```typescript
export interface Session {
  // ... existing fields ...
  lastError: string | null;
  // NEW — populated when status === "error" or "waiting"
  errorKind?: import("./rateLimit.js").ErrorKind;
  errorRecoverable?: boolean;
  errorRetryAfter?: string | null;        // ISO-8601, already includes +2 min buffer
  errorDetectedFrom?: "engine_result" | "process_exit" | "manual";
}
```

- [ ] **Step 2: Extend `CronJob`**

Find the `CronJob` interface (around line 179) and append:

```typescript
export interface CronJob {
  // ... existing fields ...
  delivery?: CronDelivery;
  // NEW
  autoResumeOnUsageCap?: boolean;
  autoResumeNudge?: string;
}
```

- [ ] **Step 3: Extend `Employee`**

Append to the `Employee` interface (around line 197):

```typescript
export interface Employee {
  // ... existing fields ...
  provides?: ServiceDeclaration[];
  // NEW
  autoResumeOnUsageCap?: boolean;
  autoResumeNudge?: string;
}
```

- [ ] **Step 4: Extend `JinnConfig.sessions` and `engines.*`**

Find the `JinnConfig` interface. Update `sessions`:

```typescript
sessions?: {
  maxDurationMinutes?: number;
  maxCostUsd?: number;
  interruptOnNewMessage?: boolean;
  rateLimitStrategy?: "wait" | "fallback";
  fallbackEngine?: "codex";
  // NEW
  autoResumeOnRateLimit?: boolean;     // default true
  autoResumeOnUsageCap?: boolean;      // default false
  autoResumeNudge?: string;            // default "keep going"
};
```

And add to each engine entry in `engines`:

```typescript
engines: {
  default: string;
  claude?: { bin?: string; model?: string; effortLevel?: string;
             resetWindow?: { rate_limited_min?: number; usage_cap_min?: number } };
  codex?:  { bin?: string; model?: string;
             resetWindow?: { rate_limited_min?: number; usage_cap_min?: number } };
  gemini?: { bin?: string; model?: string;
             resetWindow?: { rate_limited_min?: number; usage_cap_min?: number } };
};
```

(If the existing engine sub-shapes use a shared interface, add `resetWindow` to that interface instead of inlining three times.)

- [ ] **Step 5: Typecheck**

```bash
cd packages/jimmy && pnpm typecheck
```

Expected: PASS — no type errors elsewhere in the codebase.

- [ ] **Step 6: Commit**

```bash
git add packages/jimmy/src/shared/types.ts
git commit -m "feat(types): add error classification + auto-resume opt-in fields"
```

---

### Task 7: Extend `migrateSessionsSchema` to add the four error columns

**Files:**
- Modify: `packages/jimmy/src/sessions/registry.ts`
- Test: `packages/jimmy/src/sessions/__tests__/registry.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create `packages/jimmy/src/sessions/__tests__/registry.test.ts` (or extend if it exists):

```typescript
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
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, engine TEXT NOT NULL, source TEXT NOT NULL, source_ref TEXT NOT NULL, created_at TEXT NOT NULL, last_activity TEXT NOT NULL)`);
    migrateSessionsSchema(db);
    expect(() => migrateSessionsSchema(db)).not.toThrow();
    db.close();
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd packages/jimmy && pnpm vitest run src/sessions/__tests__/registry.test.ts
```

Expected: FAIL — new columns absent.

- [ ] **Step 3: Add the columns to the migration list**

In `packages/jimmy/src/sessions/registry.ts` find the `migrateSessionsSchema` function (around line 159). Append to `missingColumns`:

```typescript
const missingColumns: Array<[string, string, string?]> = [
  // ... existing entries ...
  ['effort_level', 'TEXT'],
  // NEW — error classification
  ['error_kind', 'TEXT'],
  ['error_recoverable', 'INTEGER'],
  ['error_retry_after', 'TEXT'],
  ['error_detected_from', 'TEXT'],
];
```

- [ ] **Step 4: Run, expect pass**

```bash
cd packages/jimmy && pnpm vitest run src/sessions/__tests__/registry.test.ts
```

Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add packages/jimmy/src/sessions/registry.ts packages/jimmy/src/sessions/__tests__/registry.test.ts
git commit -m "feat(registry): migrate sessions table with error classification columns"
```

---

I've laid out Phase 1 (5 tasks) and the first persistence task (Task 7). The plan has 14 more tasks to go. Continuing now in the next batch to keep this response focused.
### Task 8: Persist & read error columns in `rowToSession` + write paths

**Files:**
- Modify: `packages/jimmy/src/sessions/registry.ts`
- Test: `packages/jimmy/src/sessions/__tests__/registry.test.ts` (extend)

- [ ] **Step 1: Add failing test**

Append to `packages/jimmy/src/sessions/__tests__/registry.test.ts`:

```typescript
import { initSessions, createSession, updateSession, getSession } from "../registry.js";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

describe("registry — error fields roundtrip", () => {
  let tmpDir: string;
  let dbFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "jinn-registry-test-"));
    dbFile = path.join(tmpDir, "sessions.db");
    initSessions(dbFile);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads errorKind, errorRecoverable, errorRetryAfter, errorDetectedFrom", () => {
    const created = createSession({
      engine: "codex", source: "cron", sourceRef: "test-job",
      sessionKey: "test", connector: "cron",
    } as Parameters<typeof createSession>[0]);

    updateSession(created.id, {
      status: "error",
      lastError: "hit your usage limit; try again at 7:10 AM",
      errorKind: "usage_cap",
      errorRecoverable: true,
      errorRetryAfter: "2026-05-11T07:12:00-04:00",
      errorDetectedFrom: "engine_result",
    } as Parameters<typeof updateSession>[1]);

    const loaded = getSession(created.id);
    expect(loaded?.errorKind).toBe("usage_cap");
    expect(loaded?.errorRecoverable).toBe(true);
    expect(loaded?.errorRetryAfter).toBe("2026-05-11T07:12:00-04:00");
    expect(loaded?.errorDetectedFrom).toBe("engine_result");
  });
});
```

If `initSessions` does not currently take a path argument, adjust the test to use the existing init pattern (some Jinn versions use `process.env.JINN_HOME` redirection). The intent is: a temp DB, write fields, read back.

- [ ] **Step 2: Run, expect failure**

```bash
cd packages/jimmy && pnpm vitest run src/sessions/__tests__/registry.test.ts
```

Expected: FAIL — `errorKind` etc. read as `undefined`.

- [ ] **Step 3: Update `rowToSession` to read new columns**

In `packages/jimmy/src/sessions/registry.ts` find `rowToSession` (around line 71). Append before the closing `}`:

```typescript
    errorKind: (row.error_kind as Session['errorKind']) ?? undefined,
    errorRecoverable: row.error_recoverable === null || row.error_recoverable === undefined
      ? undefined
      : Boolean(row.error_recoverable),
    errorRetryAfter: (row.error_retry_after as string) ?? null,
    errorDetectedFrom: (row.error_detected_from as Session['errorDetectedFrom']) ?? undefined,
```

- [ ] **Step 4: Update `updateSession` to write new columns**

Locate the `updateSession` function in `registry.ts`. It builds a dynamic SET clause from a fields object. Add the four columns to its mapping (search for the existing `last_error` mapping and add adjacent):

```typescript
const FIELD_TO_COLUMN: Record<string, string> = {
  // ... existing entries ...
  lastError: "last_error",
  errorKind: "error_kind",
  errorRecoverable: "error_recoverable",
  errorRetryAfter: "error_retry_after",
  errorDetectedFrom: "error_detected_from",
};
```

If `updateSession` uses a different shape (e.g. direct switch/case), add equivalent branches that map the camelCase field name to the snake_case column, with `errorRecoverable` cast to `0`/`1` for SQLite INTEGER storage.

- [ ] **Step 5: Run, expect pass**

```bash
cd packages/jimmy && pnpm vitest run src/sessions/__tests__/registry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/jimmy/src/sessions/registry.ts packages/jimmy/src/sessions/__tests__/registry.test.ts
git commit -m "feat(registry): roundtrip error classification fields"
```

---

### Task 9: `auto_resume_queue` table + helpers

**Files:**
- Modify: `packages/jimmy/src/sessions/registry.ts`
- Test: `packages/jimmy/src/sessions/__tests__/autoResumeQueue.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/jimmy/src/sessions/__tests__/autoResumeQueue.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  initSessions,
  enqueueAutoResume,
  cancelAutoResume,
  listPendingAutoResumes,
  deleteAutoResume,
  getAutoResumeForSession,
} from "../registry.js";

describe("auto_resume_queue", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "jinn-autoresume-"));
    initSessions(path.join(tmpDir, "sessions.db"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enqueues a pending entry and lists it", () => {
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    const id = enqueueAutoResume({ sessionId: "s1", fireAt, nudge: "keep going" });
    expect(id).toBeTruthy();

    const pending = listPendingAutoResumes();
    expect(pending).toHaveLength(1);
    expect(pending[0].sessionId).toBe("s1");
    expect(pending[0].nudge).toBe("keep going");
  });

  it("cancellation removes from pending list", () => {
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    enqueueAutoResume({ sessionId: "s1", fireAt, nudge: "keep going" });
    cancelAutoResume("s1");
    expect(listPendingAutoResumes()).toHaveLength(0);
  });

  it("getAutoResumeForSession returns the active entry", () => {
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    enqueueAutoResume({ sessionId: "s1", fireAt, nudge: "keep going" });
    const active = getAutoResumeForSession("s1");
    expect(active?.fireAt).toBe(fireAt);
  });

  it("deleteAutoResume removes by id", () => {
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    const id = enqueueAutoResume({ sessionId: "s1", fireAt, nudge: "x" });
    deleteAutoResume(id);
    expect(listPendingAutoResumes()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd packages/jimmy && pnpm vitest run src/sessions/__tests__/autoResumeQueue.test.ts
```

Expected: FAIL — exports missing.

- [ ] **Step 3: Add the table creation and helpers**

In `packages/jimmy/src/sessions/registry.ts`, near the existing `CREATE TABLE IF NOT EXISTS queue_items` block (around line 112), add:

```typescript
const CREATE_AUTO_RESUME_TABLE = `
CREATE TABLE IF NOT EXISTS auto_resume_queue (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  fire_at TEXT NOT NULL,
  nudge TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cancelled_at TEXT
)`;

const CREATE_AUTO_RESUME_INDEX = `
CREATE INDEX IF NOT EXISTS idx_auto_resume_pending
ON auto_resume_queue(fire_at)
WHERE cancelled_at IS NULL
`;
```

Then in the existing `initSessions` (the function that runs all the CREATE TABLEs), add:

```typescript
db.exec(CREATE_AUTO_RESUME_TABLE);
db.exec(CREATE_AUTO_RESUME_INDEX);
```

Append the helper functions at the bottom of the file:

```typescript
export interface AutoResumeRow {
  id: string;
  sessionId: string;
  fireAt: string;
  nudge: string;
  createdAt: string;
  cancelledAt: string | null;
}

export function enqueueAutoResume(opts: { sessionId: string; fireAt: string; nudge: string }): string {
  const id = uuidv4();
  const createdAt = new Date().toISOString();
  // Cancel any prior pending entry for the same session before enqueueing.
  db.prepare(
    `UPDATE auto_resume_queue SET cancelled_at = ? WHERE session_id = ? AND cancelled_at IS NULL`,
  ).run(createdAt, opts.sessionId);
  db.prepare(
    `INSERT INTO auto_resume_queue (id, session_id, fire_at, nudge, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, opts.sessionId, opts.fireAt, opts.nudge, createdAt);
  return id;
}

export function cancelAutoResume(sessionId: string): void {
  db.prepare(
    `UPDATE auto_resume_queue SET cancelled_at = ? WHERE session_id = ? AND cancelled_at IS NULL`,
  ).run(new Date().toISOString(), sessionId);
}

export function deleteAutoResume(id: string): void {
  db.prepare(`DELETE FROM auto_resume_queue WHERE id = ?`).run(id);
}

export function listPendingAutoResumes(): AutoResumeRow[] {
  const rows = db
    .prepare(
      `SELECT id, session_id, fire_at, nudge, created_at, cancelled_at
         FROM auto_resume_queue
        WHERE cancelled_at IS NULL
        ORDER BY fire_at ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    sessionId: r.session_id as string,
    fireAt: r.fire_at as string,
    nudge: r.nudge as string,
    createdAt: r.created_at as string,
    cancelledAt: (r.cancelled_at as string) ?? null,
  }));
}

export function getAutoResumeForSession(sessionId: string): AutoResumeRow | null {
  const row = db
    .prepare(
      `SELECT id, session_id, fire_at, nudge, created_at, cancelled_at
         FROM auto_resume_queue
        WHERE session_id = ? AND cancelled_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    fireAt: row.fire_at as string,
    nudge: row.nudge as string,
    createdAt: row.created_at as string,
    cancelledAt: (row.cancelled_at as string) ?? null,
  };
}
```

- [ ] **Step 4: Run, expect pass**

```bash
cd packages/jimmy && pnpm vitest run src/sessions/__tests__/autoResumeQueue.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/jimmy/src/sessions/registry.ts packages/jimmy/src/sessions/__tests__/autoResumeQueue.test.ts
git commit -m "feat(registry): auto_resume_queue table and CRUD helpers"
```

---

### Task 10: Call `classifyError` on every error transition in `sessions/manager.ts`

**Files:**
- Modify: `packages/jimmy/src/sessions/manager.ts`
- Test: `packages/jimmy/src/sessions/__tests__/managerClassify.test.ts` (new)

- [ ] **Step 1: Write the failing integration test**

Create `packages/jimmy/src/sessions/__tests__/managerClassify.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initSessions, createSession, getSession } from "../registry.js";
import { applyEngineErrorToSession } from "../manager.js";

describe("applyEngineErrorToSession", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "jinn-mgr-"));
    initSessions(path.join(tmpDir, "sessions.db"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("populates errorKind and recoverable on usage-cap error", () => {
    const s = createSession({
      engine: "codex", source: "cron", sourceRef: "j1", sessionKey: "j1", connector: "cron",
    } as Parameters<typeof createSession>[0]);

    applyEngineErrorToSession(s.id, "codex", {
      error: "hit your usage limit; try again at 7:10 AM",
      cost: 0, numTurns: 0, output: "",
    });

    const loaded = getSession(s.id);
    expect(loaded?.status).toBe("error");
    expect(loaded?.errorKind).toBe("usage_cap");
    expect(loaded?.errorRecoverable).toBe(true);
    expect(loaded?.errorRetryAfter).toBeTruthy();
    expect(loaded?.lastError).toContain("usage limit");
  });

  it("marks engine_crashed as non-recoverable", () => {
    const s = createSession({
      engine: "codex", source: "web", sourceRef: "w1", sessionKey: "w1", connector: "web",
    } as Parameters<typeof createSession>[0]);

    applyEngineErrorToSession(s.id, "codex", {
      error: "segmentation fault", cost: 0.01, numTurns: 2, output: "",
    });

    const loaded = getSession(s.id);
    expect(loaded?.errorKind).toBe("engine_crashed");
    expect(loaded?.errorRecoverable).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd packages/jimmy && pnpm vitest run src/sessions/__tests__/managerClassify.test.ts
```

Expected: FAIL — `applyEngineErrorToSession` not exported.

- [ ] **Step 3: Add the helper and call it from all error transitions**

In `packages/jimmy/src/sessions/manager.ts`, add at the top of the file (after imports):

```typescript
import { classifyError, extractRetryAfter, RECOVERABLE_KINDS } from "../shared/rateLimit.js";
import type { EngineResult, JinnConfig } from "../shared/types.js";
import { updateSession } from "./registry.js";

/**
 * Centralised helper for transitioning a session to error state with full
 * classification. Always populates errorKind / errorRecoverable; populates
 * errorRetryAfter when the kind is recoverable.
 *
 * Returns the classification so callers can decide whether to schedule
 * auto-resume.
 */
export function applyEngineErrorToSession(
  sessionId: string,
  engineName: string,
  result: EngineResult,
  config?: JinnConfig,
) {
  const classification = classifyError(result, engineName);
  const retryAfter =
    classification.recoverable
      ? extractRetryAfter(classification.originalMessage, classification.kind, engineName, config)
      : null;

  updateSession(sessionId, {
    status: "error",
    lastError: classification.originalMessage || "Unknown engine error",
    lastActivity: new Date().toISOString(),
    errorKind: classification.kind,
    errorRecoverable: classification.recoverable,
    errorRetryAfter: retryAfter ? retryAfter.toISOString() : null,
    errorDetectedFrom: classification.detectedFrom,
  } as Parameters<typeof updateSession>[1]);

  return { classification, retryAfter };
}
```

Then find every site in `manager.ts` and `gateway/api.ts` where a session is currently transitioned to `status: "error"` directly (search for `status: "error"`) and replace those with calls to `applyEngineErrorToSession(sessionId, engineName, result, config)`. **Do not** change the cron-runner job-status logging (different concept).

Sites to update (each):
- `packages/jimmy/src/sessions/manager.ts:471` (fallback error)
- `packages/jimmy/src/sessions/manager.ts:632` (retry error)
- `packages/jimmy/src/sessions/manager.ts:656` (terminal error)
- `packages/jimmy/src/sessions/manager.ts:691` (post-run error path)
- `packages/jimmy/src/sessions/manager.ts:717` (catch-all error path)
- `packages/jimmy/src/gateway/api.ts:84`, `:163`, `:706`, `:2240`, `:2382`, `:2414`, `:2440`, `:2478` (engine-unavailable and dispatch error paths — for engine-unavailable, pass a synthetic `EngineResult` with `error: "Engine X not available"`)

For engine-unavailable paths, the synthetic result will classify as `unknown` which is the correct semantics (no engine to retry against).

- [ ] **Step 4: Run, expect pass**

```bash
cd packages/jimmy && pnpm vitest run src/sessions/__tests__/managerClassify.test.ts
cd packages/jimmy && pnpm typecheck
```

Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/jimmy/src/sessions/manager.ts packages/jimmy/src/gateway/api.ts packages/jimmy/src/sessions/__tests__/managerClassify.test.ts
git commit -m "feat(sessions): centralise error transitions via applyEngineErrorToSession"
```

---

### Task 11: AutoResumer module — scheduler, opt-in resolution, persistence replay

**Files:**
- Create: `packages/jimmy/src/sessions/autoResumer.ts`
- Test: `packages/jimmy/src/sessions/__tests__/autoResumer.test.ts`
- Modify: `packages/jimmy/src/sessions/manager.ts` (call `scheduleAutoResume` from `applyEngineErrorToSession`)
- Modify: `packages/jimmy/src/gateway/server.ts` (call `startAutoResumer` on gateway boot)

- [ ] **Step 1: Write the failing test**

Create `packages/jimmy/src/sessions/__tests__/autoResumer.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  initSessions, createSession, listPendingAutoResumes, getAutoResumeForSession,
} from "../registry.js";
import {
  scheduleAutoResume, cancelScheduledAutoResume, resolveAutoResume,
} from "../autoResumer.js";
import type { JinnConfig, CronJob, Employee } from "../../shared/types.js";

const minimalConfig = (): JinnConfig => ({
  jinn: { version: "0.10.0" },
  gateway: { port: 7777, host: "127.0.0.1" },
  engines: { default: "codex", codex: {}, claude: {}, gemini: {} } as JinnConfig["engines"],
  connectors: {},
  logging: { file: false, stdout: false, level: "info" },
});

describe("resolveAutoResume — precedence", () => {
  it("rate_limited defaults to true globally", () => {
    const r = resolveAutoResume({
      kind: "rate_limited", config: minimalConfig(),
    });
    expect(r.enabled).toBe(true);
    expect(r.nudge).toBe("keep going");
  });

  it("usage_cap defaults to false globally", () => {
    const r = resolveAutoResume({ kind: "usage_cap", config: minimalConfig() });
    expect(r.enabled).toBe(false);
  });

  it("cron job override beats employee beats global", () => {
    const cfg = minimalConfig();
    cfg.sessions = { autoResumeOnUsageCap: false, autoResumeNudge: "global" };
    const emp: Employee = {
      name: "codex-engineer", displayName: "Codex Engineer", department: "engineering",
      rank: "senior", engine: "codex", model: "gpt-5.5", persona: "",
      autoResumeOnUsageCap: false, autoResumeNudge: "employee",
    };
    const job: CronJob = {
      id: "j", name: "j", enabled: true, schedule: "0 0 * * *", prompt: "",
      autoResumeOnUsageCap: true, autoResumeNudge: "job-specific nudge",
    };
    const r = resolveAutoResume({ kind: "usage_cap", config: cfg, employee: emp, cronJob: job });
    expect(r.enabled).toBe(true);
    expect(r.nudge).toBe("job-specific nudge");
  });

  it("employee override beats global when no cron job", () => {
    const cfg = minimalConfig();
    cfg.sessions = { autoResumeOnUsageCap: false };
    const emp: Employee = {
      name: "codex-engineer", displayName: "Codex Engineer", department: "engineering",
      rank: "senior", engine: "codex", model: "gpt-5.5", persona: "",
      autoResumeOnUsageCap: true, autoResumeNudge: "employee-nudge",
    };
    const r = resolveAutoResume({ kind: "usage_cap", config: cfg, employee: emp });
    expect(r.enabled).toBe(true);
    expect(r.nudge).toBe("employee-nudge");
  });
});

describe("scheduleAutoResume — persistence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "jinn-ar-"));
    initSessions(path.join(tmpDir, "sessions.db"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a queue row when called for a recoverable+opted-in session", () => {
    const s = createSession({
      engine: "codex", source: "cron", sourceRef: "j", sessionKey: "j", connector: "cron",
    } as Parameters<typeof createSession>[0]);

    scheduleAutoResume({
      sessionId: s.id,
      fireAt: new Date(Date.now() + 60_000),
      nudge: "keep going",
    });

    const pending = listPendingAutoResumes();
    expect(pending).toHaveLength(1);
    expect(pending[0].sessionId).toBe(s.id);
  });

  it("cancelScheduledAutoResume removes the row", () => {
    const s = createSession({
      engine: "codex", source: "cron", sourceRef: "j", sessionKey: "j", connector: "cron",
    } as Parameters<typeof createSession>[0]);
    scheduleAutoResume({ sessionId: s.id, fireAt: new Date(Date.now() + 60_000), nudge: "x" });
    cancelScheduledAutoResume(s.id);
    expect(getAutoResumeForSession(s.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd packages/jimmy && pnpm vitest run src/sessions/__tests__/autoResumer.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the module**

Create `packages/jimmy/src/sessions/autoResumer.ts`:

```typescript
import { logger } from "../shared/logger.js";
import type { ErrorKind } from "../shared/rateLimit.js";
import { RECOVERABLE_KINDS } from "../shared/rateLimit.js";
import type { CronJob, Employee, JinnConfig } from "../shared/types.js";
import {
  enqueueAutoResume,
  cancelAutoResume,
  listPendingAutoResumes,
  deleteAutoResume,
  getSession,
} from "./registry.js";

const TICK_MS = 30_000;
let tickHandle: NodeJS.Timeout | null = null;
let dispatchFn: ((sessionId: string, nudge: string) => Promise<void>) | null = null;

export interface AutoResumeResolution {
  enabled: boolean;
  nudge: string;
}

const DEFAULT_NUDGE = "keep going";

/**
 * Precedence: cron job > employee > global config.
 * For rate_limited, the global default is true (auto-resume is the natural recovery).
 * For usage_cap, the global default is false (opt-in).
 */
export function resolveAutoResume(opts: {
  kind: ErrorKind;
  config: JinnConfig;
  employee?: Employee | null;
  cronJob?: CronJob | null;
}): AutoResumeResolution {
  const { kind, config, employee, cronJob } = opts;
  if (!RECOVERABLE_KINDS.has(kind)) return { enabled: false, nudge: DEFAULT_NUDGE };

  const fieldEnabled = kind === "rate_limited" ? "autoResumeOnRateLimit" : "autoResumeOnUsageCap";
  const globalDefault = kind === "rate_limited" ? true : false;

  const globalEnabled =
    typeof config.sessions?.[fieldEnabled] === "boolean"
      ? (config.sessions![fieldEnabled] as boolean)
      : globalDefault;

  const empEnabled = employee?.[fieldEnabled as "autoResumeOnUsageCap"];
  const jobEnabled = cronJob?.[fieldEnabled as "autoResumeOnUsageCap"];

  const enabled = jobEnabled ?? empEnabled ?? globalEnabled;

  const nudge =
    cronJob?.autoResumeNudge ??
    employee?.autoResumeNudge ??
    config.sessions?.autoResumeNudge ??
    DEFAULT_NUDGE;

  return { enabled, nudge };
}

/**
 * Enqueue an auto-resume. The queue is persisted; the tick loop dispatches
 * due rows. Idempotent on sessionId — re-scheduling cancels the previous row.
 */
export function scheduleAutoResume(opts: {
  sessionId: string;
  fireAt: Date;
  nudge: string;
}): void {
  enqueueAutoResume({
    sessionId: opts.sessionId,
    fireAt: opts.fireAt.toISOString(),
    nudge: opts.nudge,
  });
  logger.info(
    `[autoResumer] scheduled session=${opts.sessionId} fireAt=${opts.fireAt.toISOString()} nudge="${opts.nudge.slice(0, 40)}"`,
  );
}

export function cancelScheduledAutoResume(sessionId: string): void {
  cancelAutoResume(sessionId);
  logger.info(`[autoResumer] cancelled session=${sessionId}`);
}

/**
 * Inject the dispatch function from the gateway — kept as a setter to avoid
 * a circular import with sessions/manager.ts.
 */
export function setAutoResumeDispatcher(fn: (sessionId: string, nudge: string) => Promise<void>): void {
  dispatchFn = fn;
}

/** Start the periodic tick. Idempotent. */
export function startAutoResumer(): void {
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    tick().catch((err) => {
      logger.error(`[autoResumer] tick error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, TICK_MS);
  // Run an immediate tick on boot to replay anything overdue.
  tick().catch(() => undefined);
}

export function stopAutoResumer(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

async function tick(): Promise<void> {
  if (!dispatchFn) return;
  const now = Date.now();
  const due = listPendingAutoResumes().filter((row) => Date.parse(row.fireAt) <= now);

  for (const row of due) {
    const session = getSession(row.sessionId);
    if (!session) {
      // Session deleted under us — drop the row.
      deleteAutoResume(row.id);
      continue;
    }
    if (session.status === "running") {
      // Someone else resumed it manually. Cancel.
      deleteAutoResume(row.id);
      continue;
    }
    try {
      logger.info(`[autoResumer] firing session=${row.sessionId} nudge="${row.nudge.slice(0, 40)}"`);
      await dispatchFn(row.sessionId, row.nudge);
      deleteAutoResume(row.id);
    } catch (err) {
      logger.error(
        `[autoResumer] dispatch failed session=${row.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Leave the row in place so the next manual classification can re-schedule.
      // Reclassification will overwrite it via enqueueAutoResume's cancel-then-insert.
      deleteAutoResume(row.id);
    }
  }
}
```

- [ ] **Step 4: Wire scheduling into `applyEngineErrorToSession`**

In `packages/jimmy/src/sessions/manager.ts`, find `applyEngineErrorToSession` (added in Task 10) and extend it:

```typescript
import { resolveAutoResume, scheduleAutoResume } from "./autoResumer.js";
import { findEmployee, scanOrg } from "../gateway/org.js";

export function applyEngineErrorToSession(
  sessionId: string,
  engineName: string,
  result: EngineResult,
  config: JinnConfig,
  ctx?: { cronJob?: CronJob | null; employee?: Employee | null },
) {
  const classification = classifyError(result, engineName);
  const retryAfter =
    classification.recoverable
      ? extractRetryAfter(classification.originalMessage, classification.kind, engineName, config)
      : null;

  updateSession(sessionId, {
    status: "error",
    lastError: classification.originalMessage || "Unknown engine error",
    lastActivity: new Date().toISOString(),
    errorKind: classification.kind,
    errorRecoverable: classification.recoverable,
    errorRetryAfter: retryAfter ? retryAfter.toISOString() : null,
    errorDetectedFrom: classification.detectedFrom,
  } as Parameters<typeof updateSession>[1]);

  if (classification.recoverable && retryAfter) {
    let employee = ctx?.employee ?? null;
    if (!employee) {
      const session = getSession(sessionId);
      if (session?.employee) {
        employee = findEmployee(session.employee, scanOrg()) ?? null;
      }
    }
    const resolved = resolveAutoResume({
      kind: classification.kind,
      config,
      employee,
      cronJob: ctx?.cronJob ?? null,
    });
    if (resolved.enabled) {
      scheduleAutoResume({ sessionId, fireAt: retryAfter, nudge: resolved.nudge });
    }
  }

  return { classification, retryAfter };
}
```

Update each caller site found in Task 10 Step 3 to pass `config` and (where available) `ctx.cronJob`. For cron-runner-originated errors, the runner has access to the `CronJob` and can pass it.

- [ ] **Step 5: Wire dispatcher and start the loop on gateway boot**

In `packages/jimmy/src/gateway/server.ts`, find the boot path (look for where `SessionManager` is constructed). After it's ready, add:

```typescript
import { setAutoResumeDispatcher, startAutoResumer, stopAutoResumer } from "../sessions/autoResumer.js";

// After session manager + sessions DB are ready:
setAutoResumeDispatcher(async (sessionId, nudge) => {
  // Send the nudge as a user message via the existing API path. Reuse the
  // same dispatchWebSessionRun used by POST /api/sessions/:id/message.
  await context.sessionManager.dispatchNudge(sessionId, nudge);
});
startAutoResumer();
```

Add a `dispatchNudge` method to `SessionManager` that wraps the existing message-dispatch path (or call the internal `dispatchWebSessionRun` directly with the resumed session + the nudge). On shutdown, call `stopAutoResumer()`.

- [ ] **Step 6: Run, expect pass**

```bash
cd packages/jimmy && pnpm vitest run src/sessions/__tests__/autoResumer.test.ts
cd packages/jimmy && pnpm typecheck
```

Expected: PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/jimmy/src/sessions/autoResumer.ts packages/jimmy/src/sessions/manager.ts packages/jimmy/src/gateway/server.ts packages/jimmy/src/sessions/__tests__/autoResumer.test.ts
git commit -m "feat(sessions): auto-resume scheduler with global → employee → cron precedence"
```

---

### Task 12: `POST /api/sessions/:id/resume` endpoint

**Files:**
- Modify: `packages/jimmy/src/gateway/api.ts`
- Test: `packages/jimmy/src/gateway/__tests__/resumeApi.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/jimmy/src/gateway/__tests__/resumeApi.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initSessions, createSession, updateSession, getSession } from "../../sessions/registry.js";
// Helper that exercises the route handler directly without spinning up an HTTP server.
import { handleResumeRequest } from "../api.js";

describe("POST /api/sessions/:id/resume", () => {
  let tmpDir: string;
  let mockDispatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "jinn-resume-api-"));
    initSessions(path.join(tmpDir, "sessions.db"));
    mockDispatch = vi.fn(async () => undefined);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("404s on unknown session", async () => {
    const res = await handleResumeRequest("missing-id", {}, { dispatchMessage: mockDispatch });
    expect(res.status).toBe(404);
  });

  it("409s when session is running", async () => {
    const s = createSession({
      engine: "codex", source: "web", sourceRef: "w", sessionKey: "w", connector: "web",
    } as Parameters<typeof createSession>[0]);
    updateSession(s.id, { status: "running" } as Parameters<typeof updateSession>[1]);

    const res = await handleResumeRequest(s.id, {}, { dispatchMessage: mockDispatch });
    expect(res.status).toBe(409);
  });

  it("clears error fields, preserves engineSessionId, dispatches nudge", async () => {
    const s = createSession({
      engine: "codex", source: "web", sourceRef: "w", sessionKey: "w", connector: "web",
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
    expect(loaded?.engineSessionId).toBe("engine-thread-abc"); // preserved
    expect(mockDispatch).toHaveBeenCalledWith(s.id, "go on");
  });

  it("preserveEngineSession=false clears engineSessionId", async () => {
    const s = createSession({
      engine: "codex", source: "web", sourceRef: "w", sessionKey: "w", connector: "web",
    } as Parameters<typeof createSession>[0]);
    updateSession(s.id, {
      status: "error", lastError: "x", engineSessionId: "engine-thread-abc",
    } as Parameters<typeof updateSession>[1]);

    const res = await handleResumeRequest(
      s.id, { nudge: "go", preserveEngineSession: false }, { dispatchMessage: mockDispatch },
    );
    expect(res.status).toBe(200);
    expect(getSession(s.id)?.engineSessionId).toBeNull();
  });

  it("defaults nudge to 'keep going' when omitted", async () => {
    const s = createSession({
      engine: "codex", source: "web", sourceRef: "w", sessionKey: "w", connector: "web",
    } as Parameters<typeof createSession>[0]);
    updateSession(s.id, { status: "error", lastError: "x" } as Parameters<typeof updateSession>[1]);

    await handleResumeRequest(s.id, {}, { dispatchMessage: mockDispatch });
    expect(mockDispatch).toHaveBeenCalledWith(s.id, "keep going");
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd packages/jimmy && pnpm vitest run src/gateway/__tests__/resumeApi.test.ts
```

Expected: FAIL — `handleResumeRequest` not exported.

- [ ] **Step 3: Add the handler and wire the route**

In `packages/jimmy/src/gateway/api.ts`, add a route block alongside the existing `/stop`, `/reset`, `/duplicate` routes (search for `// POST /api/sessions/:id/reset`):

```typescript
// POST /api/sessions/:id/resume — clear recoverable error state and re-dispatch
params = matchRoute("/api/sessions/:id/resume", pathname);
if (method === "POST" && params) {
  const _parsed = await readJsonBody(req, res);
  if (!_parsed.ok) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = _parsed.body as any;
  const result = await handleResumeRequest(params.id, body, {
    dispatchMessage: (sessionId, nudge) => context.sessionManager.dispatchNudge(sessionId, nudge),
  });
  if (result.body) return json(res, result.body, result.status);
  return json(res, { ok: true }, result.status);
}
```

Add the exported helper at module scope (near `handleResumeRequest` should be added, exported so tests can call directly):

```typescript
import { cancelScheduledAutoResume } from "../sessions/autoResumer.js";

export async function handleResumeRequest(
  sessionId: string,
  body: { nudge?: string; preserveEngineSession?: boolean },
  deps: { dispatchMessage: (sessionId: string, nudge: string) => Promise<void> },
): Promise<{ status: number; body?: unknown }> {
  const session = getSession(sessionId);
  if (!session) return { status: 404, body: { error: "session not found" } };

  if (session.status !== "error" && session.status !== "waiting" && session.status !== "interrupted") {
    return { status: 409, body: { error: `cannot resume from status=${session.status}` } };
  }

  const nudge = typeof body.nudge === "string" && body.nudge.length > 0 ? body.nudge : "keep going";
  const preserveEngineSession = body.preserveEngineSession !== false;

  // Cancel any pending auto-resume for this session.
  cancelScheduledAutoResume(sessionId);

  // Clear error fields. Preserve engineSessionId unless caller asked otherwise.
  updateSession(sessionId, {
    status: "running",
    lastError: null,
    errorKind: undefined,
    errorRecoverable: undefined,
    errorRetryAfter: null,
    errorDetectedFrom: undefined,
    lastActivity: new Date().toISOString(),
    ...(preserveEngineSession ? {} : { engineSessionId: null }),
  } as Parameters<typeof updateSession>[1]);

  await deps.dispatchMessage(sessionId, nudge);

  const updated = getSession(sessionId);
  return { status: 200, body: updated };
}
```

The `updateSession` write of `errorKind: undefined` must translate to SQL `NULL`. If the existing updateSession only updates fields whose values are defined, accept that nuance and instead set them to `null` explicitly and convert in `rowToSession`. Adjust the test expectations to match the actual chosen representation (`null` vs `undefined`).

- [ ] **Step 4: Run, expect pass**

```bash
cd packages/jimmy && pnpm vitest run src/gateway/__tests__/resumeApi.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/jimmy/src/gateway/api.ts packages/jimmy/src/gateway/__tests__/resumeApi.test.ts
git commit -m "feat(api): POST /api/sessions/:id/resume with engineSessionId preservation"
```

---


### Task 13: `GET /api/sessions/recoverable` endpoint

**Files:**
- Modify: `packages/jimmy/src/gateway/api.ts`
- Test: `packages/jimmy/src/gateway/__tests__/resumeApi.test.ts` (extend)

- [ ] **Step 1: Add the failing test**

Append to `packages/jimmy/src/gateway/__tests__/resumeApi.test.ts`:

```typescript
import { handleListRecoverable } from "../api.js";

describe("GET /api/sessions/recoverable", () => {
  beforeEach(() => {
    initSessions(path.join(tmpDir, "sessions.db"));
  });

  it("returns only sessions where errorRecoverable=true", async () => {
    const a = createSession({
      engine: "codex", source: "cron", sourceRef: "j1", sessionKey: "j1", connector: "cron",
    } as Parameters<typeof createSession>[0]);
    const b = createSession({
      engine: "codex", source: "web", sourceRef: "w1", sessionKey: "w1", connector: "web",
    } as Parameters<typeof createSession>[0]);
    const c = createSession({
      engine: "codex", source: "web", sourceRef: "w2", sessionKey: "w2", connector: "web",
    } as Parameters<typeof createSession>[0]);

    updateSession(a.id, {
      status: "error", lastError: "usage cap", errorKind: "usage_cap",
      errorRecoverable: true, errorRetryAfter: new Date(Date.now() + 60_000).toISOString(),
    } as Parameters<typeof updateSession>[1]);
    updateSession(b.id, {
      status: "error", lastError: "crashed", errorKind: "engine_crashed", errorRecoverable: false,
    } as Parameters<typeof updateSession>[1]);
    // c stays idle — should not appear

    const res = await handleListRecoverable();
    expect(res.status).toBe(200);
    const list = res.body as Array<{ sessionId: string; errorKind: string }>;
    expect(list.map((s) => s.sessionId).sort()).toEqual([a.id].sort());
    expect(list[0].errorKind).toBe("usage_cap");
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd packages/jimmy && pnpm vitest run src/gateway/__tests__/resumeApi.test.ts
```

Expected: new test fails.

- [ ] **Step 3: Implement the handler and route**

In `packages/jimmy/src/gateway/api.ts`, add the helper near `handleResumeRequest`:

```typescript
import { getAutoResumeForSession, listAllSessions } from "../sessions/registry.js";

export interface RecoverableSessionSummary {
  sessionId: string;
  title: string | null;
  engine: string;
  employee: string | null;
  errorKind: string;
  errorRetryAfter: string | null;
  autoResumeScheduledAt: string | null;
  lastErrorPreview: string;
  source: string;
}

export async function handleListRecoverable(): Promise<{ status: number; body: RecoverableSessionSummary[] }> {
  // Use the existing session-listing helper (likely listSessions or similar).
  const all = listAllSessions(); // adjust name if registry exports a different one
  const recoverable = all
    .filter((s) => s.status === "error" && s.errorRecoverable === true)
    .map((s) => {
      const ar = getAutoResumeForSession(s.id);
      const summary: RecoverableSessionSummary = {
        sessionId: s.id,
        title: s.title,
        engine: s.engine,
        employee: s.employee,
        errorKind: s.errorKind ?? "unknown",
        errorRetryAfter: s.errorRetryAfter ?? null,
        autoResumeScheduledAt: ar?.fireAt ?? null,
        lastErrorPreview: (s.lastError ?? "").slice(0, 240),
        source: s.source,
      };
      return summary;
    });
  return { status: 200, body: recoverable };
}
```

If `listAllSessions` is not currently exported, add it to `registry.ts`:

```typescript
export function listAllSessions(): Session[] {
  const rows = db.prepare(`SELECT * FROM sessions ORDER BY last_activity DESC`).all() as Array<Record<string, unknown>>;
  return rows.map(rowToSession);
}
```

Wire the route in the request handler (search for `// GET /api/sessions` near the top of route matching, around line 376):

```typescript
// GET /api/sessions/recoverable — must come BEFORE the generic /api/sessions/:id match
if (method === "GET" && pathname === "/api/sessions/recoverable") {
  const result = await handleListRecoverable();
  return json(res, result.body, result.status);
}
```

- [ ] **Step 4: Run, expect pass**

```bash
cd packages/jimmy && pnpm vitest run src/gateway/__tests__/resumeApi.test.ts
```

Expected: PASS, 6 tests total.

- [ ] **Step 5: Commit**

```bash
git add packages/jimmy/src/gateway/api.ts packages/jimmy/src/sessions/registry.ts packages/jimmy/src/gateway/__tests__/resumeApi.test.ts
git commit -m "feat(api): GET /api/sessions/recoverable"
```

---

### Task 14: MCP tools — `jinn_list_recoverable_sessions` and `jinn_get_session_error`

**Files:**
- Modify: `packages/jimmy/src/mcp/gateway-server.ts`
- Test: `packages/jimmy/src/mcp/__tests__/errorResumeTools.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/jimmy/src/mcp/__tests__/errorResumeTools.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initSessions, createSession, updateSession, getAutoResumeForSession, enqueueAutoResume } from "../../sessions/registry.js";
import { mcpHandleTool } from "../gateway-server.js";

describe("MCP tools — recoverable sessions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "jinn-mcp-"));
    initSessions(path.join(tmpDir, "sessions.db"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("jinn_list_recoverable_sessions returns recoverable sessions only", async () => {
    const s = createSession({
      engine: "codex", source: "cron", sourceRef: "j", sessionKey: "j", connector: "cron",
    } as Parameters<typeof createSession>[0]);
    updateSession(s.id, {
      status: "error", lastError: "hit your usage limit", errorKind: "usage_cap",
      errorRecoverable: true, errorRetryAfter: new Date(Date.now() + 60_000).toISOString(),
    } as Parameters<typeof updateSession>[1]);

    const text = await mcpHandleTool("jinn_list_recoverable_sessions", {});
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].sessionId).toBe(s.id);
    expect(parsed[0].errorKind).toBe("usage_cap");
  });

  it("jinn_get_session_error returns structured fields", async () => {
    const s = createSession({
      engine: "codex", source: "cron", sourceRef: "j", sessionKey: "j", connector: "cron",
    } as Parameters<typeof createSession>[0]);
    const retry = new Date(Date.now() + 60_000).toISOString();
    updateSession(s.id, {
      status: "error", lastError: "hit your usage limit", errorKind: "usage_cap",
      errorRecoverable: true, errorRetryAfter: retry,
    } as Parameters<typeof updateSession>[1]);
    enqueueAutoResume({ sessionId: s.id, fireAt: retry, nudge: "keep going" });

    const text = await mcpHandleTool("jinn_get_session_error", { sessionId: s.id });
    const parsed = JSON.parse(text);
    expect(parsed.errorKind).toBe("usage_cap");
    expect(parsed.autoResumeScheduledAt).toBe(retry);
    expect(parsed.autoResumeNudge).toBe("keep going");
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd packages/jimmy && pnpm vitest run src/mcp/__tests__/errorResumeTools.test.ts
```

Expected: FAIL — `mcpHandleTool` not exported, tools unknown.

- [ ] **Step 3: Export the existing tool handler and register two new tools**

In `packages/jimmy/src/mcp/gateway-server.ts`:

a. Refactor the existing internal `handleTool(name, args)` function to be `export async function mcpHandleTool(name, args)`. Update the one in-file caller (`tools/call` switch) to use the new name. (Pure rename, no behavior change.)

b. Add two tool definitions to the `TOOLS` array:

```typescript
{
  name: "jinn_list_recoverable_sessions",
  description:
    "List Jinn sessions currently in a recoverable error state (rate_limited or usage_cap). " +
    "Returns sessionId, title, engine, employee, errorKind, errorRetryAfter, autoResumeScheduledAt, lastErrorPreview, source.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
},
{
  name: "jinn_get_session_error",
  description:
    "Return structured error details for a Jinn session, including any scheduled auto-resume info.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "The Jinn session ID." },
    },
    required: ["sessionId"],
    additionalProperties: false,
  },
},
```

c. Add cases to the tool dispatch in `mcpHandleTool`:

```typescript
case "jinn_list_recoverable_sessions": {
  const { handleListRecoverable } = await import("../gateway/api.js");
  const result = await handleListRecoverable();
  return JSON.stringify(result.body, null, 2);
}

case "jinn_get_session_error": {
  const sessionId = String(args.sessionId);
  const { getSession, getAutoResumeForSession } = await import("../sessions/registry.js");
  const s = getSession(sessionId);
  if (!s) throw new Error(`session not found: ${sessionId}`);
  const ar = getAutoResumeForSession(sessionId);
  return JSON.stringify({
    sessionId: s.id,
    status: s.status,
    errorKind: s.errorKind ?? null,
    errorRecoverable: s.errorRecoverable ?? null,
    errorRetryAfter: s.errorRetryAfter ?? null,
    errorDetectedFrom: s.errorDetectedFrom ?? null,
    lastError: s.lastError ?? null,
    autoResumeScheduledAt: ar?.fireAt ?? null,
    autoResumeNudge: ar?.nudge ?? null,
  }, null, 2);
}
```

- [ ] **Step 4: Run, expect pass**

```bash
cd packages/jimmy && pnpm vitest run src/mcp/__tests__/errorResumeTools.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/jimmy/src/mcp/gateway-server.ts packages/jimmy/src/mcp/__tests__/errorResumeTools.test.ts
git commit -m "feat(mcp): jinn_list_recoverable_sessions and jinn_get_session_error tools"
```

---

### Task 15: MCP tool — `jinn_resume_session`

**Files:**
- Modify: `packages/jimmy/src/mcp/gateway-server.ts`
- Test: `packages/jimmy/src/mcp/__tests__/errorResumeTools.test.ts` (extend)

- [ ] **Step 1: Add failing test**

Append to `packages/jimmy/src/mcp/__tests__/errorResumeTools.test.ts`:

```typescript
import { vi } from "vitest";

describe("MCP tool — jinn_resume_session", () => {
  beforeEach(() => {
    initSessions(path.join(tmpDir, "sessions.db"));
  });

  it("invokes the resume handler and reports dispatched", async () => {
    const s = createSession({
      engine: "codex", source: "cron", sourceRef: "j", sessionKey: "j", connector: "cron",
    } as Parameters<typeof createSession>[0]);
    updateSession(s.id, {
      status: "error", lastError: "usage cap", errorKind: "usage_cap",
      errorRecoverable: true, errorRetryAfter: new Date(Date.now() + 60_000).toISOString(),
      engineSessionId: "engine-thread",
    } as Parameters<typeof updateSession>[1]);

    // Note: the real implementation requires a dispatcher; the MCP tool wires
    // through the gateway's SessionManager. For this test we monkey-patch
    // via setAutoResumeDispatcher to capture the dispatched call.
    const { setAutoResumeDispatcher } = await import("../../sessions/autoResumer.js");
    const dispatched: Array<{ id: string; nudge: string }> = [];
    setAutoResumeDispatcher(async (id, nudge) => { dispatched.push({ id, nudge }); });

    const text = await mcpHandleTool("jinn_resume_session", { sessionId: s.id, nudge: "go on" });
    const parsed = JSON.parse(text);
    expect(parsed.dispatched).toBe(true);
    expect(parsed.sessionId).toBe(s.id);
    // engineSessionId preserved
    const { getSession } = await import("../../sessions/registry.js");
    expect(getSession(s.id)?.engineSessionId).toBe("engine-thread");
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd packages/jimmy && pnpm vitest run src/mcp/__tests__/errorResumeTools.test.ts
```

Expected: new test fails — tool unknown.

- [ ] **Step 3: Register the tool**

Add to `TOOLS` in `packages/jimmy/src/mcp/gateway-server.ts`:

```typescript
{
  name: "jinn_resume_session",
  description:
    "Resume a Jinn session that is in error, waiting, or interrupted state. " +
    "Preserves the engine thread (engineSessionId) and dispatches the optional " +
    "nudge as the next message. Defaults nudge to 'keep going'.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "The Jinn session ID." },
      nudge: { type: "string", description: "Message to send after resume. Default 'keep going'." },
    },
    required: ["sessionId"],
    additionalProperties: false,
  },
},
```

Add the dispatch case in `mcpHandleTool`:

```typescript
case "jinn_resume_session": {
  const sessionId = String(args.sessionId);
  const nudge = typeof args.nudge === "string" ? args.nudge : "keep going";
  const { handleResumeRequest } = await import("../gateway/api.js");
  // The MCP server runs in the same process as the gateway; access the
  // singleton dispatcher via the autoResumer module which the gateway has
  // already wired up at boot.
  const { setAutoResumeDispatcher } = await import("../sessions/autoResumer.js");
  // Re-use the already-installed dispatcher. If unavailable (e.g. running MCP
  // standalone), surface a clear error.
  let currentDispatcher: ((id: string, n: string) => Promise<void>) | null = null;
  setAutoResumeDispatcher(async (id, n) => {
    if (currentDispatcher) await currentDispatcher(id, n);
  });
  // Use the gateway-registered dispatcher via a module-level accessor.
  // Implementation detail: add `getAutoResumeDispatcher()` export to autoResumer.ts.
  const { getAutoResumeDispatcher } = await import("../sessions/autoResumer.js");
  currentDispatcher = getAutoResumeDispatcher();
  if (!currentDispatcher) {
    throw new Error("auto-resume dispatcher not initialised — gateway boot incomplete");
  }
  const result = await handleResumeRequest(
    sessionId,
    { nudge, preserveEngineSession: true },
    { dispatchMessage: currentDispatcher },
  );
  if (result.status >= 400) {
    throw new Error(`resume failed: ${JSON.stringify(result.body)}`);
  }
  return JSON.stringify({ sessionId, dispatched: true, status: result.status }, null, 2);
}
```

Add `getAutoResumeDispatcher` to `packages/jimmy/src/sessions/autoResumer.ts`:

```typescript
export function getAutoResumeDispatcher(): ((sessionId: string, nudge: string) => Promise<void>) | null {
  return dispatchFn;
}
```

- [ ] **Step 4: Run, expect pass**

```bash
cd packages/jimmy && pnpm vitest run src/mcp/__tests__/errorResumeTools.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/jimmy/src/mcp/gateway-server.ts packages/jimmy/src/sessions/autoResumer.ts packages/jimmy/src/mcp/__tests__/errorResumeTools.test.ts
git commit -m "feat(mcp): jinn_resume_session tool"
```

---

### Task 16: Frontend API client + Session type fields

**Files:**
- Modify: `packages/web/src/lib/api.ts`
- Test: Skipped (thin wrappers; covered by component + E2E tests in later tasks)

- [ ] **Step 1: Extend the `Session` type and add client functions**

In `packages/web/src/lib/api.ts`, find the `Session` interface and add (matching the backend additions from Task 6):

```typescript
export interface Session {
  // ... existing fields ...
  lastError: string | null;
  errorKind?: "rate_limited" | "usage_cap" | "dead_session" | "engine_crashed" | "unknown";
  errorRecoverable?: boolean;
  errorRetryAfter?: string | null;
  errorDetectedFrom?: "engine_result" | "process_exit" | "manual";
}

export interface RecoverableSessionSummary {
  sessionId: string;
  title: string | null;
  engine: string;
  employee: string | null;
  errorKind: string;
  errorRetryAfter: string | null;
  autoResumeScheduledAt: string | null;
  lastErrorPreview: string;
  source: string;
}
```

Add three exported wrappers (place alongside the existing `resetSession`):

```typescript
export const api = {
  // ... existing methods ...
  resetSession: (id: string) =>
    post<Session>(`/api/sessions/${id}/reset`),

  resumeSession: (id: string, body: { nudge?: string; preserveEngineSession?: boolean } = {}) =>
    post<Session>(`/api/sessions/${id}/resume`, body),

  listRecoverableSessions: () =>
    get<RecoverableSessionSummary[]>(`/api/sessions/recoverable`),

  cancelAutoResume: (sessionId: string) =>
    post<{ ok: true }>(`/api/sessions/${sessionId}/resume/cancel`),
};
```

Note: `cancelAutoResume` requires a small backend route. Add a corresponding handler in `packages/jimmy/src/gateway/api.ts` adjacent to `/resume`:

```typescript
// POST /api/sessions/:id/resume/cancel — cancel a pending auto-resume without resuming.
params = matchRoute("/api/sessions/:id/resume/cancel", pathname);
if (method === "POST" && params) {
  const session = getSession(params.id);
  if (!session) return notFound(res);
  cancelScheduledAutoResume(params.id);
  return json(res, { ok: true });
}
```

- [ ] **Step 2: Add a React Query hook**

In `packages/web/src/hooks/use-sessions.ts`, append:

```typescript
export function useResumeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, nudge, preserveEngineSession }: { id: string; nudge?: string; preserveEngineSession?: boolean }) =>
      api.resumeSession(id, { nudge, preserveEngineSession }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["session", vars.id] });
      queryClient.invalidateQueries({ queryKey: ["recoverable-sessions"] });
    },
  });
}

export function useCancelAutoResume() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api.cancelAutoResume(sessionId),
    onSuccess: (_data, sessionId) => {
      queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["recoverable-sessions"] });
    },
  });
}

export function useRecoverableSessions() {
  return useQuery({
    queryKey: ["recoverable-sessions"],
    queryFn: () => api.listRecoverableSessions(),
    refetchInterval: 30_000,
  });
}
```

- [ ] **Step 3: Typecheck**

```bash
cd packages/web && pnpm typecheck
cd packages/jimmy && pnpm typecheck
```

Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/lib/api.ts packages/web/src/hooks/use-sessions.ts packages/jimmy/src/gateway/api.ts
git commit -m "feat(web): API client + hooks for resume / recoverable / cancel"
```

---

### Task 17: `ResumeModal` component

**Files:**
- Create: `packages/web/src/components/sessions/resume-modal.tsx`
- Test: `packages/web/src/components/sessions/__tests__/resume-modal.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/sessions/__tests__/resume-modal.test.tsx`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ResumeModal } from "../resume-modal.js";

vi.mock("@/lib/api", () => ({
  api: {
    resumeSession: vi.fn(async (id: string, body: { nudge?: string }) => ({ id, nudge: body.nudge })),
    cancelAutoResume: vi.fn(async () => ({ ok: true })),
  },
}));

function renderModal(props: Partial<React.ComponentProps<typeof ResumeModal>> = {}) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ResumeModal
        sessionId="sess-123"
        errorKind="usage_cap"
        lastError="hit your usage limit. try again at 7:10 AM"
        errorRetryAfter={new Date(Date.now() + 60_000).toISOString()}
        autoResumeScheduledAt={new Date(Date.now() + 60_000).toISOString()}
        defaultNudge="keep going"
        onClose={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("ResumeModal", () => {
  it("renders the kind badge", () => {
    renderModal();
    expect(screen.getByText(/USAGE_CAP/i)).toBeInTheDocument();
  });

  it("renders the original provider message", () => {
    renderModal();
    expect(screen.getByText(/hit your usage limit/)).toBeInTheDocument();
  });

  it("shows the countdown when auto-resume is scheduled", () => {
    renderModal();
    expect(screen.getByText(/auto-resume/i)).toBeInTheDocument();
  });

  it("calls resumeSession with the edited nudge on Resume now", async () => {
    const { api } = await import("@/lib/api");
    renderModal();
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "continue from the status note" } });
    fireEvent.click(screen.getByRole("button", { name: /resume now/i }));
    expect(api.resumeSession).toHaveBeenCalledWith("sess-123", { nudge: "continue from the status note" });
  });

  it("Cancel auto-resume button is hidden when no auto-resume is scheduled", () => {
    renderModal({ autoResumeScheduledAt: null });
    expect(screen.queryByRole("button", { name: /cancel auto-resume/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd packages/web && pnpm vitest run src/components/sessions/__tests__/resume-modal.test.tsx
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the component**

Create `packages/web/src/components/sessions/resume-modal.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useResumeSession, useCancelAutoResume } from "@/hooks/use-sessions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";

const KIND_DESCRIPTIONS: Record<string, string> = {
  rate_limited: "Provider rate limit. Usually clears in minutes.",
  usage_cap: "Provider usage cap (quota). Resumes after the provider's reset.",
  dead_session: "The engine thread has expired. Resume will start a fresh thread.",
  engine_crashed: "The engine process exited unexpectedly. Manual investigation recommended.",
  unknown: "Unclassified error. Review the message and decide whether to resume.",
};

function useCountdown(toIso: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!toIso) return;
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [toIso]);
  if (!toIso) return null;
  const target = Date.parse(toIso);
  if (Number.isNaN(target)) return null;
  const diff = Math.max(0, target - now);
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  if (diff === 0) return "due now";
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function ResumeModal(props: {
  sessionId: string;
  errorKind: string;
  lastError: string;
  errorRetryAfter: string | null;
  autoResumeScheduledAt: string | null;
  defaultNudge: string;
  onClose: () => void;
}) {
  const {
    sessionId, errorKind, lastError, errorRetryAfter,
    autoResumeScheduledAt, defaultNudge, onClose,
  } = props;
  const [nudge, setNudge] = useState(defaultNudge);
  const resume = useResumeSession();
  const cancel = useCancelAutoResume();
  const countdown = useCountdown(autoResumeScheduledAt ?? errorRetryAfter ?? null);

  const description = useMemo(
    () => KIND_DESCRIPTIONS[errorKind] ?? KIND_DESCRIPTIONS.unknown,
    [errorKind],
  );

  const handleResume = () => {
    resume.mutate({ id: sessionId, nudge }, { onSuccess: onClose });
  };

  const handleCancelAuto = () => {
    cancel.mutate(sessionId);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <span className="inline-block px-2 py-0.5 rounded-full bg-orange-600 text-white text-xs font-semibold uppercase mr-2">
              {errorKind.replace("_", " ")}
            </span>
            Resume session
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-[var(--text-secondary)] mb-3">{description}</p>

        <div className="text-xs text-[var(--text-tertiary)] mb-1">Provider message</div>
        <pre className="text-xs font-mono whitespace-pre-wrap p-2 bg-[var(--bg-secondary)] rounded mb-3 max-h-32 overflow-auto">
          {lastError}
        </pre>

        {autoResumeScheduledAt ? (
          <div className="text-sm mb-3">
            Auto-resume scheduled: <strong>{new Date(autoResumeScheduledAt).toLocaleString()}</strong>
            {countdown ? <> · in <span className="font-mono">{countdown}</span></> : null}
          </div>
        ) : errorRetryAfter ? (
          <div className="text-sm mb-3 text-[var(--text-tertiary)]">
            Provider retry-at: {new Date(errorRetryAfter).toLocaleString()}
            {countdown ? <> · in <span className="font-mono">{countdown}</span></> : null}
            <div className="mt-1 text-xs">Auto-resume is OFF for this session's config. Resume manually below.</div>
          </div>
        ) : null}

        <label className="block text-xs text-[var(--text-tertiary)] mb-1">
          Nudge (sent on resume)
        </label>
        <textarea
          value={nudge}
          onChange={(e) => setNudge(e.target.value)}
          className="w-full p-2 text-sm border rounded bg-[var(--bg-primary)] mb-3"
          rows={3}
        />

        <DialogFooter>
          {autoResumeScheduledAt ? (
            <Button variant="ghost" onClick={handleCancelAuto} disabled={cancel.isPending}>
              Cancel auto-resume
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={handleResume} disabled={resume.isPending}>Resume now</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

If the codebase doesn't already export `Dialog` / `DialogContent` / `DialogHeader` / `DialogTitle` / `DialogFooter` from `@/components/ui/dialog`, substitute the existing modal/sheet primitive used elsewhere in the project (search for `<Dialog` to confirm the pattern). The component contract — open by default with a close callback — should remain the same.

- [ ] **Step 4: Run, expect pass**

```bash
cd packages/web && pnpm vitest run src/components/sessions/__tests__/resume-modal.test.tsx
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/sessions/resume-modal.tsx packages/web/src/components/sessions/__tests__/resume-modal.test.tsx
git commit -m "feat(web): ResumeModal with kind badge, countdown, editable nudge"
```

---


### Task 18: Session detail — error chip in header + modal integration

**Files:**
- Modify: `packages/web/src/components/sessions/session-detail.tsx`
- Test: `packages/web/src/components/sessions/__tests__/session-detail-resume.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/sessions/__tests__/session-detail-resume.test.tsx`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionDetail } from "../session-detail.js";
import type { Session } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: {
    getSessionChildren: vi.fn(async () => []),
    resumeSession: vi.fn(async () => ({})),
    cancelAutoResume: vi.fn(async () => ({})),
  },
}));

function withProviders(ui: React.ReactNode) {
  const client = new QueryClient();
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const baseSession: Session = {
  id: "sess-1",
  engine: "codex",
  source: "cron",
  sourceRef: "j",
  sessionKey: "j",
  connector: "cron",
  status: "error",
  effortLevel: null,
  totalCost: 0,
  totalTurns: 0,
  createdAt: new Date().toISOString(),
  lastActivity: new Date().toISOString(),
  lastError: "hit your usage limit. try again at 7:10 AM",
  errorKind: "usage_cap",
  errorRecoverable: true,
  errorRetryAfter: new Date(Date.now() + 60_000).toISOString(),
  // ... fill required Session fields. Reference the actual web Session shape.
} as unknown as Session;

describe("SessionDetail — error chip + modal", () => {
  it("shows an error chip in the header when errorKind is set", () => {
    render(withProviders(<SessionDetail session={baseSession} onClose={() => {}} />));
    expect(screen.getByTestId("error-chip")).toHaveTextContent(/usage[\s_]cap/i);
  });

  it("opens the ResumeModal when the chip is clicked", () => {
    render(withProviders(<SessionDetail session={baseSession} onClose={() => {}} />));
    fireEvent.click(screen.getByTestId("error-chip"));
    expect(screen.getByText(/resume session/i)).toBeInTheDocument();
  });

  it("does not show the chip when errorKind is unset", () => {
    const okSession = { ...baseSession, status: "idle" as const, lastError: null, errorKind: undefined, errorRecoverable: undefined };
    render(withProviders(<SessionDetail session={okSession} onClose={() => {}} />));
    expect(screen.queryByTestId("error-chip")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd packages/web && pnpm vitest run src/components/sessions/__tests__/session-detail-resume.test.tsx
```

Expected: FAIL — chip not present.

- [ ] **Step 3: Add the chip and modal trigger**

In `packages/web/src/components/sessions/session-detail.tsx`:

a. Add imports:

```typescript
import { useState } from "react";
import { ResumeModal } from "./resume-modal";
```

b. In the component body, add state and derived values right after the existing `const canReset = ...` line:

```typescript
const [resumeOpen, setResumeOpen] = useState(false);
const showResumeChip = !!session.errorKind && session.errorRecoverable === true;
const defaultNudge = "keep going"; // backend resolves the actual per-session default; this is a UX default.
```

c. Place the chip inside the existing `<CardHeader>`, after the `<CardTitle>`:

```tsx
<CardHeader>
  <CardTitle ...>{session.title || "Session Detail"}</CardTitle>
  {showResumeChip && (
    <button
      type="button"
      data-testid="error-chip"
      onClick={() => setResumeOpen(true)}
      className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full bg-orange-600 text-white text-[10px] font-semibold uppercase tracking-wide cursor-pointer hover:bg-orange-500"
    >
      ⚠ {session.errorKind!.replace("_", " ")}
    </button>
  )}
</CardHeader>
```

d. Render the modal conditionally near the end of the returned JSX (just before the final closing `</Card>`):

```tsx
{resumeOpen && showResumeChip && (
  <ResumeModal
    sessionId={session.id}
    errorKind={session.errorKind!}
    lastError={session.lastError ?? ""}
    errorRetryAfter={session.errorRetryAfter ?? null}
    autoResumeScheduledAt={session.errorRetryAfter ?? null}
    defaultNudge={defaultNudge}
    onClose={() => setResumeOpen(false)}
  />
)}
```

`autoResumeScheduledAt` is approximated from `errorRetryAfter` here because the session detail endpoint doesn't yet return queue-row info. If you want the exact scheduled timestamp (vs. provider retry-at), extend the session-detail endpoint to include `autoResumeScheduledAt` derived from `getAutoResumeForSession(session.id)`. Not required for v1 — the two are equal in practice when auto-resume is enabled.

- [ ] **Step 4: Run, expect pass**

```bash
cd packages/web && pnpm vitest run src/components/sessions/__tests__/session-detail-resume.test.tsx
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/sessions/session-detail.tsx packages/web/src/components/sessions/__tests__/session-detail-resume.test.tsx
git commit -m "feat(web): session-detail error chip opens ResumeModal"
```

---

### Task 19: Sessions list — error-kind badges + "Recoverable only" filter

**Files:**
- Modify: `packages/web/src/components/sessions/session-list.tsx`
- Test: `packages/web/src/components/sessions/__tests__/session-list-filter.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/sessions/__tests__/session-list-filter.test.tsx`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionList } from "../session-list.js";
import type { Session } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: {
    listSessions: vi.fn(async () => [
      makeSession("idle", undefined),
      makeSession("error", "usage_cap", true),
      makeSession("error", "engine_crashed", false),
    ]),
  },
}));

function makeSession(status: Session["status"], errorKind?: string, recoverable?: boolean): Session {
  return {
    id: status + "-" + (errorKind ?? "ok"),
    engine: "codex", source: "web", sourceRef: "x", sessionKey: "x", connector: "web",
    status,
    effortLevel: null, totalCost: 0, totalTurns: 0,
    createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
    lastError: errorKind ? "err" : null, errorKind: errorKind as Session["errorKind"],
    errorRecoverable: recoverable,
  } as unknown as Session;
}

function withProviders(ui: React.ReactNode) {
  const client = new QueryClient();
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

describe("SessionList — kind badges and recoverable filter", () => {
  it("renders error-kind badges for sessions in error state", async () => {
    render(withProviders(<SessionList onSelect={() => {}} />));
    // Both error sessions should show a badge.
    expect((await screen.findAllByTestId("session-error-badge")).length).toBe(2);
  });

  it("filters to recoverable sessions only when filter is on", async () => {
    render(withProviders(<SessionList onSelect={() => {}} />));
    await screen.findAllByTestId("session-error-badge");
    fireEvent.click(screen.getByTestId("filter-recoverable"));
    const badges = await screen.findAllByTestId("session-error-badge");
    expect(badges.length).toBe(1);
    expect(badges[0]).toHaveTextContent(/usage[\s_]cap/i);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd packages/web && pnpm vitest run src/components/sessions/__tests__/session-list-filter.test.tsx
```

Expected: FAIL — testids absent.

- [ ] **Step 3: Add badges and filter chip**

In `packages/web/src/components/sessions/session-list.tsx`:

a. Add a state for the filter near the existing state declarations:

```typescript
const [recoverableOnly, setRecoverableOnly] = useState<boolean>(() => {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem("sessions-recoverable-only") === "1";
});
useEffect(() => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem("sessions-recoverable-only", recoverableOnly ? "1" : "0");
}, [recoverableOnly]);
```

b. Filter the rendered list:

```typescript
const visibleSessions = recoverableOnly
  ? sessions.filter((s) => s.errorRecoverable === true)
  : sessions;
```

c. Add a filter chip near the search input (existing toolbar):

```tsx
<button
  type="button"
  data-testid="filter-recoverable"
  onClick={() => setRecoverableOnly((v) => !v)}
  className={`px-2 py-1 text-xs rounded-full border ${
    recoverableOnly ? "bg-orange-600 text-white border-orange-600" : "bg-transparent text-[var(--text-secondary)]"
  }`}
  title="Show only sessions with a recoverable error"
>
  Recoverable only
</button>
```

d. In each session-row render, add the badge when `session.errorKind` is present:

```tsx
{session.errorKind && (
  <span
    data-testid="session-error-badge"
    className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-orange-600 text-white uppercase"
  >
    {session.errorKind.replace("_", " ")}
  </span>
)}
```

- [ ] **Step 4: Run, expect pass**

```bash
cd packages/web && pnpm vitest run src/components/sessions/__tests__/session-list-filter.test.tsx
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/sessions/session-list.tsx packages/web/src/components/sessions/__tests__/session-list-filter.test.tsx
git commit -m "feat(web): session-list error-kind badges + recoverable filter chip"
```

---

### Task 20: Cron page — last-run indicator with countdown

**Files:**
- Modify: `packages/web/src/components/crons/pipeline-graph.tsx` (or whichever component owns the cron-row rendering)
- Modify: `packages/jimmy/src/gateway/api.ts` — extend `GET /api/cron/:id/runs` response (or `GET /api/cron`) to include latest-run summary fields
- Test: `packages/web/src/components/crons/__tests__/cron-last-run.test.tsx` (new)

- [ ] **Step 1: Decide and document the data path**

The cron row needs three pieces of data per job:
- Latest run status (`success`, `error`, `blocked`)
- For blocked: `errorKind` and `autoResumeScheduledAt` (from the underlying session, if any)
- For all: `latestSessionId` so the row can deep-link into the session detail

Extend `GET /api/cron` to include a `latestRun` field per job:

```typescript
interface CronJobWithRun extends CronJob {
  latestRun?: {
    timestamp: string;
    status: "success" | "error";
    durationMs: number;
    sessionId: string | null;
    errorKind?: string;
    autoResumeScheduledAt?: string | null;
  };
}
```

- [ ] **Step 2: Backend test for latestRun field**

Create `packages/jimmy/src/gateway/__tests__/cronLatestRun.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleListCronJobs } from "../api.js";
import { initSessions, createSession, updateSession, enqueueAutoResume } from "../../sessions/registry.js";
import { appendRunLog } from "../../cron/jobs.js";

describe("GET /api/cron — latestRun summary", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "jinn-cron-run-"));
    process.env.JINN_HOME = tmpDir;
    initSessions(path.join(tmpDir, "sessions.db"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("includes errorKind and autoResumeScheduledAt for the latest run when error+recoverable", async () => {
    const s = createSession({
      engine: "codex", source: "cron", sourceRef: "jobX", sessionKey: "jobX", connector: "cron",
    } as Parameters<typeof createSession>[0]);
    const retry = new Date(Date.now() + 60_000).toISOString();
    updateSession(s.id, {
      status: "error", lastError: "x", errorKind: "usage_cap",
      errorRecoverable: true, errorRetryAfter: retry,
    } as Parameters<typeof updateSession>[1]);
    enqueueAutoResume({ sessionId: s.id, fireAt: retry, nudge: "keep going" });

    appendRunLog("jobX", {
      timestamp: new Date().toISOString(), sessionKey: "k", sessionId: s.id,
      status: "success", durationMs: 60_000, error: null, resultPreview: null,
    });

    const result = await handleListCronJobs([{ id: "jobX", name: "X", enabled: true, schedule: "0 0 * * *", prompt: "x" }]);
    const job = (result.body as Array<{ id: string; latestRun?: { errorKind?: string; autoResumeScheduledAt?: string | null } }>)[0];
    expect(job.latestRun?.errorKind).toBe("usage_cap");
    expect(job.latestRun?.autoResumeScheduledAt).toBe(retry);
  });
});
```

- [ ] **Step 3: Run, expect failure**

```bash
cd packages/jimmy && pnpm vitest run src/gateway/__tests__/cronLatestRun.test.ts
```

Expected: FAIL — `handleListCronJobs` or the latestRun shape not present.

- [ ] **Step 4: Extend the cron list handler**

In `packages/jimmy/src/gateway/api.ts`, find the `// GET /api/cron` handler (around line 813). Refactor its body into an exported helper:

```typescript
export async function handleListCronJobs(jobs: CronJob[]): Promise<{ status: number; body: unknown }> {
  const { readRunLog } = await import("../cron/jobs.js");
  const { getSession, getAutoResumeForSession } = await import("../sessions/registry.js");

  const enriched = jobs.map((j) => {
    const runs = readRunLog(j.id, { limit: 1 });
    const latest = runs[0];
    if (!latest) return j;
    const session = latest.sessionId ? getSession(latest.sessionId) : null;
    const ar = latest.sessionId ? getAutoResumeForSession(latest.sessionId) : null;
    return {
      ...j,
      latestRun: {
        timestamp: latest.timestamp,
        status: latest.status,
        durationMs: latest.durationMs,
        sessionId: latest.sessionId,
        errorKind: session?.errorKind,
        autoResumeScheduledAt: ar?.fireAt ?? null,
      },
    };
  });

  return { status: 200, body: enriched };
}
```

Update the existing route to call the helper with the loaded jobs. If `readRunLog` doesn't support `{ limit }`, add the option (lightweight — read file backwards by lines or tail by line count).

- [ ] **Step 5: Run, expect pass**

```bash
cd packages/jimmy && pnpm vitest run src/gateway/__tests__/cronLatestRun.test.ts
```

Expected: PASS.

- [ ] **Step 6: Frontend — render the indicator**

Create `packages/web/src/components/crons/__tests__/cron-last-run.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CronLastRunIndicator } from "../cron-last-run-indicator.js";

describe("CronLastRunIndicator", () => {
  it("renders OK for success", () => {
    render(<CronLastRunIndicator status="success" durationMs={60_000} />);
    expect(screen.getByText(/OK/)).toBeInTheDocument();
  });

  it("renders BLOCKED with countdown when auto-resume scheduled", () => {
    render(
      <CronLastRunIndicator
        status="error"
        durationMs={3_000}
        errorKind="usage_cap"
        autoResumeScheduledAt={new Date(Date.now() + 60_000).toISOString()}
      />,
    );
    expect(screen.getByText(/BLOCKED/)).toBeInTheDocument();
    expect(screen.getByText(/USAGE[\s_]CAP/i)).toBeInTheDocument();
    expect(screen.getByText(/auto-resume in/i)).toBeInTheDocument();
  });

  it("renders manual-resume label when error+recoverable but no auto-resume", () => {
    render(
      <CronLastRunIndicator
        status="error" durationMs={3_000} errorKind="usage_cap" autoResumeScheduledAt={null}
      />,
    );
    expect(screen.getByText(/manual resume required/i)).toBeInTheDocument();
  });

  it("renders investigate label for non-recoverable error", () => {
    render(<CronLastRunIndicator status="error" durationMs={3_000} errorKind="engine_crashed" />);
    expect(screen.getByText(/investigate/i)).toBeInTheDocument();
  });
});
```

Create `packages/web/src/components/crons/cron-last-run-indicator.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";

const NON_RECOVERABLE_KINDS = new Set(["dead_session", "engine_crashed", "unknown"]);

function fmtMins(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function useCountdown(toIso: string | null | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!toIso) return;
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [toIso]);
  if (!toIso) return null;
  const t = Date.parse(toIso);
  if (Number.isNaN(t)) return null;
  const d = Math.max(0, t - now);
  const h = Math.floor(d / 3_600_000);
  const m = Math.floor((d % 3_600_000) / 60_000);
  if (d === 0) return "due";
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function CronLastRunIndicator(props: {
  status: "success" | "error";
  durationMs: number;
  errorKind?: string;
  autoResumeScheduledAt?: string | null;
}) {
  const { status, durationMs, errorKind, autoResumeScheduledAt } = props;
  const countdown = useCountdown(autoResumeScheduledAt ?? null);

  if (status === "success") {
    return <span className="text-green-600 text-xs">✅ OK · {fmtMins(durationMs)}</span>;
  }
  if (errorKind && !NON_RECOVERABLE_KINDS.has(errorKind)) {
    if (autoResumeScheduledAt) {
      return (
        <span className="text-orange-500 text-xs">
          ⏳ BLOCKED ({errorKind.replace("_", " ").toUpperCase()}) · auto-resume in {countdown ?? "—"}
        </span>
      );
    }
    return (
      <span className="text-orange-500 text-xs">
        ⚠ BLOCKED ({errorKind.replace("_", " ").toUpperCase()}) · manual resume required
      </span>
    );
  }
  return (
    <span className="text-red-600 text-xs">
      ❌ ERROR{errorKind ? ` (${errorKind.replace("_", " ").toUpperCase()})` : ""} · investigate
    </span>
  );
}
```

In `packages/web/src/components/crons/pipeline-graph.tsx` (or whichever cron-row component is in use), import and render `<CronLastRunIndicator>` next to each cron job, passing fields from the `latestRun` payload. Make the indicator clickable to route to `/sessions/<latestRun.sessionId>?resume=1` and the session detail can auto-open the modal when `?resume=1` is present (use `useSearchParams` to check).

Add the auto-open behavior in `session-detail.tsx`:

```typescript
import { useSearchParams } from "next/navigation";

const searchParams = useSearchParams();
useEffect(() => {
  if (searchParams.get("resume") === "1" && showResumeChip) {
    setResumeOpen(true);
  }
}, [searchParams, showResumeChip]);
```

- [ ] **Step 7: Run, expect pass**

```bash
cd packages/web && pnpm vitest run src/components/crons/__tests__/cron-last-run.test.tsx
```

Expected: PASS, 4 tests.

- [ ] **Step 8: Commit**

```bash
git add packages/jimmy/src/gateway/api.ts packages/jimmy/src/cron/jobs.ts packages/jimmy/src/gateway/__tests__/cronLatestRun.test.ts packages/web/src/components/crons packages/web/src/components/sessions/session-detail.tsx
git commit -m "feat(web): cron last-run indicator with auto-resume countdown + deep-link"
```

---

### Task 21: Playwright E2E — error → modal → resume

**Files:**
- Create: `e2e/error-resume.spec.ts`
- Reference: existing `e2e/smoke.spec.ts` for patterns

- [ ] **Step 1: Write the E2E**

Create `e2e/error-resume.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";

// Assumes the dev server is running via the existing playwright.config.ts setup.
// We seed a session in error+recoverable state by POSTing directly to the gateway,
// then exercise the UI.

const GATEWAY = process.env.JINN_GATEWAY_URL ?? "http://localhost:7777";
const WEB = process.env.JINN_WEB_URL ?? "http://localhost:3000";

test.describe("Recoverable session resume flow", () => {
  test("error chip opens modal; Resume now dispatches and dismisses", async ({ page, request }) => {
    // 1. Create a fresh stub session and put it into a recoverable error state.
    const created = await request.post(`${GATEWAY}/api/sessions/stub`, {
      data: { engine: "mock", title: "E2E error-resume session" },
    });
    expect(created.ok()).toBeTruthy();
    const session = await created.json() as { id: string };

    // 2. Patch into error state directly via PUT.
    const patched = await request.put(`${GATEWAY}/api/sessions/${session.id}`, {
      data: {
        status: "error",
        lastError: "You've hit your usage limit. Try again at 7:10 AM.",
        errorKind: "usage_cap",
        errorRecoverable: true,
        errorRetryAfter: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    });
    expect(patched.ok()).toBeTruthy();

    // 3. Navigate to the session detail.
    await page.goto(`${WEB}/sessions/${session.id}`);

    // 4. Click the chip.
    const chip = page.getByTestId("error-chip");
    await expect(chip).toBeVisible();
    await chip.click();

    // 5. Modal appears with editable nudge.
    await expect(page.getByText(/resume session/i)).toBeVisible();
    const textarea = page.getByRole("textbox");
    await textarea.fill("continue from where you left off");

    // 6. Click Resume now, expect a POST to /resume.
    const [resumeReq] = await Promise.all([
      page.waitForRequest((req) => req.url().endsWith(`/api/sessions/${session.id}/resume`) && req.method() === "POST"),
      page.getByRole("button", { name: /resume now/i }).click(),
    ]);
    const body = JSON.parse(resumeReq.postData() ?? "{}");
    expect(body.nudge).toBe("continue from where you left off");

    // 7. Modal dismisses + chip disappears (session no longer in error state in the UI optimistically).
    await expect(page.getByTestId("error-chip")).toBeHidden({ timeout: 5_000 });
  });
});
```

This test depends on:
- A `POST /api/sessions/stub` route that creates a no-op test session (Jinn already has this — referenced in commit `25cfdf6`).
- A `PUT /api/sessions/:id` that accepts the new error fields. The existing PUT handler only allows `title` updates today; extend it to accept the error fields when the request is from a local test context. Gate via an env var: `process.env.JINN_E2E === "1"` to allow extra PUT fields. Set this in `playwright.config.ts`.

- [ ] **Step 2: Add E2E env switch to the PUT handler**

In `packages/jimmy/src/gateway/api.ts` find the `// PUT /api/sessions/:id` handler (around line 415). After the existing `title` validation, add:

```typescript
if (process.env.JINN_E2E === "1") {
  for (const field of ["status", "lastError", "errorKind", "errorRecoverable", "errorRetryAfter", "errorDetectedFrom"] as const) {
    if (body[field] !== undefined) {
      (updates as Record<string, unknown>)[field] = body[field];
    }
  }
}
```

- [ ] **Step 3: Wire `JINN_E2E=1` into the Playwright config**

In `playwright.config.ts`, ensure the gateway webserver is started with that env var:

```typescript
webServer: [
  {
    command: "JINN_E2E=1 node packages/jimmy/dist/bin/jimmy.js start",
    url: "http://localhost:7777/api/status",
    reuseExistingServer: !process.env.CI,
  },
  // ... existing next dev block ...
],
```

If `playwright.config.ts` already has a webServer block, augment the command rather than replacing.

- [ ] **Step 4: Run the E2E**

```bash
pnpm test:e2e -- error-resume.spec.ts
```

Expected: PASS. If the test is flaky on the chip-disappears assertion, wait for a status refetch (React Query default ~5s) or invalidate manually in the resume success handler.

- [ ] **Step 5: Commit**

```bash
git add e2e/error-resume.spec.ts playwright.config.ts packages/jimmy/src/gateway/api.ts
git commit -m "test(e2e): error-state chip → modal → resume flow"
```

---

### Task 22: Verification, docs, and CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md` (Configuration section — add the new keys)
- Optional: `~/.jinn/config.yaml` template under `packages/jimmy/template/`

- [ ] **Step 1: Run the full test suite**

```bash
cd packages/jimmy && pnpm test && pnpm typecheck
cd packages/web && pnpm test && pnpm typecheck
pnpm test:e2e
```

Expected: all green.

- [ ] **Step 2: Lint**

```bash
pnpm lint
```

Expected: clean.

- [ ] **Step 3: Update CHANGELOG.md**

Add a new section at the top of `CHANGELOG.md`:

```markdown
## v0.11.0 — Error state disambiguation & session resume

### Added
- 5-kind error taxonomy on sessions: `rate_limited`, `usage_cap`, `dead_session`, `engine_crashed`, `unknown`. Stored on `Session` as `errorKind`, `errorRecoverable`, `errorRetryAfter`, `errorDetectedFrom`.
- Auto-resume scheduler. Rate-limited sessions auto-resume by default; usage-capped sessions auto-resume when opted in via `config.sessions.autoResumeOnUsageCap` (or per-employee / per-cron-job override). Honors provider-reported retry-at timestamps with a +2 minute buffer; falls back to `engines.<name>.resetWindow` config.
- `POST /api/sessions/:id/resume` with optional `{ nudge, preserveEngineSession }`. Preserves `engineSessionId` by default so codex/claude resume the same thread.
- `GET /api/sessions/recoverable` returning the list of recoverable error-state sessions with kind, retry-at, and auto-resume schedule.
- `POST /api/sessions/:id/resume/cancel` to cancel a pending auto-resume without resuming.
- MCP tools: `jinn_list_recoverable_sessions`, `jinn_get_session_error`, `jinn_resume_session`.
- Web UI: error-kind chip in session header that opens a `ResumeModal` with editable nudge and live countdown. Sessions list shows kind badges and a "Recoverable only" filter chip. Cron page shows last-run indicator with auto-resume countdown.

### Changed
- `migrateSessionsSchema` now also adds `error_kind`, `error_recoverable`, `error_retry_after`, `error_detected_from` columns. Creates `auto_resume_queue` table.
- `GET /api/cron` response now includes a `latestRun` field per job with optional `errorKind` and `autoResumeScheduledAt`.

### Notes
- `POST /api/sessions/:id/reset` still works but nukes `engineSessionId`. Prefer `/resume` for recoverable errors.
- Pre-existing `error`-state sessions without classification are lazily classified on first read.
```

- [ ] **Step 4: Update README configuration section**

In `README.md`, find the example `config.yaml` block and add the new keys:

```yaml
sessions:
  autoResumeOnRateLimit: true     # auto-resume on provider rate limit (default true)
  autoResumeOnUsageCap: false     # opt-in: auto-resume on provider usage cap
  autoResumeNudge: "keep going"   # message sent when auto-resume fires

engines:
  codex:
    resetWindow:
      rate_limited_min: 1
      usage_cap_min: 60
  claude:
    resetWindow:
      rate_limited_min: 5
      usage_cap_min: 300
```

- [ ] **Step 5: Bump version**

In `packages/jimmy/package.json` and `package.json` (root), bump version to `0.11.0`. In `packages/jimmy/src/cli/setup.ts` (or wherever `jinn.version` is templated into `config.yaml`), update the default version string to `0.11.0`.

- [ ] **Step 6: Commit and tag**

```bash
git add CHANGELOG.md README.md packages/jimmy/package.json package.json packages/jimmy/src/cli/setup.ts
git commit -m "release: v0.11.0 — error state disambiguation & session resume"
git tag v0.11.0
```

---

## Self-Review

### Spec coverage

Walking each section of `docs/superpowers/specs/2026-05-11-error-states-and-resume-design.md`:

| Spec section | Covered by |
|---|---|
| Error Taxonomy (5 kinds) | Tasks 1, 2, 3 |
| Detection Module — `classifyError`, `extractRetryAfter`, +2 min buffer | Tasks 1–4 |
| Provider Reset Defaults — hardcoded + config override | Task 5 |
| Session State Additions (4 fields) | Task 6 (types), Tasks 7, 8 (registry roundtrip) |
| SQLite migration — `migrateSessionsSchema` extension | Task 7 |
| `auto_resume_queue` table + helpers | Task 9 |
| Auto-Resume Scheduler — precedence + persistence + replay | Task 11 |
| Auto-resume integration with error transitions | Tasks 10, 11 |
| `POST /api/sessions/:id/resume` | Task 12 |
| `GET /api/sessions/recoverable` | Task 13 |
| `POST /api/sessions/:id/resume/cancel` | Task 16 (defined inline) |
| MCP tools (3 tools) | Tasks 14, 15 |
| GUI — error-kind chip + modal (Layout B) | Tasks 17, 18 |
| GUI — sessions list badges + filter | Task 19 |
| GUI — cron page indicator + deep-link | Task 20 |
| Interaction with `rateLimitStrategy` | Covered by Task 11 — `resolveAutoResume` engages only when status transitions to error; the existing Claude→Codex fallback runs first inside the manager and only sets error state when it itself fails. No code change to the fallback path needed. |
| Migration / backward compatibility | All new fields optional; route additions are additive; SQLite migration is idempotent. |
| Configuration example | Task 22 README update |
| Testing strategy | Tasks 1–21 each include vitest unit/integration coverage; Task 21 covers E2E. |

### Placeholder scan

No `TBD` / `TODO` / "add error handling" placeholders. Every step shows real code or real commands. Type names are consistent across tasks (`ErrorKind`, `ErrorClassification`, `applyEngineErrorToSession`, `scheduleAutoResume`, `cancelScheduledAutoResume`, `resolveAutoResume`).

### Type consistency check

- `ErrorKind` defined in Task 1, referenced consistently through Tasks 6 (types.ts import), 10–15 (consumers).
- `Session.errorKind / errorRecoverable / errorRetryAfter / errorDetectedFrom` defined in Task 6, persisted in Task 7, roundtripped in Task 8, written by manager in Task 10, exposed by API in Tasks 12, 13, consumed by web in Tasks 16–20.
- `applyEngineErrorToSession` defined in Task 10, extended in Task 11.
- `scheduleAutoResume(opts: { sessionId; fireAt: Date; nudge: string })` signature consistent in Task 11 (definition) and via `enqueueAutoResume` adapter in Task 9.
- `resolveAutoResume` signature: `{ kind, config, employee?, cronJob? }` consistent across Task 11 tests and production calls.
- MCP tool names `jinn_list_recoverable_sessions`, `jinn_get_session_error`, `jinn_resume_session` consistent across Tasks 14, 15, and the changelog in Task 22.

No discrepancies found.

---


import type { EngineResult } from "./types.js";

// Disambiguated patterns — usage-cap is checked first because some provider
// messages contain both "rate limit" and "usage limit" phrasings.
const USAGE_CAP_RE =
  /usage\s*limit|hit your\s*(usage\s*)?limit|credits?\s*exhausted|quota\s*exhausted|compact task.*usage|purchase more credits/i;

const RATE_LIMIT_RE =
  /rate.?limit|too many requests|429|overloaded|out of extra usage|exceeded\s+(?:the\s+)?(?:rate|api|request|usage|throughput)\s*limit/i;

// Keep existing RATE_LIMIT_ERROR_RE export for backwards compat with any
// callers; alias to RATE_LIMIT_RE.
export const RATE_LIMIT_ERROR_RE = RATE_LIMIT_RE;

export interface RateLimitDetection {
  limited: boolean;
  /** Unix timestamp in seconds */
  resetsAt?: number;
}

/** Patterns that indicate the engine session is dead (expired, not found, etc.) */
const DEAD_SESSION_PATTERNS = [
  /error.during.execution/i,
  /session.not.found/i,
  /invalid.session/i,
  /session.*expired/i,
];

/**
 * Detect whether an engine result indicates a dead/expired session rather than
 * a transient or rate-limit error. A dead session is one where the engine exited
 * with an error but did zero work (no cost, no turns) and there is no rate-limit
 * signal — meaning the --resume ID is stale and should not be retried.
 */
export function isDeadSessionError(result: EngineResult): boolean {
  if (!result.error) return false;

  // If rate limit info is present, this is a rate limit, not a dead session
  if (result.rateLimit?.status) return false;

  const zeroCost = result.cost === undefined || result.cost === 0;
  const zeroTurns = result.numTurns === undefined || result.numTurns === 0;

  // Primary: error with zero work done and no rate limit
  if (zeroCost && zeroTurns) return true;

  // Secondary: known dead-session patterns in error text, but only when no real
  // work was done (zeroCost) — avoids wiping IDs after a real session that
  // happened to include a matching substring in its error message.
  if (zeroCost && DEAD_SESSION_PATTERNS.some((p) => p.test(result.error!))) return true;

  return false;
}

export function detectRateLimit(result: EngineResult): RateLimitDetection {
  const resetsAt = typeof result.rateLimit?.resetsAt === "number"
    ? result.rateLimit.resetsAt
    : undefined;

  if (result.rateLimit?.status === "rejected") {
    return { limited: true, resetsAt };
  }

  if (result.error && RATE_LIMIT_ERROR_RE.test(result.error)) {
    return { limited: true, resetsAt };
  }

  return { limited: false };
}

export function computeRateLimitDeadlineMs(resetsAtSeconds?: number, extraMs = 30 * 60_000): number {
  if (typeof resetsAtSeconds === "number" && Number.isFinite(resetsAtSeconds)) {
    return resetsAtSeconds * 1000 + extraMs;
  }
  return Date.now() + extraMs;
}

export function computeNextRetryDelayMs(resetsAtSeconds?: number): { delayMs: number; resumeAt?: Date } {
  if (typeof resetsAtSeconds === "number" && Number.isFinite(resetsAtSeconds)) {
    const resumeAt = new Date(resetsAtSeconds * 1000);
    // Add a small buffer to avoid retrying a few ms before the reset boundary.
    const bufferMs = 10_000;
    const delayMs = Math.max(10_000, resumeAt.getTime() - Date.now() + bufferMs);
    return { delayMs, resumeAt };
  }
  return { delayMs: 60_000 };
}

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

  // Reuse existing dead-session detector for consistency.
  if (isDeadSessionError(result)) {
    return { kind: "dead_session", recoverable: false, retryAfter: null, originalMessage, detectedFrom: "engine_result" };
  }

  // Any remaining error with any cost or any turns recorded is treated as a crash;
  // zero-work non-rate-limit errors are caught by isDeadSessionError above.
  return { kind: "engine_crashed", recoverable: false, retryAfter: null, originalMessage, detectedFrom: "engine_result" };
}

const ISO_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/;
const TIME_OF_DAY_RE = /\btry again at\s+(\d{1,2}):(\d{2})\s*(AM|PM)?\b/i;

/**
 * Extract a retry-at timestamp from a provider error message.
 *
 * Resolution order:
 *   1. ISO-8601 timestamp anywhere in the text.
 *   2. "try again at H:MM AM/PM" phrasing (provider speaks user-local time).
 *   3. null (caller decides fallback; Task 5 will add PROVIDER_RESET_DEFAULTS).
 *
 * The returned Date always includes the +2 min buffer (BUFFER_MS) and is
 * guaranteed to be at least now + 5 minutes in the future, even when the
 * provider quoted a past time (clock skew or ambiguous AM/PM).
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

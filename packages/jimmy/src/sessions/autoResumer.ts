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
let tickInFlight = false;

type EventEmitter = (event: string, payload: Record<string, unknown>) => void;
let emitFn: EventEmitter | null = null;

/** Inject the event emitter. Called by gateway/server.ts at boot. */
export function setAutoResumeEmitter(fn: EventEmitter): void {
  emitFn = fn;
}

function emit(event: string, payload: Record<string, unknown>): void {
  if (emitFn) {
    try {
      emitFn(event, payload);
    } catch (err) {
      // Don't let emitter errors break dispatch
      logger.warn(
        `[autoResumer] event emit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export interface AutoResumeResolution {
  enabled: boolean;
  nudge: string;
}

const DEFAULT_NUDGE = "keep going";

/**
 * Resolve whether and how to auto-resume a session in error state.
 *
 * Precedence (most specific wins):
 *   cron job > employee > global config
 *
 * Defaults:
 *   rate_limited → enabled true (auto-resume is the natural recovery)
 *   usage_cap → enabled false (opt-in)
 *   non-recoverable kinds → never auto-resume
 *   nudge → "keep going" if not overridden
 */
export function resolveAutoResume(opts: {
  kind: ErrorKind;
  config: JinnConfig;
  employee?: Employee | null;
  cronJob?: CronJob | null;
}): AutoResumeResolution {
  const { kind, config, employee, cronJob } = opts;
  if (!RECOVERABLE_KINDS.has(kind)) {
    return { enabled: false, nudge: DEFAULT_NUDGE };
  }

  const fieldEnabled: "autoResumeOnRateLimit" | "autoResumeOnUsageCap" =
    kind === "rate_limited" ? "autoResumeOnRateLimit" : "autoResumeOnUsageCap";
  const globalDefault = kind === "rate_limited" ? true : false;

  const globalEnabledRaw = config.sessions?.[fieldEnabled];
  const globalEnabled =
    typeof globalEnabledRaw === "boolean" ? globalEnabledRaw : globalDefault;

  // Precedence: cron job > employee > global > kind-default.
  // Applies uniformly to both recoverable kinds (rate_limited, usage_cap).
  const empEnabled = employee?.[fieldEnabled];
  const jobEnabled = cronJob?.[fieldEnabled];

  let enabled = globalEnabled;
  if (typeof empEnabled === "boolean") enabled = empEnabled;
  if (typeof jobEnabled === "boolean") enabled = jobEnabled;

  const nudge =
    cronJob?.autoResumeNudge ??
    employee?.autoResumeNudge ??
    config.sessions?.autoResumeNudge ??
    DEFAULT_NUDGE;

  return { enabled, nudge };
}

/**
 * Enqueue an auto-resume to fire at the given time. Idempotent on sessionId:
 * re-scheduling cancels the previous pending row (handled by enqueueAutoResume).
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
  emit("session:auto_resume_scheduled", {
    sessionId: opts.sessionId,
    fireAt: opts.fireAt.toISOString(),
  });
}

/** Cancel a pending auto-resume for a session, if any. */
export function cancelScheduledAutoResume(sessionId: string): void {
  cancelAutoResume(sessionId);
  logger.info(`[autoResumer] cancelled session=${sessionId}`);
  emit("session:auto_resume_cancelled", { sessionId });
}

/** Inject the dispatch function. Called by gateway/server.ts at boot. */
export function setAutoResumeDispatcher(
  fn: (sessionId: string, nudge: string) => Promise<void>,
): void {
  dispatchFn = fn;
}

/** Read-only accessor for the registered dispatcher. */
export function getAutoResumeDispatcher():
  | ((sessionId: string, nudge: string) => Promise<void>)
  | null {
  return dispatchFn;
}

/** Start the periodic tick. Idempotent. Runs an immediate tick on boot. */
export function startAutoResumer(): void {
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    if (tickInFlight) {
      logger.debug("[autoResumer] previous tick still in-flight, skipping");
      return;
    }
    tickInFlight = true;
    tick()
      .catch((err) => {
        logger.error(
          `[autoResumer] tick error: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        tickInFlight = false;
      });
  }, TICK_MS);
  // Replay-on-boot: catch any rows that came due while gateway was down.
  tickInFlight = true;
  tick()
    .catch((err) => {
      logger.error(
        `[autoResumer] boot tick error: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      tickInFlight = false;
    });
}

/** Run one tick immediately. Exposed for tests. */
export async function runOneTickForTest(): Promise<void> {
  await tick();
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
  const due = listPendingAutoResumes().filter(
    (row) => Date.parse(row.fireAt) <= now,
  );

  for (const row of due) {
    const session = getSession(row.sessionId);
    if (!session) {
      // Session deleted — drop the row.
      deleteAutoResume(row.id);
      continue;
    }
    if (session.status === "running") {
      // Someone else resumed manually. Drop without firing.
      deleteAutoResume(row.id);
      continue;
    }
    try {
      logger.info(
        `[autoResumer] firing session=${row.sessionId} nudge="${row.nudge.slice(0, 40)}"`,
      );
      emit("session:auto_resume_firing", { sessionId: row.sessionId });
      await dispatchFn(row.sessionId, row.nudge);
      emit("session:auto_resume_succeeded", { sessionId: row.sessionId });

      // Notify parent session for cron-spawned children
      if (session.parentSessionId) {
        try {
          const { notifyRateLimitResumed } = await import("./callbacks.js");
          notifyRateLimitResumed(session);
        } catch (err) {
          logger.warn(
            `[autoResumer] notifyRateLimitResumed failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      deleteAutoResume(row.id);
    } catch (err) {
      logger.error(
        `[autoResumer] dispatch failed session=${row.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Drop the row — reclassification of a future error will re-schedule.
      deleteAutoResume(row.id);
    }
  }
}

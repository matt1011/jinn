# Error State Disambiguation and Session Resume — Design Spec

## Overview

Jinn currently lands every engine failure in a single freeform `error` status with a raw `lastError` string. Users (and Claude, via MCP) can't distinguish a transient rate limit from an exhausted usage quota from a stale engine thread from a crashed process. The existing `POST /api/sessions/:id/reset` clears state but nukes `engineSessionId`, so it's not a real thread resume.

This spec introduces:

1. A **5-kind error taxonomy** with structured session fields.
2. A **detection layer** that classifies engine failures by pattern + exit signal and extracts provider-reported retry timestamps with a +2-minute buffer.
3. An **auto-resume scheduler** that always auto-resumes `rate_limited` sessions, and opts in to auto-resume `usage_cap` sessions per a global → employee → cron-job precedence.
4. A **reset-times table** of provider defaults for fallback when the provider's error message doesn't include a timestamp, with `config.yaml` overrides.
5. A **resume API** (`POST /api/sessions/:id/resume`) that preserves `engineSessionId` and dispatches an optional custom nudge as the next message.
6. A **modal-based GUI** triggered by an error-kind chip in the session header, plus surfacing on the cron page and sessions list.
7. **MCP tools** so Claude (or any external caller) can list recoverable sessions and resume them with a nudge.

## Goals

- A session in a recoverable error state can be identified at a glance and resumed in one click.
- Rate-limited sessions auto-resume without intervention.
- Usage-capped cron jobs (the dominant overnight-failure mode in real use) auto-resume with `"keep going"` after the provider's reset time when opted in.
- All resume actions preserve the engine thread so codex/claude pick up with full conversation context.

## Non-Goals

- Auto-recovering from `dead_session`, `engine_crashed`, or `unknown` errors — these always require human action.
- Replacing the existing claude→codex rate-limit fallback strategy. That stays and is orthogonal.
- Classifying novel error strings beyond the 5 documented kinds. `unknown` is acceptable.
- A general retry-with-exponential-backoff framework. Auto-resume fires exactly once per scheduled timer; subsequent failures classify normally.

## Architecture

```
packages/jimmy/src/
  shared/
    rateLimit.ts                — classifyError(), extractRetryAfter(), PROVIDER_RESET_DEFAULTS
    types.ts                    — Session.errorKind, errorRecoverable, errorRetryAfter, errorDetectedFrom
                                  CronJob.autoResumeOnUsageCap, autoResumeNudge
                                  Employee.autoResumeOnUsageCap, autoResumeNudge
                                  JinnConfig.sessions.autoResumeOnUsageCap, autoResumeNudge
                                  JinnConfig.engines.*.resetWindow
  sessions/
    autoResumer.ts              — schedule/cancel/persist auto-resume timers (new)
    manager.ts                  — call classifyError() on every error transition; schedule auto-resume
    registry.ts                 — new columns: error_kind, error_recoverable, error_retry_after, error_detected_from
  gateway/
    api.ts                      — POST /api/sessions/:id/resume; GET /api/sessions/recoverable
  mcp/
    gateway-server.ts           — jinn_list_recoverable_sessions, jinn_resume_session, jinn_get_session_error

packages/web/src/
  components/sessions/
    session-detail.tsx          — error-kind chip in header; resume modal
    session-list.tsx            — error-kind badges; "Recoverable errors only" filter chip
    resume-modal.tsx            — new component: error details + nudge input + Resume now / Cancel auto-resume
  components/crons/
    pipeline-graph.tsx          — last-run status indicator with auto-resume countdown
  lib/
    api.ts                      — resumeSession(id, body), listRecoverableSessions()
```

## Error Taxonomy

Five kinds. Each kind carries a `recoverable: boolean` derived from the kind itself (not stored).

| Kind | Recoverable | Description | Detection signal |
|---|---|---|---|
| `rate_limited` | true | Short-term throttle (provider 429, "rate limit", "overloaded"). Reset typically minutes. | `RATE_LIMIT_RE` matches `result.error`; or `result.rateLimit?.status === "rejected"`. |
| `usage_cap` | true (opt-in) | Provider quota exhausted (Codex "hit your usage limit", Claude Max cap). Reset typically hours. | `USAGE_CAP_RE` matches `result.error` and not rate-limit. |
| `dead_session` | false | `engineSessionId` is stale; resume call would fail. | `isDeadSessionError(result)` (existing logic). |
| `engine_crashed` | false | Process exited non-zero with no recognized error signal. | Non-zero exit AND no rate-limit AND no usage-cap AND not dead-session. |
| `unknown` | false | Default fallthrough. | Anything not matched above. |

### Detection Module — `shared/rateLimit.ts` additions

```typescript
export type ErrorKind = "rate_limited" | "usage_cap" | "dead_session" | "engine_crashed" | "unknown";

export interface ErrorClassification {
  kind: ErrorKind;
  recoverable: boolean;
  retryAfter: Date | null;        // already includes +2 min buffer
  originalMessage: string;
  detectedFrom: "engine_result" | "process_exit" | "manual";
}

export function classifyError(
  result: EngineResult,
  engineName: string,
  config: JinnConfig
): ErrorClassification;

export function extractRetryAfter(
  errorText: string,
  kind: ErrorKind,
  engineName: string,
  config: JinnConfig
): Date | null;
```

Implementation details:

- `RATE_LIMIT_RE` (existing): `/rate.?limit|too many requests|429|overloaded|out of extra usage/i`. Keeps current coverage minus the `usage.*limit` clause, which moves to USAGE_CAP_RE to disambiguate.
- `USAGE_CAP_RE` (new): `/usage.*limit|hit your.*limit|credits.*exhausted|quota.*exhausted|compact task.*usage/i`. The "compact task" phrasing comes from real Codex error messages observed in production logs.
- `extractRetryAfter` parses:
  1. ISO-8601 timestamps in the error text.
  2. Provider phrasing: `try again at 7:10 AM` (Codex), `resets at <time>` (Claude). Disambiguates local vs UTC by assuming local (provider speaks user-local time).
  3. HTTP `Retry-After` header if present in `result.rateLimit`.
  4. Falls back to `PROVIDER_RESET_DEFAULTS[engineName][kind]` (overridable via `config.engines.<name>.resetWindow`).
- After computing a candidate `Date`, **always add 2 minutes** (`BUFFER_MS = 2 * 60_000`) before returning. Single source of truth for the buffer.
- If the computed date is in the past (clock skew, ambiguous AM/PM), bump to `now + max(buffer, 5 minutes)` and log a warning.

### Provider Reset Defaults

```typescript
const PROVIDER_RESET_DEFAULTS: Record<string, Partial<Record<ErrorKind, { fallbackMinutes: number }>>> = {
  claude: {
    rate_limited: { fallbackMinutes: 5 },
    usage_cap:    { fallbackMinutes: 300 },   // 5h rolling window (Max plan)
  },
  codex: {
    rate_limited: { fallbackMinutes: 1 },
    usage_cap:    { fallbackMinutes: 60 },    // conservative; usually provider message gives explicit time
  },
  gemini: {
    rate_limited: { fallbackMinutes: 5 },
    usage_cap:    { fallbackMinutes: 60 },
  },
};
```

Override in `~/.jinn/config.yaml`:

```yaml
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

Resolution order at lookup time: provider message timestamp > config override > hardcoded default. All paths add the +2 min buffer.

## Session State Additions

### Type changes — `shared/types.ts`

```typescript
interface Session {
  // ... existing fields ...
  status: "idle" | "running" | "error" | "waiting" | "interrupted";   // unchanged
  lastError: string | null;                                            // unchanged

  // NEW (all optional, populated when status === "error" or "waiting"):
  errorKind?: ErrorKind;
  errorRecoverable?: boolean;          // denormalized for indexed lookup; always equals
                                       // RECOVERABLE_KINDS.has(errorKind). Source of truth is errorKind.
  errorRetryAfter?: string | null;     // ISO-8601, already includes +2 min buffer
  errorDetectedFrom?: "engine_result" | "process_exit" | "manual";
}

interface CronJob {
  // ... existing fields ...
  autoResumeOnUsageCap?: boolean;                                      // NEW
  autoResumeNudge?: string;                                            // NEW, defaults to "keep going"
}

interface Employee {
  // ... existing fields ...
  autoResumeOnUsageCap?: boolean;                                      // NEW
  autoResumeNudge?: string;                                            // NEW
}

interface JinnConfig {
  sessions?: {
    // ... existing fields ...
    autoResumeOnRateLimit?: boolean;                                   // NEW, default true
    autoResumeOnUsageCap?: boolean;                                    // NEW, default false
    autoResumeNudge?: string;                                          // NEW, default "keep going"
  };
  engines: {
    [engineName: string]: {
      // ... existing fields ...
      resetWindow?: {
        rate_limited_min?: number;
        usage_cap_min?: number;
      };
    };
  };
}
```

### SQLite migration — `sessions/registry.ts`

Use the existing in-code idempotent migration pattern. `registry.ts` already exposes `migrateSessionsSchema(db)` which inspects `PRAGMA table_info(sessions)` and applies `ALTER TABLE ADD COLUMN` for any column missing from a hardcoded list. Extend that list with the four new columns:

```typescript
const missingColumns: Array<[string, string, string?]> = [
  // ... existing entries (title, parent_session_id, connector, session_key, ...) ...
  ['error_kind', 'TEXT'],
  ['error_recoverable', 'INTEGER'],
  ['error_retry_after', 'TEXT'],
  ['error_detected_from', 'TEXT'],
];
```

For the new `auto_resume_queue` table, add a `CREATE TABLE IF NOT EXISTS` block alongside the existing ones (the same pattern used for `queue_items`, `goals`, `budget_events`). No version-folder SQL files; the schema is owned by `registry.ts` and re-applied on every gateway start (idempotent).

Jinn's separate `jinn migrate` CLI (in `cli/migrate.ts`) is for migrating user-data files (CLAUDE.md, skills, etc.) at release boundaries, not SQLite schema — that distinction is intentional and we keep it.

## Auto-Resume Scheduler

New module: `sessions/autoResumer.ts`.

### Responsibilities

1. When a session transitions to `error` with `errorRecoverable: true`, **resolve the opt-in** for this kind+session.
2. If opted in and `errorRetryAfter` is set, **schedule a timer** to fire at that time.
3. When the timer fires, **dispatch a message** with the configured nudge through the existing message-dispatch path. The session resumes with `engineSessionId` preserved.
4. **Persist scheduled resumes** to disk so a gateway restart doesn't lose them.
5. **Cancel** scheduled resumes if the user manually resumes or resets the session.

### Opt-in resolution (precedence: most specific wins)

```
For cron-originated sessions:
  autoResume = cronJob.autoResumeOnUsageCap
            ?? employee.autoResumeOnUsageCap
            ?? config.sessions.autoResumeOnUsageCap
            ?? false   // global default for usage_cap

For interactive sessions:
  autoResume = employee.autoResumeOnUsageCap
            ?? config.sessions.autoResumeOnUsageCap
            ?? false

For rate_limited (any session):
  autoResume = employee.autoResumeOnRateLimit
            ?? config.sessions.autoResumeOnRateLimit
            ?? true    // global default for rate_limited

Nudge string resolution: same precedence, default "keep going".
```

### Persistence

A scheduled resume is persisted as a row in a new SQLite table `auto_resume_queue`:

```sql
CREATE TABLE auto_resume_queue (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  fire_at TEXT NOT NULL,             -- ISO-8601
  nudge TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cancelled_at TEXT
);
CREATE INDEX idx_auto_resume_queue_fire_at ON auto_resume_queue(fire_at) WHERE cancelled_at IS NULL;
```

On gateway startup:
- `replayPendingResumes()` reads all rows with `cancelled_at IS NULL` and `fire_at > now`, schedules a timer for each.
- For rows where `fire_at <= now` (gateway was down past the reset), fire immediately.

### Timer implementation

- `setTimeout(handler, delayMs)` for delays ≤ 24h.
- For longer delays, use a polling approach (`setInterval` every minute) to avoid the 32-bit timeout overflow.
- A single shared interval (`resumerTick`) wakes every 30s and fires any due rows. Simpler than per-row timers; resilient to overflow.

### Notifications

On schedule: emit a `session:auto_resume_scheduled` event (consumed by web socket → UI).
On fire (before dispatch): emit `session:auto_resume_firing`.
On success: emit `session:auto_resume_succeeded` and call existing `notifyRateLimitResumed` callback for cron parents.
On dispatch failure (still capped, network error, etc.): re-classify, log, and skip — do not infinitely retry.

## Resume API

### `POST /api/sessions/:id/resume`

Body:
```json
{
  "nudge": "keep going",              // optional; defaults to configured nudge or "keep going"
  "preserveEngineSession": true       // optional, default true
}
```

Behavior:
1. 404 if session does not exist.
2. 409 if session status is `running` or `idle` (nothing to resume).
3. Valid input states: `error`, `waiting`, `interrupted`.
4. Clear `lastError`, `errorKind`, `errorRecoverable`, `errorRetryAfter`, `errorDetectedFrom`.
5. Cancel any pending auto-resume timer for this session (`auto_resume_queue.cancelled_at = now`).
6. If `preserveEngineSession: false`, also clear `engineSessionId` (matches old `/reset` behavior).
7. Dispatch the nudge as the next message via the existing `dispatchWebSessionRun` path. The codex/claude engine then resumes the thread.
8. Returns the updated session JSON.

### `GET /api/sessions/recoverable`

Returns sessions with `status === "error"` AND `errorRecoverable === true`, plus minimal metadata for the dashboard list and MCP tool. Lightweight (no message payload, no full conversation).

### `POST /api/sessions/:id/reset` (existing)

Unchanged. Documentation updated to note that `resume` is the new preferred path for recoverable errors; `reset` remains for stuck or terminal states where `engineSessionId` should also be cleared.

## MCP Exposure

Three new tools in `packages/jimmy/src/mcp/gateway-server.ts`. Local-only authentication (matches existing MCP tools).

### `jinn_list_recoverable_sessions`

```
Description: List Jinn sessions currently in a recoverable error state.
Returns: array of { sessionId, title, engine, employee, errorKind, errorRetryAfter, autoResumeScheduled, lastError (truncated) }
```

### `jinn_get_session_error`

```
Input: { sessionId: string }
Description: Return structured error details for a session.
Returns: { sessionId, status, errorKind, errorRecoverable, errorRetryAfter, errorDetectedFrom, lastError, autoResumeScheduledAt, autoResumeNudge }
```

### `jinn_resume_session`

```
Input: { sessionId: string, nudge?: string }
Description: Resume a recoverable session with an optional custom nudge.
Returns: { sessionId, status, dispatched: true } or error.
```

These tools expose the resume API to Claude Code instances connected via Jinn's MCP server. Claude can poll for recoverable sessions and nudge them autonomously where appropriate.

## GUI

### Session detail — error-kind chip + modal (Layout B from brainstorm)

`packages/web/src/components/sessions/session-detail.tsx`:

- Session header gains an error-kind chip when `errorKind` is present: orange background, label like `⚠ USAGE_CAP`, `⚠ RATE_LIMITED`, etc.
- Click chip → opens `<ResumeModal />`.

`packages/web/src/components/sessions/resume-modal.tsx` (new):

- Header: kind badge + plain-English description ("Codex usage cap — the provider quota has been hit").
- Body:
  - Original provider message (the `lastError` text, monospace).
  - Auto-resume status:
    - "Auto-resume scheduled for 2026-05-12 07:12 ET (in 2h 41m)" with live countdown
    - OR "Auto-resume is OFF for this session's config. Resume manually below."
  - Editable nudge textarea, defaults to the resolved `autoResumeNudge` for this session.
- Footer buttons:
  - **Resume now** — POSTs to `/api/sessions/:id/resume` with the (possibly edited) nudge, cancels any pending auto-resume.
  - **Cancel auto-resume** — POSTs `cancelled_at` on the queue row, leaves session in error state. Hidden if auto-resume isn't scheduled.
  - **Close** — dismisses modal.

### Sessions list — badges and filter

`packages/web/src/components/sessions/session-list.tsx`:

- Each row in error state shows a small chip with `errorKind`.
- A new filter chip "Recoverable errors only" filters the list to sessions with `errorRecoverable === true`. Persists in localStorage.

### Cron page — last-run indicator

`packages/web/src/components/crons/pipeline-graph.tsx`:

- Each cron's "last run" cell shows one of:
  - `✅ OK · 86m` (success, duration)
  - `⏳ BLOCKED (USAGE_CAP) · auto-resume in 2h 41m` (recoverable, scheduled)
  - `⚠ BLOCKED (USAGE_CAP) · manual resume required` (recoverable, no auto-resume)
  - `❌ ERROR (CRASHED) · investigate` (terminal)
- Clicking the indicator routes to the underlying session detail with the resume modal auto-opened.

### Hooks — `packages/web/src/lib/api.ts`

```typescript
export async function resumeSession(id: string, body: { nudge?: string; preserveEngineSession?: boolean }): Promise<Session>;
export async function listRecoverableSessions(): Promise<RecoverableSessionSummary[]>;
export async function cancelAutoResume(sessionId: string): Promise<void>;
```

Live countdown in the modal uses a simple `setInterval` ticking every second against the `errorRetryAfter` timestamp. No websocket push needed — local clock arithmetic.

## Configuration

Example `~/.jinn/config.yaml` after this change:

```yaml
sessions:
  autoResumeOnRateLimit: true     # default true
  autoResumeOnUsageCap: false     # default false (opt-in)
  autoResumeNudge: "keep going"   # global default

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

Example cron job opting into usage-cap auto-resume:

```json
{
  "id": "whisper-ops-transcription-hardening-spec-implementation",
  "autoResumeOnUsageCap": true,
  "autoResumeNudge": "keep going from the status note checkpoint"
}
```

Example employee:

```yaml
name: codex-engineer
autoResumeOnUsageCap: true
autoResumeNudge: "keep going"
```

## Testing Strategy

### Unit — `shared/__tests__/classifyError.test.ts`

For each error kind, assert classification on real-world error strings collected from production logs:

- Codex: `"Error running remote compact task: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 7:10 AM."` → `usage_cap`, `retryAfter` parses to 07:10 local + 2 min buffer.
- Claude: HTTP 429 with `Retry-After: 300` header → `rate_limited`, `retryAfter = now + 300s + 2min`.
- Dead session: codex exit with zero work done → `dead_session`.
- Engine crash: non-zero exit, no recognized signal → `engine_crashed`.
- Default fallthrough: arbitrary string → `unknown`.

### Unit — `shared/__tests__/extractRetryAfter.test.ts`

- "try again at 7:10 AM" with current time 04:28 → 07:12 (07:10 + 2 min buffer).
- "try again at 7:10 AM" with current time 08:00 (past) → bumps to now + max(buffer, 5 min).
- ISO-8601 in error text → parsed + 2 min buffer.
- No timestamp → returns null OR falls through to `PROVIDER_RESET_DEFAULTS` lookup.
- `config.engines.codex.resetWindow.usage_cap_min: 90` → override beats hardcoded default.

### Integration — `sessions/__tests__/autoResume.test.ts`

- Engine returns rate-limit error → session transitions to error with `errorKind: rate_limited` → row appears in `auto_resume_queue` → fast-forward timer → mock dispatch called with "keep going" → session re-runs.
- Engine returns usage-cap error AND cron job has `autoResumeOnUsageCap: true` → scheduled.
- Same scenario but job NOT opted in → not scheduled. Manual resume via POST resumes correctly.
- Manual resume cancels scheduled timer.
- Gateway restart: pending row in `auto_resume_queue` is rescheduled on startup.

### E2E (Playwright) — `e2e/error-resume.spec.ts`

- Mock-engine session enters usage-cap state → chip visible in session header → click opens modal → countdown counts down → "Resume now" clicked → POST to `/api/sessions/:id/resume` observed → modal closes → session shows "running."

### MCP — `mcp/__tests__/gateway-server.test.ts`

- `jinn_list_recoverable_sessions` returns expected shape with seeded recoverable session.
- `jinn_resume_session(id, nudge)` triggers dispatch.
- `jinn_get_session_error(id)` returns structured fields.

## Migration / Backward Compatibility

- All new `Session` fields are optional. Existing API responses are unchanged for clients that don't read them.
- Existing `POST /api/sessions/:id/reset` is unchanged. The new `POST /api/sessions/:id/resume` is purely additive.
- Existing `notifyRateLimited` / `notifyRateLimitResumed` callbacks fire unchanged. They co-exist with the new auto-resume scheduler (which uses them under the hood for the rate-limited path).
- Pre-existing `error`-state sessions in the DB without `errorKind` populated: on first read after upgrade, `classifyError(session.lastError)` is invoked lazily and the result is written back to the row. No bulk migration script.
- SQLite migration adds nullable columns + creates `auto_resume_queue` table. Safe to roll forward; rollback drops the table (rare).
- Config keys default to existing behavior when omitted (see Interaction With `rateLimitStrategy` below for the one subtle case).

## Interaction With Existing `rateLimitStrategy`

The current `JinnConfig.sessions.rateLimitStrategy` is Claude-specific and governs the Claude→Codex fallback. The new auto-resume scheduler layers underneath it. Resolution order on a Claude rate-limit:

1. If `rateLimitStrategy === "fallback"` (default) AND the fallback engine is available: do the existing fallback (codex takes over). No auto-resume scheduled — the session is already running on the fallback engine.
2. If `rateLimitStrategy === "wait"` OR fallback was attempted and itself errored: the session transitions to `error` with `errorKind: rate_limited`. Auto-resume scheduler then schedules a resume at `errorRetryAfter` per the precedence rules.

For Codex (and Gemini) rate-limits there is no fallback path — auto-resume is the only recovery mechanism. The scheduler engages directly per precedence rules. This is the practically-important case for cron jobs.

For `usage_cap` (both engines), `rateLimitStrategy` is not consulted — auto-resume scheduler is the only recovery path, gated by the opt-in precedence chain.

## Risks

- **False classification.** A regex-based detector misclassifies an error kind, leading to inappropriate auto-resume. Mitigation: conservative `USAGE_CAP_RE`; comprehensive unit tests against real-world error strings; `unknown` is the safe fallthrough and never auto-resumes.
- **Clock skew on retry-after parsing.** Provider says "7:10 AM" in user-local; if the user's clock or timezone is wrong, the resume fires at the wrong moment. Mitigation: parse defensively; reject past times and bump to `now + max(buffer, 5 min)`; log warnings.
- **Stuck auto-resume loops.** If the resume itself errors with the same kind, we could enter a loop. Mitigation: auto-resume fires exactly once per scheduled timer. Subsequent failures classify normally and schedule a new timer based on the new retry-after — natural exponential-ish backoff because each subsequent provider window is independent.
- **Engine thread expiry mid-wait.** A long usage-cap wait (hours) might outlive the engine's session retention. Mitigation: on resume dispatch, if the engine returns `dead_session`, reclassify and surface to user; don't silently start over.
- **Persistence races.** If gateway restarts between scheduling and firing, queue rows could fire out of order. Mitigation: replay is idempotent (queue rows have `cancelled_at`; dispatched rows are deleted only after dispatch succeeds — at-least-once delivery).

## Decisions Considered And Rejected

These came up during design and are documented so future readers can see the reasoning:

- **Per-context nudge defaults (cron vs interactive).** Rejected — same precedence resolution; override per cron job when needed. Adding context-typed defaults would multiply the resolution rules without clear benefit.
- **Allowlisting `jinn_resume_session` to certain error kinds.** Rejected — trust the caller. Claude can resume anything in `error`/`waiting`/`interrupted` state. Safety lives in the human-approved cron prompts and the local-only MCP boundary, not in tool-level guards.
- **Slack/Discord notification on successful auto-resume.** Deferred — existing `notifyRateLimitResumed` callback covers parent-session notifications. Broader connector fan-out can land later if real demand surfaces.
- **Exponential backoff / retry budgets.** Rejected for v1 — auto-resume fires exactly once per scheduled timer. If the resumed run hits the cap again, it reclassifies and schedules a fresh timer based on the new retry-after. Each provider window is independent, which gives natural separation without a budget abstraction.

## Out of Scope

- Provider auth / billing UI.
- Multi-step auto-recovery for `dead_session` (start fresh with a regenerated prompt). Manual reset is the path.
- Auto-recovery for `engine_crashed`. Always manual.
- Per-error-kind retry budgets (e.g. "auto-resume at most 3 times in 24h"). Single-fire semantics keep this simple.

"use client";
import { useEffect, useState } from "react";

const NON_RECOVERABLE_KINDS = new Set(["dead_session", "engine_crashed", "unknown"]);

function fmtDuration(ms: number): string {
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
    return <span style={{ color: "#16a34a", fontSize: 11 }}>✅ OK · {fmtDuration(durationMs)}</span>;
  }
  if (errorKind && !NON_RECOVERABLE_KINDS.has(errorKind)) {
    if (autoResumeScheduledAt) {
      return (
        <span style={{ color: "#d97706", fontSize: 11 }}>
          ⏳ BLOCKED ({errorKind.replace("_", " ").toUpperCase()}) · auto-resume in {countdown ?? "—"}
        </span>
      );
    }
    return (
      <span style={{ color: "#d97706", fontSize: 11 }}>
        ⚠ BLOCKED ({errorKind.replace("_", " ").toUpperCase()}) · manual resume required
      </span>
    );
  }
  return (
    <span style={{ color: "#dc2626", fontSize: 11 }}>
      ❌ ERROR{errorKind ? ` (${errorKind.replace("_", " ").toUpperCase()})` : ""} · investigate
    </span>
  );
}

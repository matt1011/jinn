"use client";

import { useEffect, useMemo, useState } from "react";
import { useResumeSession, useCancelAutoResume } from "@/hooks/use-sessions";

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
  const description = useMemo(() => KIND_DESCRIPTIONS[errorKind] ?? KIND_DESCRIPTIONS.unknown, [errorKind]);

  const handleResume = () => {
    resume.mutate({ id: sessionId, nudge }, { onSuccess: onClose });
  };

  const handleCancelAuto = () => {
    cancel.mutate(sessionId);
  };

  // Use a lightweight self-rendered overlay rather than depending on
  // a specific dialog primitive shape. This makes the component testable
  // without a portal mock and keeps it portable across UI libraries.
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "var(--bg-primary, #fff)",
          color: "var(--text-primary, #000)",
          border: "1px solid var(--border, #ccc)",
          borderRadius: 8,
          padding: 20,
          width: 480,
          maxWidth: "90vw",
          maxHeight: "90vh",
          overflow: "auto",
        }}
      >
        <div style={{ marginBottom: 12 }}>
          <span
            style={{
              display: "inline-block",
              padding: "2px 8px",
              borderRadius: 10,
              background: "#d97706",
              color: "#fff",
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              marginRight: 8,
            }}
          >
            {errorKind.replace("_", " ")}
          </span>
          <strong>Resume session</strong>
        </div>

        <p style={{ fontSize: 13, opacity: 0.8, marginBottom: 12 }}>{description}</p>

        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>Provider message</div>
        <pre style={{
          fontSize: 11,
          fontFamily: "monospace",
          whiteSpace: "pre-wrap",
          padding: 8,
          background: "var(--bg-secondary, rgba(0,0,0,0.05))",
          borderRadius: 4,
          marginBottom: 12,
          maxHeight: 120,
          overflow: "auto",
        }}>{lastError}</pre>

        {autoResumeScheduledAt ? (
          <div style={{ fontSize: 12, marginBottom: 12 }}>
            Auto-resume scheduled: <strong>{new Date(autoResumeScheduledAt).toLocaleString()}</strong>
            {countdown ? <> · in <span style={{ fontFamily: "monospace" }}>{countdown}</span></> : null}
          </div>
        ) : errorRetryAfter ? (
          <div style={{ fontSize: 12, marginBottom: 12, opacity: 0.7 }}>
            Provider retry-at: {new Date(errorRetryAfter).toLocaleString()}
            {countdown ? <> · in <span style={{ fontFamily: "monospace" }}>{countdown}</span></> : null}
            <div style={{ marginTop: 4, fontSize: 11 }}>Auto-resume is OFF for this session's config. Resume manually below.</div>
          </div>
        ) : null}

        <label style={{ display: "block", fontSize: 11, opacity: 0.6, marginBottom: 4 }}>
          Nudge (sent on resume)
        </label>
        <textarea
          value={nudge}
          onChange={(e) => setNudge(e.target.value)}
          rows={3}
          style={{
            width: "100%",
            padding: 8,
            fontSize: 13,
            border: "1px solid var(--border, #ccc)",
            borderRadius: 4,
            marginBottom: 12,
            fontFamily: "inherit",
          }}
        />

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          {autoResumeScheduledAt ? (
            <button onClick={handleCancelAuto} disabled={cancel.isPending}
              style={{ padding: "6px 12px", border: "1px solid var(--border, #ccc)", borderRadius: 4, background: "transparent", cursor: "pointer" }}>
              Cancel auto-resume
            </button>
          ) : null}
          <button onClick={onClose}
            style={{ padding: "6px 12px", border: "1px solid var(--border, #ccc)", borderRadius: 4, background: "transparent", cursor: "pointer" }}>
            Close
          </button>
          <button onClick={handleResume} disabled={resume.isPending}
            style={{ padding: "6px 12px", border: "none", borderRadius: 4, background: "#1e40af", color: "#fff", cursor: "pointer" }}>
            Resume now
          </button>
        </div>
      </div>
    </div>
  );
}
